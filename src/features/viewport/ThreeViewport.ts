import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import {
  acceleratedRaycast,
  computeBoundsTree,
  disposeBoundsTree,
} from "three-mesh-bvh";
import { SelectionMask, type MaskPaintSample } from "../mask/SelectionMask";
import type {
  BrushSettings,
  CaptureTransformMode,
  ColorAdjustmentSettings,
  DecalActorSummary,
  DecalBakeResult,
  DecalImageInput,
  LightingSettings,
  MaskSummary,
  MaterialChannel,
  PbrMaterialSettings,
  ProjectionCaptureSettings,
  ProjectionCaptureSummary,
  SurfaceHitSummary,
  TextureSetSummary,
  ToolMode,
} from "../../types/editor";
import { SelectionOverlay } from "./SelectionOverlay";
import { TextureSetRuntime } from "../texture/TextureSetRuntime";
import { ProjectionCaptureActor } from "../capture/ProjectionCaptureActor";
import {
  ProjectionCaptureRenderer,
  type ProjectionCaptureRuntime,
} from "../capture/ProjectionCaptureRenderer";
import { DecalActor } from "../decal/DecalActor";
import { DecalRenderer } from "../decal/DecalRenderer";

// Install the library's Three.js-compatible extension points once for this
// application. acceleratedRaycast automatically falls back to Three.js when a
// geometry has no BVH, which keeps unsupported/deforming meshes functional.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

interface ThreeViewportCallbacks {
  onSurfaceHit: (surface: SurfaceHitSummary | null) => void;
  onMaskChanged: (mask: MaskSummary | null) => void;
  onTextureSetChanged: (textureSet: TextureSetSummary | null) => void;
  onCaptureChanged: (capture: ProjectionCaptureSummary | null) => void;
  onDecalChanged: (decal: DecalActorSummary | null) => void;
  onDecalBaked: (result: DecalBakeResult) => void;
  onCaptureError: (message: string) => void;
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
  worldBounds: THREE.Box3;
  normalSum: THREE.Vector3;
  spatialSampleCount: number;
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
  private static readonly STUDIO_IBL_SCALE = 0.35;
  private static readonly HEMISPHERE_FILL_SCALE = 0.18;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(42, 1, 0.01, 2000);
  private readonly renderer: THREE.WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly transformControls: TransformControls;
  private readonly transformControlsHelper: THREE.Object3D;
  private readonly contentRoot = new THREE.Group();
  private readonly grid = new THREE.GridHelper(20, 40, 0x39414c, 0x272c34);
  private readonly environmentLight = new THREE.HemisphereLight(0xddeeff, 0x667080, 0.28);
  private readonly directionalLight = new THREE.DirectionalLight(0xffffff, 3.2);
  private readonly studioEnvironmentTarget: THREE.WebGLRenderTarget;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly resizeObserver: ResizeObserver;
  private readonly brushCursor = document.createElement("div");
  private readonly masks = new Map<string, MaskRecord>();
  private readonly overlays = new Map<string, SelectionOverlay>();
  private readonly materials = new Map<string, THREE.MeshStandardMaterial>();
  private readonly textureSets = new Map<string, TextureSetRuntime>();
  private readonly importedTextures = new Map<string, THREE.Texture>();
  private readonly colorAdjustments = new Map<string, ColorAdjustmentSettings>();
  /** Flat raycast targets avoid recursively walking the scene for every sample. */
  private readonly paintableMeshes: THREE.Mesh[] = [];
  /** Three.js supports a caller-owned target array, so reuse it per raycast. */
  private readonly intersectionBuffer: THREE.Intersection[] = [];
  private readonly brushHitUv = new THREE.Vector2();
  private readonly brushHitPoint = new THREE.Vector3();
  private readonly brushHitNormal = new THREE.Vector3();
  private readonly brushNormalMatrix = new THREE.Matrix3();
  private readonly captureRenderer: ProjectionCaptureRenderer;
  private readonly decalRenderer: DecalRenderer;

