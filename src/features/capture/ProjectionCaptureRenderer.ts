import * as THREE from "three";
import type { MaterialChannel } from "../../types/editor";
import type { SelectionMask } from "../mask/SelectionMask";
import { ProjectionCaptureActor } from "./ProjectionCaptureActor";

export interface ProjectionCaptureImages {
  baseColorPreviewDataUrl: string;
  roughnessPreviewDataUrl: string;
  materialNormalPreviewDataUrl: string;
  metallicPreviewDataUrl: string;
  maskPreviewDataUrl: string;
  viewNormalPreviewDataUrl: string;
  linearDepthPreviewDataUrl: string;
  compositePreviewDataUrl: string;
}

export interface ProjectionCaptureRuntime {
  images: ProjectionCaptureImages;
  channelCanvases: Record<MaterialChannel, HTMLCanvasElement>;
  maskCanvas: HTMLCanvasElement;
}

type MaterialCaptureChannel = "baseColor" | "roughness" | "normal" | "metallic";

/**
 * Projects unlit material channels and authoritative selection coverage from
 * the exact same actor. Lighting, highlights, and shadows are never evaluated.
 */
export class ProjectionCaptureRenderer {
  private readonly channelTargets = new Map<MaterialCaptureChannel, THREE.WebGLRenderTarget>();
  private maskTarget: THREE.WebGLRenderTarget | null = null;
  private geometryTarget: THREE.WebGLRenderTarget | null = null;
  private linearDepthTarget: THREE.WebGLRenderTarget | null = null;
  private readonly blackMaterial = new THREE.MeshBasicMaterial({
    color: 0x000000,
    colorWrite: false,
    // Non-target materials remain invisible but still occlude the selected
    // material, matching the visibility of every channel pass.
    depthWrite: true,
    side: THREE.DoubleSide,
  });
  private readonly channelMaterial: THREE.ShaderMaterial;
  private readonly maskMaterial: THREE.ShaderMaterial;
  private readonly viewNormalMaterial = new THREE.MeshNormalMaterial({
    side: THREE.DoubleSide,
  });
  private readonly depthPreviewMaterial: THREE.ShaderMaterial;
  private readonly fullscreenScene = new THREE.Scene();
  private readonly fullscreenCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly fullscreenQuad: THREE.Mesh;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.channelMaterial = new THREE.ShaderMaterial({
      uniforms: {
        channelMap: { value: null },
        uvTransform: { value: new THREE.Matrix3() },
        fallbackColor: { value: new THREE.Color(0xffffff) },
        hasMap: { value: 0 },
        channelMode: { value: 0 },
      },
      vertexShader: `
varying vec2 vCaptureUv;
void main() {
  vCaptureUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`,
      fragmentShader: `
uniform sampler2D channelMap;
uniform mat3 uvTransform;
uniform vec3 fallbackColor;
uniform float hasMap;
uniform int channelMode;
varying vec2 vCaptureUv;
void main() {
  vec2 transformedUv = ( uvTransform * vec3( vCaptureUv, 1.0 ) ).xy;
  vec4 texel = hasMap > 0.5 ? texture2D( channelMap, transformedUv ) : vec4( 1.0 );
  vec3 result;
  if ( channelMode == 0 ) {
    // Capture texture data, not the material's display tint. Preview and the
    // baked texture both receive that tint once through MeshStandardMaterial.
    result = hasMap > 0.5 ? texel.rgb : fallbackColor;
  } else if ( channelMode == 1 ) {
    result = vec3( texel.g );
  } else if ( channelMode == 2 ) {
    result = hasMap > 0.5 ? texel.rgb : vec3( 0.5, 0.5, 1.0 );
  } else {
    result = vec3( texel.b );
  }
  gl_FragColor = vec4( result, 1.0 );
}`,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: true,
      toneMapped: false,
    });
    this.maskMaterial = new THREE.ShaderMaterial({
      uniforms: { selectionMap: { value: null } },
      vertexShader: `
varying vec2 vCaptureUv;
void main() {
  vCaptureUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`,
      fragmentShader: `
uniform sampler2D selectionMap;
varying vec2 vCaptureUv;
void main() {
  float coverage = texture2D( selectionMap, vCaptureUv ).r;
  gl_FragColor = vec4( vec3( coverage ), 1.0 );
}`,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: true,
      toneMapped: false,
    });
    this.depthPreviewMaterial = new THREE.ShaderMaterial({
      uniforms: {
        depthMap: { value: null },
      },
      vertexShader: `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}`,
      fragmentShader: `
uniform sampler2D depthMap;
varying vec2 vUv;
void main() {
  float hardwareDepth = texture2D( depthMap, vUv ).r;
  float linearDepth = 1.0 - hardwareDepth;
  gl_FragColor = vec4( vec3( linearDepth ), hardwareDepth < 1.0 ? 1.0 : 0.0 );
}`,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.fullscreenQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this.depthPreviewMaterial,
    );
    this.fullscreenScene.add(this.fullscreenQuad);
  }

