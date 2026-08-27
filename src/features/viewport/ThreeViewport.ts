import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  acceleratedRaycast,
  computeBoundsTree,
  disposeBoundsTree,
} from "three-mesh-bvh";
import { SelectionMask, type MaskPaintSample } from "../mask/SelectionMask";
import type {
  BrushSettings,
  LightingSettings,
  MaskSummary,
  MaterialChannel,
  PbrMaterialSettings,
  SurfaceHitSummary,
  ToolMode,
} from "../../types/editor";
import { SelectionOverlay } from "./SelectionOverlay";

// Install the library's Three.js-compatible extension points once for this
// application. acceleratedRaycast automatically falls back to Three.js when a
// geometry has no BVH, which keeps unsupported/deforming meshes functional.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

interface ThreeViewportCallbacks {
  onSurfaceHit: (surface: SurfaceHitSummary | null) => void;
  onMaskChanged: (mask: MaskSummary | null) => void;
}

interface PickedSurface {
  summary: SurfaceHitSummary;
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  uv: THREE.Vector2;
}

interface MaskRecord {
  mask: SelectionMask;
  materialName: string;
}

interface ActiveStroke {
  pointerId: number;
  textureSetId: string;
  mask: SelectionMask;
  materialName: string;
  /** Last point already converted to UV samples by the render loop. */
  lastProcessedPoint: THREE.Vector2 | null;
  /** Latest input point; intermediate pointer events are intentionally merged. */
  pendingPoint: THREE.Vector2;
  hasPendingPoint: boolean;
  /** Samples are replayed into the full-resolution mask only on pointer-up. */
  sourceSamples: MaskPaintSample[];
  /** Avoids encoding the sidebar PNG on every frame of a stroke. */
  hasPublishedPreviewSummary: boolean;
}

const DEFAULT_MASK_SIZE = 2048;

/**
 * Owns the imperative Three.js viewport and screen-space brush projection.
 *
 * The brush is sampled in screen space to preserve a Substance Painter-like
 * circular cursor. Each sample is raycast independently and written into the
 * UV mask belonging to the material locked at pointer-down time.
 */
export class ThreeViewport {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(42, 1, 0.01, 2000);
  private readonly renderer: THREE.WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly contentRoot = new THREE.Group();
  private readonly grid = new THREE.GridHelper(20, 40, 0x39414c, 0x272c34);
  private readonly environmentLight = new THREE.HemisphereLight(0xddeeff, 0x20242c, 1.55);
  private readonly directionalLight = new THREE.DirectionalLight(0xffffff, 3.2);
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly resizeObserver: ResizeObserver;
  private readonly brushCursor = document.createElement("div");
  private readonly masks = new Map<string, MaskRecord>();
  private readonly overlays = new Map<string, SelectionOverlay>();
  private readonly materials = new Map<string, THREE.MeshStandardMaterial>();
  private readonly importedTextures = new Map<string, THREE.Texture>();
  /** Flat raycast targets avoid recursively walking the scene for every sample. */
  private readonly paintableMeshes: THREE.Mesh[] = [];
  /** Three.js supports a caller-owned target array, so reuse it per raycast. */
  private readonly intersectionBuffer: THREE.Intersection[] = [];

  private animationFrame = 0;
  private pointerStart = new THREE.Vector2();
  private toolMode: ToolMode = "orbit";
  private brushSettings: BrushSettings = {
    radiusPx: 36,
    hardness: 0.72,
    innerReferencePx: 4,
    outerReferencePx: 12,
  };
  private activeStroke: ActiveStroke | null = null;
  private activeMaskKey: string | null = null;

  constructor(
    private readonly host: HTMLDivElement,
    private readonly callbacks: ThreeViewportCallbacks,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // three-mesh-bvh can terminate each geometry traversal at its nearest hit.
    // intersectObjects still sorts the results from separate meshes globally.
    this.raycaster.firstHitOnly = true;
    this.renderer.domElement.tabIndex = 0;
    this.host.appendChild(this.renderer.domElement);

    this.brushCursor.className = "brush-cursor";
    this.host.appendChild(this.brushCursor);
    this.updateBrushCursorSize();

    this.camera.position.set(3.2, 2.2, 4.2);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.target.set(0, 0, 0);

    this.scene.background = new THREE.Color(0x15181d);
    this.scene.add(this.contentRoot);
    this.addLightingAndGrid();
    this.showDefaultAsset();

    this.renderer.domElement.addEventListener("pointerdown", this.handlePointerDown);
    this.renderer.domElement.addEventListener("pointermove", this.handlePointerMove);
    this.renderer.domElement.addEventListener("pointerup", this.handlePointerUp);
    this.renderer.domElement.addEventListener("pointercancel", this.handlePointerCancel);
    this.renderer.domElement.addEventListener("pointerleave", this.handlePointerLeave);
    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(this.host);
    this.resize();
    this.animate();
  }

