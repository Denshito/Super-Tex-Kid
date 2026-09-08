/** Visual/runtime state displayed in the editor's bottom status bar. */
export type ViewportStatusKind = "ready" | "loading" | "error";

export interface ViewportStatus {
  kind: ViewportStatusKind;
  message: string;
}

/** Normalized texture coordinates, usually in the [0, 1] range. */
export interface UvCoordinate {
  u: number;
  v: number;
}

export type ToolMode = "orbit" | "brush" | "capture" | "decal";

export type CaptureTransformMode = "translate" | "rotate" | "scale";

export type MaterialChannel = "baseColor" | "normal" | "roughness" | "metallic";

/** User-facing controls backed by MeshStandardMaterial's PBR uniforms. */
export interface PbrMaterialSettings {
  baseColor: string;
  roughness: number;
  metallic: number;
  normalScale: number;
}

/** Deterministic local Base Color effect used before any AI integration. */
export interface ColorAdjustmentSettings {
  hueDegrees: number;
  saturation: number;
  brightness: number;
  contrast: number;
  strength: number;
}

export interface ChannelAssetSummary {
  channel: MaterialChannel;
  fileName: string | null;
  width: number;
  height: number;
  colorSpace: "srgb" | "linear";
  isLoaded: boolean;
  isModified: boolean;
}

/** UI-safe view of one material and its four editable texture channels. */
export interface TextureSetSummary {
  textureSetId: string;
  materialName: string;
  channels: Record<MaterialChannel, ChannelAssetSummary>;
}

/** Built-in studio IBL/fill plus an adjustable directional key light. */
export interface LightingSettings {
  environmentColor: string;
  environmentIntensity: number;
  directionalColor: string;
  directionalIntensity: number;
  directionalAzimuthDeg: number;
  directionalElevationDeg: number;
}

export interface BrushSettings {
  /** Radius of the projected cursor in viewport pixels. */
  radiusPx: number;
  /** Fully selected fraction of the radius. Remaining coverage is feathered. */
  hardness: number;
  /** Approximate inward reference distance, expressed in preview-mask pixels. */
  innerReferencePx: number;
  /** Approximate outward context distance, expressed in preview-mask pixels. */
  outerReferencePx: number;
}

/** Serializable information about the surface currently under/locked by the brush. */
export interface SurfaceHitSummary {
  uv: UvCoordinate;
  meshId: string;
  meshName: string;
  materialIndex: number;
  materialId: string;
  materialName: string;
  textureSetId: string;
  pbrSettings: PbrMaterialSettings;
}

/** UI-safe description of the active material's authoritative selection mask. */
export interface MaskSummary {
  textureSetId: string;
  materialName: string;
  width: number;
  height: number;
  previewDataUrl: string;
  hasContent: boolean;
}

/** Serializable settings for the orthographic projection-capture volume. */
export interface ProjectionCaptureSettings {
  near: number;
  far: number;
  resolution: number;
}

/**
 * UI-safe snapshot of the active capture actor and its latest GPU captures.
 *
 * Unlit material channels and selection coverage stay separate so a future
 * image-model provider never receives baked lighting, highlights, or shadows.
 */
export interface ProjectionCaptureSummary extends ProjectionCaptureSettings {
  width: number;
  height: number;
  baseColorPreviewDataUrl: string;
  roughnessPreviewDataUrl: string;
  materialNormalPreviewDataUrl: string;
  metallicPreviewDataUrl: string;
  maskPreviewDataUrl: string;
  viewNormalPreviewDataUrl: string;
  linearDepthPreviewDataUrl: string;
  compositePreviewDataUrl: string;
}

export type DecalImageOrigin = "capture" | "file" | "generated";

/** Provider-neutral image payload accepted by the Decal runtime. */
export interface DecalImageInput {
  channel: MaterialChannel;
  blob: Blob;
  label: string;
  origin: DecalImageOrigin;
}

export interface DecalChannelSummary {
  channel: MaterialChannel;
  sourceLabel: string;
  sourceOrigin: DecalImageOrigin;
  previewDataUrl: string;
  enabled: boolean;
}

export interface DecalActorSettings {
  useCaptureMask: boolean;
}

/** UI-safe snapshot; mutable Three.js resources remain inside ThreeViewport. */
export interface DecalActorSummary extends DecalActorSettings {
  sessionId: number;
  textureSetId: string;
  targetTextureSet: TextureSetSummary;
  width: number;
  height: number;
  near: number;
  far: number;
  channels: Record<MaterialChannel, DecalChannelSummary>;
}

export interface DecalChannelBakeResult {
  width: number;
  height: number;
  processedPixels: number;
}

export interface DecalBakeResult {
  textureSetId: string;
  channels: Partial<Record<MaterialChannel, DecalChannelBakeResult>>;
}