  capture(
    scene: THREE.Scene,
    contentRoot: THREE.Object3D,
    actor: ProjectionCaptureActor,
    targetMaterial: THREE.MeshStandardMaterial,
    selectionMask: SelectionMask,
    setSelectionOverlayEnabled: (enabled: boolean) => void,
    resolution: number,
  ): ProjectionCaptureRuntime {
    this.ensureTargets(resolution);
    if (
      this.channelTargets.size !== 4
      || !this.maskTarget
      || !this.geometryTarget
      || !this.linearDepthTarget
      || !this.geometryTarget.depthTexture
    ) {
      throw new Error("Capture targets are unavailable");
    }

    const previousTarget = this.renderer.getRenderTarget();
    const previousBackground = scene.background;
    const previousClearColor = this.renderer.getClearColor(new THREE.Color());
    const previousClearAlpha = this.renderer.getClearAlpha();
    const gizmoVisible = actor.gizmo.visible;

    scene.background = null;
    actor.setGizmoVisible(false);
    setSelectionOverlayEnabled(false);
    this.renderer.setClearColor(0x000000, 0);
    const channelCanvases = new Map<MaterialCaptureChannel, HTMLCanvasElement>();
    try {
      const restoreMaterials = this.replaceMaterials(
        contentRoot,
        targetMaterial.uuid,
        this.channelMaterial,
      );
      try {
        for (const channel of ["baseColor", "roughness", "normal", "metallic"] as const) {
          const target = this.channelTargets.get(channel);
          if (!target) continue;
          this.configureChannelMaterial(targetMaterial, channel);
          this.renderer.setRenderTarget(target);
          this.renderer.clear(true, true, true);
          this.renderer.render(scene, actor.camera);
          channelCanvases.set(channel, this.readTarget(target));
        }
      } finally {
        restoreMaterials();
      }

      const restoreMaskMaterials = this.replaceMaterials(
        contentRoot,
        targetMaterial.uuid,
        this.maskMaterial,
      );
      this.maskMaterial.uniforms.selectionMap.value = selectionMask.previewTexture;
      try {
        this.renderer.setRenderTarget(this.maskTarget);
        this.renderer.clear(true, true, true);
        this.renderer.render(scene, actor.camera);
      } finally {
        restoreMaskMaterials();
      }

      const restoreGeometryMaterials = this.replaceMaterials(
        contentRoot,
        targetMaterial.uuid,
        this.viewNormalMaterial,
      );
      try {
        this.renderer.setRenderTarget(this.geometryTarget);
        this.renderer.clear(true, true, true);
        this.renderer.render(scene, actor.camera);
      } finally {
        restoreGeometryMaterials();
      }

      this.depthPreviewMaterial.uniforms.depthMap.value = this.geometryTarget.depthTexture;
      this.renderer.setRenderTarget(this.linearDepthTarget);
      this.renderer.clear(true, true, true);
      this.renderer.render(this.fullscreenScene, this.fullscreenCamera);
    } finally {
      setSelectionOverlayEnabled(true);
      actor.setGizmoVisible(gizmoVisible);
      scene.background = previousBackground;
      this.renderer.setClearColor(previousClearColor, previousClearAlpha);
      this.renderer.setRenderTarget(previousTarget);
    }

    const baseColorCanvas = channelCanvases.get("baseColor");
    const roughnessCanvas = channelCanvases.get("roughness");
    const normalCanvas = channelCanvases.get("normal");
    const metallicCanvas = channelCanvases.get("metallic");
    if (!baseColorCanvas || !roughnessCanvas || !normalCanvas || !metallicCanvas) {
      throw new Error("One or more material capture passes failed");
    }
    const maskCanvas = this.readTarget(this.maskTarget);
    const viewNormalCanvas = this.readTarget(this.geometryTarget);
    const linearDepthCanvas = this.readTarget(this.linearDepthTarget);
    const compositeCanvas = this.makeComposite(baseColorCanvas, maskCanvas);
    return {
      channelCanvases: {
        baseColor: baseColorCanvas,
        roughness: roughnessCanvas,
        normal: normalCanvas,
        metallic: metallicCanvas,
      },
      maskCanvas,
      images: {
        baseColorPreviewDataUrl: baseColorCanvas.toDataURL("image/png"),
        roughnessPreviewDataUrl: roughnessCanvas.toDataURL("image/png"),
        materialNormalPreviewDataUrl: normalCanvas.toDataURL("image/png"),
        metallicPreviewDataUrl: metallicCanvas.toDataURL("image/png"),
        maskPreviewDataUrl: maskCanvas.toDataURL("image/png"),
        viewNormalPreviewDataUrl: viewNormalCanvas.toDataURL("image/png"),
        linearDepthPreviewDataUrl: linearDepthCanvas.toDataURL("image/png"),
        compositePreviewDataUrl: compositeCanvas.toDataURL("image/png"),
      },
    };
  }