  async loadGlb(buffer: ArrayBuffer): Promise<void> {
    const gltf = await new GLTFLoader().parseAsync(buffer, "");
    this.replaceContent(gltf.scene);
  }

  setToolMode(toolMode: ToolMode): void {
    this.toolMode = toolMode;
    this.controls.enabled = toolMode === "orbit";
    this.renderer.domElement.classList.toggle("is-brush-mode", toolMode === "brush");
    if (toolMode !== "brush") this.hideBrushCursor();
  }

  setBrushSettings(settings: BrushSettings): void {
    this.brushSettings = settings;
    this.updateBrushCursorSize();
    for (const overlay of this.overlays.values()) overlay.updateSettings(settings);
  }

  /** Applies inspector values to one material/texture set. */
  setPbrMaterialSettings(materialId: string | null, settings: PbrMaterialSettings): void {
    if (!materialId) return;
    const material = this.materials.get(materialId);
    if (!material) return;
    material.color.set(settings.baseColor);
    material.roughness = THREE.MathUtils.clamp(settings.roughness, 0, 1);
    material.metalness = THREE.MathUtils.clamp(settings.metallic, 0, 1);
    const normalScale = THREE.MathUtils.clamp(settings.normalScale, 0, 4);
    material.normalScale.set(normalScale, normalScale);
  }

  /** Updates the lightweight studio lighting used to inspect PBR response. */
  setLightingSettings(settings: LightingSettings): void {
    this.environmentLight.color.set(settings.environmentColor);
    this.environmentLight.intensity = THREE.MathUtils.clamp(settings.environmentIntensity, 0, 5);
    this.directionalLight.color.set(settings.directionalColor);
    this.directionalLight.intensity = THREE.MathUtils.clamp(settings.directionalIntensity, 0, 10);

    const azimuth = THREE.MathUtils.degToRad(settings.directionalAzimuthDeg);
    const elevation = THREE.MathUtils.degToRad(settings.directionalElevationDeg);
    const horizontal = Math.cos(elevation);
    this.directionalLight.position.set(
      Math.cos(azimuth) * horizontal,
      Math.sin(elevation),
      Math.sin(azimuth) * horizontal,
    ).multiplyScalar(6);
  }

  /** Loads one image map into one material without affecting other slots. */
  async importMaterialTexture(
    materialId: string,
    channel: MaterialChannel,
    file: File,
  ): Promise<void> {
    const material = this.materials.get(materialId);
    if (!material) throw new Error("The selected material is no longer available");

    const objectUrl = URL.createObjectURL(file);
    let texture: THREE.Texture;
    try {
      texture = await new THREE.TextureLoader().loadAsync(objectUrl);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }

    texture.name = file.name;
    // Match the UV orientation used by GLTFLoader for GLB material textures.
    texture.flipY = false;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    texture.colorSpace = channel === "baseColor" ? THREE.SRGBColorSpace : THREE.NoColorSpace;

    const slotKey = `${materialId}:${channel}`;
    this.importedTextures.get(slotKey)?.dispose();
    this.importedTextures.set(slotKey, texture);

    switch (channel) {
      case "baseColor": material.map = texture; break;
      case "normal": material.normalMap = texture; break;
      case "roughness": material.roughnessMap = texture; break;
      case "metallic": material.metalnessMap = texture; break;
    }
    material.needsUpdate = true;
  }

  clearActiveMask(): void {
    if (!this.activeMaskKey) return;
    const record = this.masks.get(this.activeMaskKey);
    if (!record) return;
    record.mask.clear();
    this.callbacks.onMaskChanged(this.toMaskSummary(record));
  }

  dispose(): void {
    cancelAnimationFrame(this.animationFrame);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener("pointerdown", this.handlePointerDown);
    this.renderer.domElement.removeEventListener("pointermove", this.handlePointerMove);
    this.renderer.domElement.removeEventListener("pointerup", this.handlePointerUp);
    this.renderer.domElement.removeEventListener("pointercancel", this.handlePointerCancel);
    this.renderer.domElement.removeEventListener("pointerleave", this.handlePointerLeave);
    this.controls.dispose();
    this.clearSelectionResources();
    this.disposeObject(this.contentRoot);
    this.importedTextures.clear();
    this.renderer.dispose();
    this.brushCursor.remove();
    this.renderer.domElement.remove();
  }

