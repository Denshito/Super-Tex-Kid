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

export type ToolMode = "orbit" | "brush";

export type MaterialChannel = "baseColor" | "normal" | "roughness" | "metallic";

/** User-facing controls backed by MeshStandardMaterial's PBR uniforms. */
export interface PbrMaterialSettings {
  baseColor: string;
  roughness: number;
  metallic: number;
  normalScale: number;
}

/** Simple studio lighting; environment here means hemispherical fill, not IBL. */
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
