import { create } from "zustand";
import type {
  BrushSettings,
  CaptureTransformMode,
  ColorAdjustmentSettings,
  DecalActorSummary,
  LightingSettings,
  MaskSummary,
  MaterialChannel,
  PbrMaterialSettings,
  ProjectionCaptureSettings,
  ProjectionCaptureSummary,
  SurfaceHitSummary,
  TextureSetSummary,
  ToolMode,
  UvCoordinate,
  ViewportStatus,
} from "../types/editor";

/** Cross-panel state for the material-aware screen-space brush milestone. */
interface EditorState {
  modelName: string;
  viewportStatus: ViewportStatus;
  pickedUv: UvCoordinate | null;
  activeSurface: SurfaceHitSummary | null;
  activeMask: MaskSummary | null;
  activeTextureSet: TextureSetSummary | null;
  toolMode: ToolMode;
  activeChannel: MaterialChannel;
  brushSettings: BrushSettings;
  pbrSettings: PbrMaterialSettings;
  lightingSettings: LightingSettings;
  colorAdjustment: ColorAdjustmentSettings;
  clearMaskToken: number;
  channelResetRequest: { materialId: string | null; channel: MaterialChannel; token: number } | null;
  channelExportRequest: { materialId: string | null; channel: MaterialChannel; token: number } | null;
  captureSummary: ProjectionCaptureSummary | null;
  captureActorVisible: boolean;
  captureTransformMode: CaptureTransformMode;
  createCaptureToken: number;
  captureUpdate: ProjectionCaptureSettings | null;
  captureUpdateToken: number;
  decalSummary: DecalActorSummary | null;
  activeDecalChannel: MaterialChannel;
  decalActorVisible: boolean;
  decalPreviewVisible: boolean;
  createDecalToken: number;
  decalMaskEnabled: boolean;
  decalMaskUpdateToken: number;
  decalChannelUpdate: { channel: MaterialChannel; enabled: boolean; token: number } | null;
  bakeDecalToken: number;

  setModelName: (modelName: string) => void;
  setViewportStatus: (viewportStatus: ViewportStatus) => void;
  setSurfaceHit: (surface: SurfaceHitSummary | null) => void;
  setActiveMask: (mask: MaskSummary | null) => void;
  setActiveTextureSet: (textureSet: TextureSetSummary | null) => void;
  setToolMode: (toolMode: ToolMode) => void;
  setActiveChannel: (activeChannel: MaterialChannel) => void;
  patchBrushSettings: (settings: Partial<BrushSettings>) => void;
  patchPbrSettings: (settings: Partial<PbrMaterialSettings>) => void;
  patchLightingSettings: (settings: Partial<LightingSettings>) => void;
  patchColorAdjustment: (settings: Partial<ColorAdjustmentSettings>) => void;
  requestClearMask: () => void;
  requestResetChannel: (materialId: string | null, channel: MaterialChannel) => void;
  requestExportChannel: (materialId: string | null, channel: MaterialChannel) => void;
  setCaptureSummary: (summary: ProjectionCaptureSummary | null) => void;
  setCaptureActorVisible: (visible: boolean) => void;
  setCaptureTransformMode: (mode: CaptureTransformMode) => void;
  requestCreateCapture: () => void;
  requestCaptureUpdate: (settings: ProjectionCaptureSettings) => void;
  setDecalSummary: (summary: DecalActorSummary | null) => void;
  setActiveDecalChannel: (channel: MaterialChannel) => void;
  setDecalActorVisible: (visible: boolean) => void;
  setDecalPreviewVisible: (visible: boolean) => void;
  requestCreateDecal: () => void;
  setDecalMaskEnabled: (enabled: boolean) => void;
  setDecalChannelEnabled: (channel: MaterialChannel, enabled: boolean) => void;
  requestBakeDecal: () => void;
  resetForModel: () => void;
}