  private addLightingAndGrid(): void {
    this.scene.add(this.environmentLight);
    this.directionalLight.position.set(4, 6, 5);
    this.directionalLight.castShadow = true;
    this.scene.add(this.directionalLight, this.directionalLight.target);
    this.grid.position.y = -1.25;
    this.scene.add(this.grid);
  }

  private showDefaultAsset(): void {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(1, 96, 64),
      new THREE.MeshStandardMaterial({
        name: "Default Material",
        color: 0xaeb8c6,
        metalness: 0.05,
        roughness: 0.32,
      }),
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = "DefaultMaterialSphere";
    this.contentRoot.add(mesh);
    this.rebuildPaintableMeshCache();
  }

  private replaceContent(object: THREE.Object3D): void {
    this.clearSelectionResources();
    this.disposeObject(this.contentRoot);
    // Attached editor textures were disposed with the old materials above.
    this.importedTextures.clear();
    this.contentRoot.clear();
    this.contentRoot.add(object);
    object.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    this.rebuildPaintableMeshCache();

    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) throw new Error("GLB 中没有可显示的几何体");
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    object.position.sub(center);
    object.updateMatrixWorld(true);

    const radius = Math.max(size.x, size.y, size.z) * 0.5;
    this.grid.position.y = -size.y * 0.5;
    this.grid.scale.setScalar(Math.max(radius / 5, 0.1));
    const distance = Math.max(radius / Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5)), 1.5);
    this.camera.near = Math.max(distance / 1000, 0.001);
    this.camera.far = Math.max(distance * 100, 100);
    this.camera.updateProjectionMatrix();
    this.camera.position.set(distance * 0.9, distance * 0.55, distance * 1.15);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
    this.callbacks.onSurfaceHit(null);
    this.callbacks.onMaskChanged(null);
  }

  private readonly handlePointerDown = (event: PointerEvent) => {
    this.pointerStart.set(event.clientX, event.clientY);
    if (this.toolMode !== "brush" || event.button !== 0) return;

    const surface = this.pickSurface(event.clientX, event.clientY);
    if (!surface) {
      this.callbacks.onSurfaceHit(null);
      return;
    }

    event.preventDefault();
    this.renderer.domElement.setPointerCapture(event.pointerId);
    const record = this.ensureMask(surface);
    this.activeMaskKey = surface.summary.textureSetId;
    this.activeStroke = {
      pointerId: event.pointerId,
      textureSetId: surface.summary.textureSetId,
      mask: record.mask,
      materialName: record.materialName,
      lastProcessedPoint: null,
      pendingPoint: new THREE.Vector2(event.clientX, event.clientY),
      hasPendingPoint: true,
      sourceSamples: [],
      hasPublishedPreviewSummary: false,
    };
    this.callbacks.onSurfaceHit(surface.summary);
    // The render loop drains this initial point. Pointer handlers stay cheap
    // even when the OS emits input faster than the display refresh rate.
    this.callbacks.onMaskChanged(this.toMaskSummary(record));
  };

  private readonly handlePointerMove = (event: PointerEvent) => {
    this.updateBrushCursor(event.clientX, event.clientY);
    if (this.toolMode !== "brush" || !this.activeStroke) return;
    if (event.pointerId !== this.activeStroke.pointerId || (event.buttons & 1) === 0) return;

    event.preventDefault();
    this.activeStroke.pendingPoint.set(event.clientX, event.clientY);
    this.activeStroke.hasPendingPoint = true;
  };

  private readonly handlePointerUp = (event: PointerEvent) => {
    if (this.toolMode === "brush") {
      if (!this.activeStroke || event.pointerId !== this.activeStroke.pointerId) return;
      // Preserve the final pointer position even if pointer-up arrives before
      // the next animation frame has a chance to consume it.
      this.activeStroke.pendingPoint.set(event.clientX, event.clientY);
      this.activeStroke.hasPendingPoint = true;
      this.finishStroke(event.pointerId);
      return;
    }

    const movement = this.pointerStart.distanceTo(new THREE.Vector2(event.clientX, event.clientY));
    if (movement > 4 || event.button !== 0) return;
    const surface = this.pickSurface(event.clientX, event.clientY);
    this.callbacks.onSurfaceHit(surface?.summary ?? null);
    if (!surface) {
      this.callbacks.onMaskChanged(null);
      return;
    }
    this.activeMaskKey = surface.summary.textureSetId;
    const record = this.masks.get(surface.summary.textureSetId);
    this.callbacks.onMaskChanged(record ? this.toMaskSummary(record) : null);
  };

  private readonly handlePointerCancel = (event: PointerEvent) => {
    if (this.activeStroke?.pointerId === event.pointerId) this.finishStroke(event.pointerId);
  };

  private readonly handlePointerLeave = () => {
    if (!this.activeStroke) this.hideBrushCursor();
  };

  private finishStroke(pointerId: number): void {
    const stroke = this.activeStroke;
    if (!stroke) return;
    this.processPendingStroke();
    // The preview was updated incrementally; replay once into the source mask
    // to preserve full texture resolution without paying that cost per frame.
    stroke.mask.paintSource(stroke.sourceSamples);
    if (this.renderer.domElement.hasPointerCapture(pointerId)) {
      this.renderer.domElement.releasePointerCapture(pointerId);
    }
    const record = this.masks.get(stroke.textureSetId);
    this.activeStroke = null;
    if (record) this.callbacks.onMaskChanged(this.toMaskSummary(record));
  }

  /**
   * Converts at most the latest pointer position into one batched preview edit.
   * Called from the animation loop, this caps expensive raycast work to the
   * display frame rate while maintaining a continuous screen-space segment.
   */
  private processPendingStroke(): void {
    const stroke = this.activeStroke;
    if (!stroke?.hasPendingPoint) return;

    const end = stroke.pendingPoint;
    const frameSamples: MaskPaintSample[] = [];
    const canvasRect = this.renderer.domElement.getBoundingClientRect();
    if (stroke.lastProcessedPoint) {
      this.collectScreenSegmentSamples(
        stroke.lastProcessedPoint,
        end,
        stroke,
        canvasRect,
        frameSamples,
      );
    } else {
      this.collectScreenStampSamples(end.x, end.y, stroke, canvasRect, frameSamples);
    }

    stroke.lastProcessedPoint ??= new THREE.Vector2();
    stroke.lastProcessedPoint.copy(end);
    stroke.hasPendingPoint = false;
    if (frameSamples.length === 0) return;

    stroke.sourceSamples.push(...frameSamples);
    stroke.mask.paintPreview(frameSamples);
    if (!stroke.hasPublishedPreviewSummary) {
      const record = this.masks.get(stroke.textureSetId);
      if (record) this.callbacks.onMaskChanged(this.toMaskSummary(record));
      stroke.hasPublishedPreviewSummary = true;
    }
  }

  /** Interpolates in screen space, never directly between potentially split UVs. */
  private collectScreenSegmentSamples(
    start: THREE.Vector2,
    end: THREE.Vector2,
    stroke: ActiveStroke,
    canvasRect: DOMRect,
    target: MaskPaintSample[],
  ): void {
    const distance = start.distanceTo(end);
    const centerSpacing = Math.max(4, this.brushSettings.radiusPx * 0.22);
    const stepCount = Math.min(24, Math.max(1, Math.ceil(distance / centerSpacing)));

    for (let step = 1; step <= stepCount; step += 1) {
      const t = step / stepCount;
      this.collectScreenStampSamples(
        THREE.MathUtils.lerp(start.x, end.x, t),
        THREE.MathUtils.lerp(start.y, end.y, t),
        stroke,
        canvasRect,
        target,
      );
    }
  }

  /**
   * Projects a circular grid of screen samples onto the visible model surface.
   * Samples crossing another material are discarded, keeping one stroke bound
   * to the material selected at pointer-down time.
   */
  private collectScreenStampSamples(
    clientX: number,
    clientY: number,
    stroke: ActiveStroke,
    canvasRect: DOMRect,
    target: MaskPaintSample[],
  ): void {
    const radius = this.brushSettings.radiusPx;
    const sampleSpacing = THREE.MathUtils.clamp(radius / 9, 4, 8);
    const ringCount = Math.ceil(radius / sampleSpacing);
    const hardness = THREE.MathUtils.clamp(this.brushSettings.hardness, 0, 0.99);

    // This conservative fallback makes adjacent projected samples overlap. A
    // later GPU UV buffer can replace this approximation without changing the
    // SelectionMask contract.
    const radiusU = Math.max(1 / stroke.mask.previewCanvas.width, sampleSpacing / canvasRect.width * 2.8);
    const radiusV = Math.max(1 / stroke.mask.previewCanvas.height, sampleSpacing / canvasRect.height * 2.8);

    for (let yIndex = -ringCount; yIndex <= ringCount; yIndex += 1) {
      const yOffset = yIndex * sampleSpacing;
      for (let xIndex = -ringCount; xIndex <= ringCount; xIndex += 1) {
        const xOffset = xIndex * sampleSpacing;
        const normalizedDistance = Math.hypot(xOffset, yOffset) / radius;
        if (normalizedDistance > 1) continue;

        const uv = this.pickUvForTextureSet(
          clientX + xOffset,
          clientY + yOffset,
          stroke.textureSetId,
          canvasRect,
        );
        if (!uv) continue;

        const alpha = normalizedDistance <= hardness
          ? 1
          : 1 - (normalizedDistance - hardness) / (1 - hardness);
        if (alpha <= 0.01) continue;

        target.push({
          u: uv.x,
          v: uv.y,
          alpha,
          radiusU,
          radiusV,
        });
      }
    }

  }

  /** Returns the nearest UV-bearing standard-material surface under a pixel. */
  private pickSurface(clientX: number, clientY: number): PickedSurface | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (!this.castPaintableMeshes(clientX, clientY, rect)) return null;

    for (const intersection of this.intersectionBuffer) {
      if (!intersection.uv || !(intersection.object instanceof THREE.Mesh)) continue;
      const mesh = intersection.object;
      if (!mesh.geometry.getAttribute("uv")) continue;

      const materialIndex = intersection.face?.materialIndex ?? 0;
      const candidate = Array.isArray(mesh.material)
        ? mesh.material[materialIndex]
        : mesh.material;
      if (!(candidate instanceof THREE.MeshStandardMaterial)) continue;

      const materialName = candidate.name || `Material ${materialIndex}`;
      return {
        mesh,
        material: candidate,
        uv: intersection.uv.clone(),
        summary: {
          uv: { u: intersection.uv.x, v: intersection.uv.y },
          meshId: mesh.uuid,
          meshName: mesh.name || "Unnamed Mesh",
          materialIndex,
          materialId: candidate.uuid,
          materialName,
          // Shared material objects intentionally share one mask and overlay.
          textureSetId: candidate.uuid,
          pbrSettings: this.readPbrSettings(candidate),
        },
      };
    }
    return null;
  }

  /** Lightweight hot-path pick: no UV clone and no UI summary allocation. */
  private pickUvForTextureSet(
    clientX: number,
    clientY: number,
    textureSetId: string,
    rect: DOMRect,
  ): THREE.Vector2 | null {
    if (!this.castPaintableMeshes(clientX, clientY, rect)) return null;

    for (const intersection of this.intersectionBuffer) {
      if (!intersection.uv || !(intersection.object instanceof THREE.Mesh)) continue;
      const materialIndex = intersection.face?.materialIndex ?? 0;
      const candidate = Array.isArray(intersection.object.material)
        ? intersection.object.material[materialIndex]
        : intersection.object.material;
      if (candidate instanceof THREE.MeshStandardMaterial && candidate.uuid === textureSetId) {
        return intersection.uv;
      }
    }
    return null;
  }

  /** Sets one ray and fills the reusable intersection buffer. */
  private castPaintableMeshes(clientX: number, clientY: number, rect: DOMRect): boolean {
    this.intersectionBuffer.length = 0;
    if (rect.width <= 0 || rect.height <= 0 || this.paintableMeshes.length === 0) return false;

    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    this.raycaster.intersectObjects(this.paintableMeshes, false, this.intersectionBuffer);
    return this.intersectionBuffer.length > 0;
  }

  /**
   * Rebuilds raycast targets only when model content changes and creates one
   * local-space BVH per shared static geometry. Skinned or morphed geometry is
   * intentionally left without a tree so acceleratedRaycast uses its accurate
   * Three.js fallback instead of querying stale undeformed bounds.
   */
  private rebuildPaintableMeshCache(): void {
    this.paintableMeshes.length = 0;
    this.materials.clear();
    const preparedGeometries = new Set<THREE.BufferGeometry>();
    this.contentRoot.traverse((child) => {
      if (!(child instanceof THREE.Mesh) || !child.geometry.getAttribute("uv")) return;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      if (materials.some((material) => material instanceof THREE.MeshStandardMaterial)) {
        this.paintableMeshes.push(child);
        for (const material of materials) {
          if (material instanceof THREE.MeshStandardMaterial) {
            this.materials.set(material.uuid, material);
          }
        }

        const hasPositionMorphs = (child.geometry.morphAttributes.position?.length ?? 0) > 0;
        const isStaticGeometry = !(child instanceof THREE.SkinnedMesh) && !hasPositionMorphs;
        if (isStaticGeometry && !preparedGeometries.has(child.geometry)) {
          if (!child.geometry.boundsTree) {
            child.geometry.computeBoundsTree({ maxLeafSize: 10 });
          }
          preparedGeometries.add(child.geometry);
        }
      }
    });
  }

  private readPbrSettings(material: THREE.MeshStandardMaterial): PbrMaterialSettings {
    return {
      baseColor: `#${material.color.getHexString()}`,
      roughness: material.roughness,
      metallic: material.metalness,
      normalScale: material.normalScale.x,
    };
  }

  private ensureMask(surface: PickedSurface): MaskRecord {
    const key = surface.summary.textureSetId;
    const existing = this.masks.get(key);
    if (existing) return existing;

    const { width, height } = this.findSelectionResolution(surface.material);
    const mask = new SelectionMask(key, width, height);
    const record: MaskRecord = { mask, materialName: surface.summary.materialName };
    this.masks.set(key, record);

    const overlay = new SelectionOverlay(
      surface.material,
      mask.previewTexture,
      mask.previewCanvas.width,
      mask.previewCanvas.height,
      this.brushSettings,
    );
    this.overlays.set(key, overlay);
    return record;
  }

  /** Chooses the largest loaded texture in the material as the mask domain. */
  private findSelectionResolution(material: THREE.MeshStandardMaterial): { width: number; height: number } {
    let bestWidth = DEFAULT_MASK_SIZE;
    let bestHeight = DEFAULT_MASK_SIZE;
    let bestArea = 0;

    for (const value of Object.values(material)) {
      if (!(value instanceof THREE.Texture)) continue;
      const data = value.source.data as {
        width?: number;
        height?: number;
        naturalWidth?: number;
        naturalHeight?: number;
        videoWidth?: number;
        videoHeight?: number;
      } | null;
      const width = data?.width ?? data?.naturalWidth ?? data?.videoWidth ?? 0;
      const height = data?.height ?? data?.naturalHeight ?? data?.videoHeight ?? 0;
      if (width * height > bestArea) {
        bestWidth = width;
        bestHeight = height;
        bestArea = width * height;
      }
    }

    return { width: bestWidth, height: bestHeight };
  }

  private toMaskSummary(record: MaskRecord): MaskSummary {
    return {
      textureSetId: record.mask.textureSetId,
      materialName: record.materialName,
      width: record.mask.width,
      height: record.mask.height,
      previewDataUrl: record.mask.toPreviewDataUrl(),
      hasContent: record.mask.hasContent,
    };
  }

  private clearSelectionResources(): void {
    for (const overlay of this.overlays.values()) overlay.dispose();
    for (const record of this.masks.values()) record.mask.dispose();
    this.overlays.clear();
    this.masks.clear();
    this.intersectionBuffer.length = 0;
    this.activeStroke = null;
    this.activeMaskKey = null;
  }

  private updateBrushCursor(clientX: number, clientY: number): void {
    if (this.toolMode !== "brush") return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.brushCursor.style.left = `${clientX - rect.left}px`;
    this.brushCursor.style.top = `${clientY - rect.top}px`;
    this.brushCursor.classList.add("is-visible");
  }

  private updateBrushCursorSize(): void {
    const diameter = this.brushSettings.radiusPx * 2;
    this.brushCursor.style.width = `${diameter}px`;
    this.brushCursor.style.height = `${diameter}px`;
  }

  private hideBrushCursor(): void {
    this.brushCursor.classList.remove("is-visible");
  }

  private readonly resize = () => {
    const width = Math.max(this.host.clientWidth, 1);
    const height = Math.max(this.host.clientHeight, 1);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  };

  private readonly animate = () => {
    this.animationFrame = requestAnimationFrame(this.animate);
    this.processPendingStroke();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  private disposeObject(root: THREE.Object3D): void {
    root.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      if (child.geometry.boundsTree) child.geometry.disposeBoundsTree();
      child.geometry?.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        for (const value of Object.values(material)) {
          if (value instanceof THREE.Texture) value.dispose();
        }
        material.dispose();
      }
    });
  }
}