  dispose(): void {
    for (const target of this.channelTargets.values()) target.dispose();
    this.channelTargets.clear();
    this.maskTarget?.dispose();
    this.maskTarget = null;
    this.geometryTarget?.dispose();
    this.geometryTarget = null;
    this.linearDepthTarget?.dispose();
    this.linearDepthTarget = null;
    this.blackMaterial.dispose();
    this.channelMaterial.dispose();
    this.maskMaterial.dispose();
    this.viewNormalMaterial.dispose();
    this.depthPreviewMaterial.dispose();
    this.fullscreenQuad.geometry.dispose();
  }

  private ensureTargets(resolution: number): void {
    const size = THREE.MathUtils.clamp(Math.round(resolution), 128, 2048);
    const existingBaseColor = this.channelTargets.get("baseColor");
    if (existingBaseColor?.width === size && existingBaseColor.height === size) return;
    for (const target of this.channelTargets.values()) target.dispose();
    this.channelTargets.clear();
    this.maskTarget?.dispose();
    this.geometryTarget?.dispose();
    this.linearDepthTarget?.dispose();
    for (const channel of ["baseColor", "roughness", "normal", "metallic"] as const) {
      const target = this.createTarget(size);
      target.texture.name = `ProjectionCapture${channel}`;
      target.texture.colorSpace = channel === "baseColor"
        ? THREE.SRGBColorSpace
        : THREE.NoColorSpace;
      this.channelTargets.set(channel, target);
    }
    this.maskTarget = new THREE.WebGLRenderTarget(size, size, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.maskTarget.texture.name = "ProjectionCaptureMask";
    this.maskTarget.texture.colorSpace = THREE.NoColorSpace;
    this.geometryTarget = this.createTarget(size);
    this.geometryTarget.texture.name = "ProjectionCaptureViewNormal";
    this.geometryTarget.texture.colorSpace = THREE.NoColorSpace;
    this.geometryTarget.depthTexture = new THREE.DepthTexture(
      size,
      size,
      THREE.UnsignedIntType,
    );
    this.geometryTarget.depthTexture.name = "ProjectionCaptureDepth";
    this.geometryTarget.depthTexture.format = THREE.DepthFormat;
    this.geometryTarget.depthTexture.minFilter = THREE.NearestFilter;
    this.geometryTarget.depthTexture.magFilter = THREE.NearestFilter;
    this.linearDepthTarget = this.createTarget(size);
    this.linearDepthTarget.texture.name = "ProjectionCaptureLinearDepth";
    this.linearDepthTarget.texture.colorSpace = THREE.NoColorSpace;
  }

  private createTarget(size: number): THREE.WebGLRenderTarget {
    return new THREE.WebGLRenderTarget(size, size, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
    });
  }