  private animationFrame = 0;
  private environmentIntensity = 1.55;
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
  private captureActor: ProjectionCaptureActor | null = null;
  private captureMaterialId: string | null = null;
  private captureRuntime: ProjectionCaptureRuntime | null = null;
  private captureResolution = 512;
  private captureDirty = false;
  private lastCaptureTime = 0;
  private captureActorVisible = true;
  private decalActor: DecalActor | null = null;
  private decalSessionId = 0;
  private decalDirty = false;
  private lastDecalTime = 0;
  private decalActorVisible = true;
  private decalPreviewVisible = true;
  private pendingColorAdjustment: {
    materialId: string;
    settings: ColorAdjustmentSettings;
  } | null = null;

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
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // The generated studio environment supplies prefiltered reflections for
    // metallic PBR surfaces, including faces turned away from the key light.
    const roomEnvironment = new RoomEnvironment();
    const pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    this.studioEnvironmentTarget = pmremGenerator.fromScene(roomEnvironment, 0.04);
    this.scene.environment = this.studioEnvironmentTarget.texture;
    this.scene.environmentIntensity = this.environmentIntensity
      * ThreeViewport.STUDIO_IBL_SCALE;
    roomEnvironment.dispose();
    pmremGenerator.dispose();
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

    this.captureRenderer = new ProjectionCaptureRenderer(this.renderer);
    this.decalRenderer = new DecalRenderer(this.renderer);
    this.transformControls = new TransformControls(this.camera, this.renderer.domElement);
    this.transformControls.setSpace("local");
    this.transformControls.setMode("translate");
    this.transformControls.size = 0.78;
    this.transformControls.enabled = false;
    this.transformControlsHelper = this.transformControls.getHelper();
    this.transformControlsHelper.visible = false;
    this.scene.add(this.transformControlsHelper);
    this.transformControls.addEventListener("dragging-changed", (event) => {
      this.controls.enabled = !(event.value as boolean) && this.toolMode !== "brush";
    });
    this.transformControls.addEventListener("objectChange", () => {
      if (this.transformControls.getMode() === "scale") return;
      if (this.toolMode === "capture") this.markCaptureDirty();
      if (this.toolMode === "decal") this.markDecalDirty();
    });
    this.transformControls.addEventListener("mouseUp", (event) => {
      if (event.mode === "scale") {
        if (this.toolMode === "capture") this.captureActor?.absorbRootScale();
        if (this.toolMode === "decal") this.decalActor?.absorbRootScale();
      }
      if (this.toolMode === "capture") this.markCaptureDirty(true);
      if (this.toolMode === "decal") this.markDecalDirty(true);
    });

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
    this.controls.enabled = toolMode !== "brush";
    for (const overlay of this.overlays.values()) overlay.setEnabled(toolMode !== "decal");
    this.syncActorVisibility();
    this.renderer.domElement.classList.toggle("is-brush-mode", toolMode === "brush");
    if (toolMode !== "brush") this.hideBrushCursor();
  }

  setCaptureActorVisible(visible: boolean): void {
    this.captureActorVisible = visible;
    this.syncActorVisibility();
  }

  setDecalActorVisible(visible: boolean): void {
    this.decalActorVisible = visible;
    this.syncActorVisibility();
  }

  setDecalPreviewVisible(visible: boolean): void {
    this.decalPreviewVisible = visible;
    this.decalRenderer.setPreviewVisible(visible);
  }

  setCaptureTransformMode(mode: CaptureTransformMode): void {
    this.transformControls.setMode(mode);
  }

  /** Creates the first orthographic capture actor from accumulated brush hits. */
  createCaptureActor(): boolean {
    if (!this.activeMaskKey) return false;
    const record = this.masks.get(this.activeMaskKey);
    if (!record?.mask.hasContent || record.worldBounds.isEmpty() || record.spatialSampleCount === 0) {
      return false;
    }

    this.clearDecalActor();
    this.clearCaptureActor();
    const center = record.worldBounds.getCenter(new THREE.Vector3());
    const size = record.worldBounds.getSize(new THREE.Vector3());
    const normal = record.normalSum.clone();
    if (normal.lengthSq() < 1e-8) {
      this.camera.getWorldDirection(normal).negate();
    } else {
      normal.normalize();
    }
    const selectionDiameter = Math.max(size.x, size.y, size.z, 0.08);
    const width = selectionDiameter * 1.35;
    const height = selectionDiameter * 1.35;
    const standOff = Math.max(selectionDiameter * 0.35, 0.03);
    const near = Math.max(standOff * 0.05, 0.001);
    const far = Math.max(standOff + selectionDiameter * 1.5, near + 0.01);
    const actorPosition = center.clone().addScaledVector(normal, standOff);

    this.captureActor = new ProjectionCaptureActor({
      center: actorPosition,
      surfaceNormal: normal,
      width,
      height,
      near,
      far,
    });
    this.captureMaterialId = this.activeMaskKey;
    this.captureActorVisible = true;
    this.scene.add(this.captureActor.root);
    this.syncActorVisibility();
    this.markCaptureDirty(true);
    return true;
  }

  /** Promotes the latest unlit capture into one independently transformable Decal. */
  createDecalActor(): boolean {
    if (!this.captureActor || !this.captureMaterialId || !this.captureRuntime) return false;
    this.clearDecalActor();
    this.decalActor = new DecalActor(
      this.captureActor,
      this.captureMaterialId,
      this.captureRuntime.channelCanvases,
      this.captureRuntime.maskCanvas,
    );
    this.scene.add(this.decalActor.root);
    const targetMaterial = this.materials.get(this.captureMaterialId);
    if (!targetMaterial) {
      this.clearDecalActor();
      return false;
    }
    this.captureActorVisible = false;
    this.decalActorVisible = true;
    this.decalPreviewVisible = true;
    this.decalRenderer.rebuild(this.contentRoot, this.decalActor, targetMaterial);
    this.decalSessionId += 1;
    this.syncActorVisibility();
    this.markDecalDirty(true);
    this.publishDecal();
    return true;
  }

  async setDecalImage(input: DecalImageInput): Promise<void> {
    if (!this.decalActor) throw new Error("Create a Decal Actor before importing an image");
    await this.decalActor.setImage(input);
    this.markDecalDirty(true);
    this.publishDecal();
  }

  setDecalUseCaptureMask(enabled: boolean): void {
    if (!this.decalActor) return;
    this.decalActor.setUseCaptureMask(enabled);
    this.markDecalDirty(true);
    this.publishDecal();
  }

  setDecalChannelEnabled(channel: MaterialChannel, enabled: boolean): void {
    if (!this.decalActor) return;
    this.decalActor.setChannelEnabled(channel, enabled);
    this.markDecalDirty(true);
    this.publishDecal();
  }

  bakeDecal(): DecalBakeResult {
    const actor = this.decalActor;
    if (!actor) throw new Error("Create a Decal Actor before baking");
    const textureSet = this.textureSets.get(actor.targetMaterialId);
    if (!textureSet) throw new Error("The target Texture Set is no longer available");
    const enabledChannels = actor.getEnabledChannels();
    if (enabledChannels.length === 0) throw new Error("Enable at least one Decal channel before baking");
    const sources = new Map<MaterialChannel, NonNullable<ReturnType<TextureSetRuntime["getChannelSource"]>>>();
    const missingChannels: MaterialChannel[] = [];
    for (const channel of enabledChannels) {
      const source = textureSet.getChannelSource(channel);
      if (!source || source.width <= 0 || source.height <= 0) {
        missingChannels.push(channel);
      } else {
        sources.set(channel, source);
      }
    }
    if (missingChannels.length > 0) {
      throw new Error(`Import target maps before baking: ${missingChannels.join(", ")}`);
    }
    const canvases = this.decalRenderer.bake(actor, sources, this.captureResolution);
    textureSet.applyBakedChannels(canvases);
    if (canvases.has("baseColor")) this.colorAdjustments.delete(actor.targetMaterialId);
    this.setDecalPreviewVisible(false);
    this.publishTextureSet(actor.targetMaterialId);
    this.publishDecal();
    const result: DecalBakeResult = {
      textureSetId: actor.targetMaterialId,
      channels: Object.fromEntries(Array.from(canvases, ([channel, canvas]) => [channel, {
        width: canvas.width,
        height: canvas.height,
        processedPixels: canvas.width * canvas.height,
      }])),
    };
    this.callbacks.onDecalBaked(result);
    return result;
  }

  updateCaptureSettings(settings: ProjectionCaptureSettings): void {
    if (!this.captureActor) return;
    this.captureResolution = THREE.MathUtils.clamp(Math.round(settings.resolution), 128, 2048);
    this.captureActor.setClipPlanes(settings.near, settings.far);
    this.markCaptureDirty(true);
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
    if (this.captureMaterialId === materialId) this.markCaptureDirty();
  }

  /** Updates the studio IBL, diffuse fill, and directional key light. */
  setLightingSettings(settings: LightingSettings): void {
    this.environmentIntensity = THREE.MathUtils.clamp(settings.environmentIntensity, 0, 5);
    this.environmentLight.color.set(settings.environmentColor);
    // Scene-level and material-local environment maps use separate intensity
    // paths in Three.js r185, so drive both from the same UI control.
    const effectiveIblIntensity = this.environmentIntensity
      * ThreeViewport.STUDIO_IBL_SCALE;
    this.scene.environmentIntensity = effectiveIblIntensity;
    // A neutral lower-hemisphere fill prevents downward/back-facing diffuse
    // areas from collapsing to black while IBL handles specular response.
    this.environmentLight.groundColor.set(0x667080);
    this.environmentLight.intensity = this.environmentIntensity
      * ThreeViewport.HEMISPHERE_FILL_SCALE;
    for (const material of this.materials.values()) {
      material.envMapIntensity = effectiveIblIntensity;
    }
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
    this.markCaptureDirty();
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
    const textureSet = this.textureSets.get(materialId);
    textureSet?.setTexture(channel, texture, file.name);
    if (channel === "baseColor") this.colorAdjustments.delete(materialId);
    this.publishTextureSet(materialId);
    if (this.captureMaterialId === materialId) this.markCaptureDirty(true);
    if (this.decalActor?.targetMaterialId === materialId) {
      this.markDecalDirty(true);
      this.publishDecal();
    }
  }

  /** Coalesces rapid slider input; the animation loop renders once per frame. */
  setBaseColorAdjustment(
    materialId: string | null,
    settings: ColorAdjustmentSettings,
  ): void {
    if (!materialId) return;
    this.colorAdjustments.set(materialId, settings);
    this.pendingColorAdjustment = { materialId, settings };
  }

  resetChannel(materialId: string | null, channel: MaterialChannel): void {
    if (!materialId) return;
    if (channel === "baseColor") {
      this.pendingColorAdjustment = null;
      this.colorAdjustments.delete(materialId);
    }
    this.textureSets.get(materialId)?.resetChannel(channel);
    this.publishTextureSet(materialId);
    if (this.captureMaterialId === materialId) this.markCaptureDirty(true);
    if (this.decalActor?.targetMaterialId === materialId) {
      this.markDecalDirty(true);
      this.publishDecal();
    }
  }

  async exportChannel(
    materialId: string | null,
    channel: MaterialChannel,
    settings: ColorAdjustmentSettings,
  ): Promise<boolean> {
    if (!materialId) return false;
    const textureSet = this.textureSets.get(materialId);
    const mask = this.masks.get(materialId)?.mask;
    if (!textureSet || (channel === "baseColor" && !mask)) return false;

    const blob = await textureSet.exportChannel(channel, mask, settings);
    if (!blob) return false;
    const materialName = this.materials.get(materialId)?.name || "Material";
    const safeName = materialName.replace(/[^a-z0-9_-]+/gi, "_");
    const channelLabel = {
      baseColor: "BaseColor",
      roughness: "Roughness",
      metallic: "Metallic",
      normal: "Normal",
    }[channel];
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeName}_${channelLabel}.png`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
  }

  clearActiveMask(): void {
    if (!this.activeMaskKey) return;
    const record = this.masks.get(this.activeMaskKey);
    if (!record) return;
    record.mask.clear();
    record.worldBounds.makeEmpty();
    record.normalSum.set(0, 0, 0);
    record.spatialSampleCount = 0;
    const settings = this.colorAdjustments.get(this.activeMaskKey);
    if (settings) this.textureSets.get(this.activeMaskKey)?.applyBaseColorAdjustment(record.mask, settings);
    this.publishTextureSet(this.activeMaskKey);
    this.callbacks.onMaskChanged(this.toMaskSummary(record));
    if (this.captureMaterialId === this.activeMaskKey) this.markCaptureDirty(true);
  }

  dispose(): void {
    cancelAnimationFrame(this.animationFrame);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener("pointerdown", this.handlePointerDown);
    this.renderer.domElement.removeEventListener("pointermove", this.handlePointerMove);
    this.renderer.domElement.removeEventListener("pointerup", this.handlePointerUp);
    this.renderer.domElement.removeEventListener("pointercancel", this.handlePointerCancel);
    this.renderer.domElement.removeEventListener("pointerleave", this.handlePointerLeave);
    this.clearDecalActor();
    this.clearCaptureActor();
    this.transformControls.detach();
    this.transformControls.dispose();
    this.transformControlsHelper.removeFromParent();
    this.controls.dispose();
    this.clearSelectionResources();
    this.clearTextureSetResources();
    this.disposeObject(this.contentRoot);
    this.importedTextures.clear();
    this.scene.environment = null;
    this.studioEnvironmentTarget.dispose();
    this.captureRenderer.dispose();
    this.decalRenderer.dispose();
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
    this.clearDecalActor();
    this.clearCaptureActor();
    this.clearSelectionResources();
    this.clearTextureSetResources();
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
    if (box.isEmpty()) throw new Error("The GLB contains no visible geometry");
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
    this.callbacks.onTextureSetChanged(null);
    this.callbacks.onCaptureChanged(null);
    this.callbacks.onDecalChanged(null);
  }

  private readonly handlePointerDown = (event: PointerEvent) => {
    this.pointerStart.set(event.clientX, event.clientY);
    if (this.toolMode !== "brush" || event.button !== 0) return;

    const surface = this.pickSurface(event.clientX, event.clientY);
    if (!surface) {
      this.callbacks.onSurfaceHit(null);
      this.callbacks.onTextureSetChanged(null);
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
    this.publishTextureSet(surface.summary.textureSetId);
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
      this.callbacks.onTextureSetChanged(null);
      return;
    }
    this.activeMaskKey = surface.summary.textureSetId;
    this.publishTextureSet(surface.summary.textureSetId);
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
    const settings = this.colorAdjustments.get(stroke.textureSetId);
    if (settings && record) {
      this.textureSets.get(stroke.textureSetId)?.applyBaseColorAdjustment(record.mask, settings);
      this.publishTextureSet(stroke.textureSetId);
    }
    this.activeStroke = null;
    if (record) this.callbacks.onMaskChanged(this.toMaskSummary(record));
    if (this.captureMaterialId === stroke.textureSetId) this.markCaptureDirty(true);
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

        const hit = this.pickBrushHitForTextureSet(
          clientX + xOffset,
          clientY + yOffset,
          stroke.textureSetId,
          canvasRect,
        );
        if (!hit) continue;

        const record = this.masks.get(stroke.textureSetId);
        if (record) {
          record.worldBounds.expandByPoint(this.brushHitPoint);
          record.normalSum.add(this.brushHitNormal);
          record.spatialSampleCount += 1;
        }

        const alpha = normalizedDistance <= hardness
          ? 1
          : 1 - (normalizedDistance - hardness) / (1 - hardness);
        if (alpha <= 0.01) continue;

        target.push({
          u: this.brushHitUv.x,
          v: this.brushHitUv.y,
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

  /**
   * Lightweight hot-path pick that also retains world-space placement data.
   * Reusable vectors avoid allocating once per dense screen-space sample.
   */
  private pickBrushHitForTextureSet(
    clientX: number,
    clientY: number,
    textureSetId: string,
    rect: DOMRect,
  ): boolean {
    if (!this.castPaintableMeshes(clientX, clientY, rect)) return false;

    for (const intersection of this.intersectionBuffer) {
      if (!intersection.uv || !(intersection.object instanceof THREE.Mesh)) continue;
      const materialIndex = intersection.face?.materialIndex ?? 0;
      const candidate = Array.isArray(intersection.object.material)
        ? intersection.object.material[materialIndex]
        : intersection.object.material;
      if (candidate instanceof THREE.MeshStandardMaterial && candidate.uuid === textureSetId) {
        this.brushHitUv.copy(intersection.uv);
        this.brushHitPoint.copy(intersection.point);
        if (intersection.face) {
          this.brushNormalMatrix.getNormalMatrix(intersection.object.matrixWorld);
          this.brushHitNormal.copy(intersection.face.normal)
            .applyMatrix3(this.brushNormalMatrix)
            .normalize();
        } else {
          this.camera.getWorldDirection(this.brushHitNormal).negate();
        }
        return true;
      }
    }
    return false;
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
            material.envMapIntensity = this.environmentIntensity
              * ThreeViewport.STUDIO_IBL_SCALE;
            this.materials.set(material.uuid, material);
          }
        }

        const hasPositionMorphs = (child.geometry.morphAttributes.position?.length ?? 0) > 0;
        const isStaticGeometry = !(child instanceof THREE.SkinnedMesh) && !hasPositionMorphs;
        if (isStaticGeometry && !preparedGeometries.has(child.geometry)) {
          if (!child.geometry.boundsTree) {
            child.geometry.computeBoundsTree({ targetLeafSize: 10 });
          }
          preparedGeometries.add(child.geometry);
        }
      }
    });
    for (const material of this.materials.values()) {
      this.textureSets.set(material.uuid, new TextureSetRuntime(material));
    }
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
    const record: MaskRecord = {
      mask,
      materialName: surface.summary.materialName,
      worldBounds: new THREE.Box3(),
      normalSum: new THREE.Vector3(),
      spatialSampleCount: 0,
    };
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

  private clearTextureSetResources(): void {
    for (const textureSet of this.textureSets.values()) textureSet.dispose();
    this.textureSets.clear();
    this.materials.clear();
    this.colorAdjustments.clear();
    this.pendingColorAdjustment = null;
  }

  private publishTextureSet(materialId: string): void {
    const summary = this.textureSets.get(materialId)?.getSummary() ?? null;
    this.callbacks.onTextureSetChanged(summary);
  }

  private processPendingColorAdjustment(): void {
    const pending = this.pendingColorAdjustment;
    if (!pending) return;
    this.pendingColorAdjustment = null;
    const textureSet = this.textureSets.get(pending.materialId);
    const mask = this.masks.get(pending.materialId)?.mask;
    if (!textureSet || !mask) return;
    textureSet.applyBaseColorAdjustment(mask, pending.settings);
    this.publishTextureSet(pending.materialId);
    if (this.captureMaterialId === pending.materialId) this.markCaptureDirty();
  }

  /** Releases the editor actor without touching the model or its selection. */
  private clearCaptureActor(): void {
    this.transformControls.detach();
    this.captureActor?.dispose();
    this.captureActor = null;
    this.captureMaterialId = null;
    this.captureRuntime = null;
    this.captureDirty = false;
    this.transformControls.enabled = false;
    this.transformControlsHelper.visible = false;
    this.callbacks.onCaptureChanged(null);
  }

  private clearDecalActor(): void {
    if (this.transformControls.object === this.decalActor?.root) this.transformControls.detach();
    this.decalRenderer.clear();
    this.decalActor?.dispose();
    this.decalActor = null;
    this.decalDirty = false;
    this.lastDecalTime = 0;
    this.callbacks.onDecalChanged(null);
  }

  /** Applies user visibility preferences without letting Tool Mode overwrite them. */
  private syncActorVisibility(): void {
    this.captureActor?.setGizmoVisible(this.captureActorVisible);
    this.decalActor?.setGizmoVisible(this.decalActorVisible);
    this.decalRenderer.setPreviewVisible(this.decalPreviewVisible);

    const actor = this.toolMode === "capture"
      ? (this.captureActorVisible ? this.captureActor : null)
      : this.toolMode === "decal"
        ? (this.decalActorVisible ? this.decalActor : null)
        : null;
    if (actor) this.transformControls.attach(actor.root);
    else this.transformControls.detach();
    this.transformControls.enabled = Boolean(actor);
    this.transformControlsHelper.visible = this.transformControls.enabled;
  }

  /** Schedules one throttled GPU capture after an actor, mask, or setting edit. */
  private markCaptureDirty(immediate = false): void {
    if (!this.captureActor) return;
    this.captureDirty = true;
    if (immediate) this.lastCaptureTime = 0;
  }

  private processPendingCapture(time: number): void {
    if (!this.captureDirty || !this.captureActor || !this.captureMaterialId) return;
    // TransformControls can emit many objectChange events per frame. A short
    // throttle keeps interaction responsive while still making the preview feel live.
    const captureInterval = this.captureResolution >= 1024 ? 300 : 160;
    if (this.lastCaptureTime > 0 && time - this.lastCaptureTime < captureInterval) return;
    const record = this.masks.get(this.captureMaterialId);
    const captureMaterial = this.materials.get(this.captureMaterialId);
    if (!record || !captureMaterial) return;

    const gridVisible = this.grid.visible;
    const helperVisible = this.transformControlsHelper.visible;
    const decalGizmo = this.decalActor?.gizmo;
    const decalGizmoVisible = decalGizmo?.visible ?? false;
    if (decalGizmo) decalGizmo.visible = false;
    this.grid.visible = false;
    this.transformControlsHelper.visible = false;
    const decalPreviewWasVisible = this.decalPreviewVisible;
    this.decalRenderer.setPreviewVisible(false);
    this.captureActor.root.updateMatrixWorld(true);
    try {
      const runtime = this.captureRenderer.capture(
        this.scene,
        this.contentRoot,
        this.captureActor,
        captureMaterial,
        record.mask,
        (enabled) => {
          for (const overlay of this.overlays.values()) overlay.setEnabled(enabled && this.toolMode !== "decal");
        },
        this.captureResolution,
      );
      this.callbacks.onCaptureChanged({
        width: this.captureActor.getWidth(),
        height: this.captureActor.getHeight(),
        near: this.captureActor.getNear(),
        far: this.captureActor.getFar(),
        resolution: this.captureResolution,
        ...runtime.images,
      });
      this.captureRuntime = runtime;
      this.captureDirty = false;
      this.lastCaptureTime = time;
    } catch (error: unknown) {
      this.captureDirty = false;
      const message = error instanceof Error ? error.message : String(error);
      this.callbacks.onCaptureError(message);
    } finally {
      this.grid.visible = gridVisible;
      if (decalGizmo) decalGizmo.visible = decalGizmoVisible;
      this.transformControlsHelper.visible = helperVisible;
      this.decalRenderer.setPreviewVisible(decalPreviewWasVisible);
    }
  }

  private markDecalDirty(immediate = false): void {
    if (!this.decalActor) return;
    this.decalDirty = true;
    if (immediate) this.lastDecalTime = 0;
  }

  private processPendingDecal(time: number): void {
    if (!this.decalDirty || !this.decalActor) return;
    if (this.lastDecalTime > 0 && time - this.lastDecalTime < 80) return;
    this.decalRenderer.update(this.decalActor, this.captureResolution);
    this.decalDirty = false;
    this.lastDecalTime = time;
    this.publishDecal();
  }

  private publishDecal(): void {
    const actor = this.decalActor;
    if (!actor) {
      this.callbacks.onDecalChanged(null);
      return;
    }
    const targetTextureSet = this.textureSets.get(actor.targetMaterialId)?.getSummary();
    if (!targetTextureSet) {
      this.callbacks.onDecalChanged(null);
      return;
    }
    this.callbacks.onDecalChanged({
      sessionId: this.decalSessionId,
      textureSetId: actor.targetMaterialId,
      targetTextureSet,
      useCaptureMask: actor.getUseCaptureMask(),
      width: actor.getWidth(),
      height: actor.getHeight(),
      near: actor.getNear(),
      far: actor.getFar(),
      channels: actor.getChannelSummaries(),
    });
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

  private readonly animate = (time = performance.now()) => {
    this.animationFrame = requestAnimationFrame(this.animate);
    this.processPendingStroke();
    this.processPendingColorAdjustment();
    this.processPendingCapture(time);
    this.processPendingDecal(time);
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