// Selector functions let React components subscribe only to values they use.
export const useEditorStore = create<EditorState>((set) => ({
  modelName: "Built-in Material Sphere",
  viewportStatus: { kind: "ready", message: "3D viewport ready" },
  pickedUv: null,
  activeSurface: null,
  activeMask: null,
  activeTextureSet: null,
  toolMode: "orbit",
  activeChannel: "baseColor",
  brushSettings: {
    radiusPx: 36,
    hardness: 0.72,
    innerReferencePx: 4,
    outerReferencePx: 12,
  },
  pbrSettings: {
    baseColor: "#aeb8c6",
    roughness: 0.32,
    metallic: 0.05,
    normalScale: 1,
  },
  lightingSettings: {
    environmentColor: "#ddeeff",
    environmentIntensity: 1.55,
    directionalColor: "#ffffff",
    directionalIntensity: 3.2,
    directionalAzimuthDeg: 38,
    directionalElevationDeg: 48,
  },
  colorAdjustment: {
    hueDegrees: 0,
    saturation: 1,
    brightness: 1,
    contrast: 1,
    strength: 1,
  },
  clearMaskToken: 0,
  channelResetRequest: null,
  channelExportRequest: null,
  captureSummary: null,
  captureActorVisible: true,
  captureTransformMode: "translate",
  createCaptureToken: 0,
  captureUpdate: null,
  captureUpdateToken: 0,
  decalSummary: null,
  activeDecalChannel: "baseColor",
  decalActorVisible: true,
  decalPreviewVisible: true,
  createDecalToken: 0,
  decalMaskEnabled: true,
  decalMaskUpdateToken: 0,
  decalChannelUpdate: null,
  bakeDecalToken: 0,

  setModelName: (modelName) => set({ modelName }),
  setViewportStatus: (viewportStatus) => set({ viewportStatus }),
  setSurfaceHit: (activeSurface) => set((state) => ({
    activeSurface,
    pickedUv: activeSurface?.uv ?? null,
    pbrSettings: activeSurface?.pbrSettings ?? state.pbrSettings,
  })),
  setActiveMask: (activeMask) => set({ activeMask }),
  setActiveTextureSet: (activeTextureSet) => set({ activeTextureSet }),
  setToolMode: (toolMode) => set({ toolMode }),
  setActiveChannel: (activeChannel) => set({ activeChannel }),
  patchBrushSettings: (settings) => set((state) => ({
    brushSettings: { ...state.brushSettings, ...settings },
  })),
  patchPbrSettings: (settings) => set((state) => ({
    pbrSettings: { ...state.pbrSettings, ...settings },
  })),
  patchLightingSettings: (settings) => set((state) => ({
    lightingSettings: { ...state.lightingSettings, ...settings },
  })),
  patchColorAdjustment: (settings) => set((state) => ({
    colorAdjustment: { ...state.colorAdjustment, ...settings },
  })),
  requestClearMask: () => set((state) => ({ clearMaskToken: state.clearMaskToken + 1 })),
  requestResetChannel: (materialId, channel) => set((state) => ({
    channelResetRequest: {
      materialId,
      channel,
      token: (state.channelResetRequest?.token ?? 0) + 1,
    },
    ...(channel === "baseColor" ? {
      colorAdjustment: {
        hueDegrees: 0,
        saturation: 1,
        brightness: 1,
        contrast: 1,
        strength: 1,
      },
    } : {}),
  })),
  requestExportChannel: (materialId, channel) => set((state) => ({
    channelExportRequest: {
      materialId,
      channel,
      token: (state.channelExportRequest?.token ?? 0) + 1,
    },
  })),
  setCaptureSummary: (captureSummary) => set({ captureSummary }),
  setCaptureActorVisible: (captureActorVisible) => set({ captureActorVisible }),
  setCaptureTransformMode: (captureTransformMode) => set({ captureTransformMode }),
  requestCreateCapture: () => set((state) => ({
    createCaptureToken: state.createCaptureToken + 1,
  })),
  requestCaptureUpdate: (captureUpdate) => set((state) => ({
    captureUpdate,
    captureUpdateToken: state.captureUpdateToken + 1,
  })),
  setDecalSummary: (decalSummary) => set((state) => ({
    decalSummary,
    decalMaskEnabled: decalSummary?.useCaptureMask ?? state.decalMaskEnabled,
  })),
  setActiveDecalChannel: (activeDecalChannel) => set({ activeDecalChannel }),
  setDecalActorVisible: (decalActorVisible) => set({ decalActorVisible }),
  setDecalPreviewVisible: (decalPreviewVisible) => set({ decalPreviewVisible }),
  requestCreateDecal: () => set((state) => ({
    createDecalToken: state.createDecalToken + 1,
  })),
  setDecalMaskEnabled: (decalMaskEnabled) => set((state) => ({
    decalMaskEnabled,
    decalMaskUpdateToken: state.decalMaskUpdateToken + 1,
  })),
  setDecalChannelEnabled: (channel, enabled) => set((state) => ({
    decalSummary: state.decalSummary ? {
      ...state.decalSummary,
      channels: {
        ...state.decalSummary.channels,
        [channel]: { ...state.decalSummary.channels[channel], enabled },
      },
    } : null,
    decalChannelUpdate: {
      channel,
      enabled,
      token: (state.decalChannelUpdate?.token ?? 0) + 1,
    },
  })),
  requestBakeDecal: () => set((state) => ({
    bakeDecalToken: state.bakeDecalToken + 1,
  })),
  resetForModel: () => set({
    pickedUv: null,
    activeSurface: null,
    activeMask: null,
    activeTextureSet: null,
    toolMode: "orbit",
    captureSummary: null,
    captureActorVisible: true,
    captureTransformMode: "translate",
    captureUpdate: null,
    decalSummary: null,
    activeDecalChannel: "baseColor",
    decalActorVisible: true,
    decalPreviewVisible: true,
    decalMaskEnabled: true,
    decalChannelUpdate: null,
    colorAdjustment: {
      hueDegrees: 0,
      saturation: 1,
      brightness: 1,
      contrast: 1,
      strength: 1,
    },
  }),
}));