  private configureChannelMaterial(
    material: THREE.MeshStandardMaterial,
    channel: MaterialCaptureChannel,
  ): void {
    const channelIndex = { baseColor: 0, roughness: 1, normal: 2, metallic: 3 }[channel];
    const texture = channel === "baseColor"
      ? material.map
      : channel === "roughness"
        ? material.roughnessMap
        : channel === "normal"
          ? material.normalMap
          : material.metalnessMap;
    texture?.updateMatrix();
    this.channelMaterial.uniforms.channelMode.value = channelIndex;
    this.channelMaterial.uniforms.channelMap.value = texture;
    this.channelMaterial.uniforms.hasMap.value = texture ? 1 : 0;
    this.channelMaterial.uniforms.uvTransform.value.copy(texture?.matrix ?? new THREE.Matrix3());
    this.channelMaterial.uniforms.fallbackColor.value.copy(material.color);
  }

  private replaceMaterials(
    root: THREE.Object3D,
    targetMaterialId: string,
    targetCaptureMaterial: THREE.Material,
  ): () => void {
    const originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
    root.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      originals.set(child, child.material);
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      const captureMaterials = materials.map((material) => (
        material.uuid === targetMaterialId ? targetCaptureMaterial : this.blackMaterial
      ));
      child.material = Array.isArray(child.material) ? captureMaterials : captureMaterials[0];
    });
    return () => {
      for (const [mesh, material] of originals) mesh.material = material;
    };
  }

  private readTarget(target: THREE.WebGLRenderTarget): HTMLCanvasElement {
    const pixels = new Uint8Array(target.width * target.height * 4);
    this.renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, pixels);
    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2D Canvas is unavailable for capture preview");
    const image = context.createImageData(target.width, target.height);
    const stride = target.width * 4;
    for (let y = 0; y < target.height; y += 1) {
      const sourceOffset = (target.height - 1 - y) * stride;
      image.data.set(pixels.subarray(sourceOffset, sourceOffset + stride), y * stride);
    }
    context.putImageData(image, 0, 0);
    return canvas;
  }

  private makeComposite(
    baseColorCanvas: HTMLCanvasElement,
    maskCanvas: HTMLCanvasElement,
  ): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = baseColorCanvas.width;
    canvas.height = baseColorCanvas.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2D Canvas is unavailable for capture composition");
    context.drawImage(baseColorCanvas, 0, 0);
    const maskContext = maskCanvas.getContext("2d");
    if (!maskContext) throw new Error("2D Canvas is unavailable for mask composition");
    const mask = maskContext.getImageData(0, 0, canvas.width, canvas.height);
    const overlay = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let offset = 0; offset < overlay.data.length; offset += 4) {
      const coverage = mask.data[offset] / 255;
      if (coverage <= 0) continue;
      const blend = coverage * 0.55;
      overlay.data[offset] = Math.round(overlay.data[offset] * (1 - blend) + 255 * blend);
      overlay.data[offset + 1] = Math.round(overlay.data[offset + 1] * (1 - blend) + 45 * blend);
      overlay.data[offset + 2] = Math.round(overlay.data[offset + 2] * (1 - blend) + 38 * blend);
    }
    context.putImageData(overlay, 0, 0);
    return canvas;
  }
}
