import { create } from "zustand";
import type {
  BrushSettings,
  LightingSettings,
  MaskSummary,
  MaterialChannel,
  PbrMaterialSettings,
  SurfaceHitSummary,
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
  toolMode: ToolMode;
  activeChannel: MaterialChannel;
  brushSettings: BrushSettings;
  pbrSettings: PbrMaterialSettings;
  lightingSettings: LightingSettings;
  clearMaskToken: number;

  setModelName: (modelName: string) => void;
  setViewportStatus: (viewportStatus: ViewportStatus) => void;
  setSurfaceHit: (surface: SurfaceHitSummary | null) => void;
  setActiveMask: (mask: MaskSummary | null) => void;
  setToolMode: (toolMode: ToolMode) => void;
  setActiveChannel: (activeChannel: MaterialChannel) => void;
  patchBrushSettings: (settings: Partial<BrushSettings>) => void;
  patchPbrSettings: (settings: Partial<PbrMaterialSettings>) => void;
  patchLightingSettings: (settings: Partial<LightingSettings>) => void;
  requestClearMask: () => void;
  resetForModel: () => void;
}

// Selector functions let React components subscribe only to values they use.
export const useEditorStore = create<EditorState>((set) => ({
  modelName: "内置材质球",
  viewportStatus: { kind: "ready", message: "3D 视口已就绪" },
  pickedUv: null,
  activeSurface: null,
  activeMask: null,
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
  clearMaskToken: 0,

  setModelName: (modelName) => set({ modelName }),
  setViewportStatus: (viewportStatus) => set({ viewportStatus }),
  setSurfaceHit: (activeSurface) => set((state) => ({
    activeSurface,
    pickedUv: activeSurface?.uv ?? null,
    pbrSettings: activeSurface?.pbrSettings ?? state.pbrSettings,
  })),
  setActiveMask: (activeMask) => set({ activeMask }),
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
  requestClearMask: () => set((state) => ({ clearMaskToken: state.clearMaskToken + 1 })),
  resetForModel: () => set({
    pickedUv: null,
    activeSurface: null,
    activeMask: null,
    toolMode: "orbit",
  }),
}));
