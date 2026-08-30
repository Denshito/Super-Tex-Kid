import { useEffect, useRef } from "react";
import { useEditorStore } from "../../state/editorStore";
import type { MaterialChannel } from "../../types/editor";
import { ThreeViewport } from "./ThreeViewport";

export interface TextureImportRequest {
  id: number;
  materialId: string;
  channel: MaterialChannel;
  file: File;
}

export interface DecalImportRequest {
  id: number;
  file: File;
}

interface Viewport3DProps {
  /** The latest GLB selected through the editor shell. */
  modelFile: File | null;
  /** One-shot texture request addressed to a specific material UUID. */
  textureImport: TextureImportRequest | null;
  decalImport: DecalImportRequest | null;
}

/**
 * Bridges React's declarative lifecycle to the imperative ThreeViewport class.
 *
 * React owns the host element and selected File. ThreeViewport owns everything
 * rendered inside the host. Zustand carries events back to the rest of the UI
 * without putting mutable Three.js objects into React state.
 */
export function Viewport3D({ modelFile, textureImport, decalImport }: Viewport3DProps) {
  // hostRef points to the element that receives the WebGL canvas.
  // viewportRef holds a mutable service object and must not trigger rendering.
  const hostRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<ThreeViewport | null>(null);
  const setModelName = useEditorStore((state) => state.setModelName);
  const setSurfaceHit = useEditorStore((state) => state.setSurfaceHit);
  const setActiveMask = useEditorStore((state) => state.setActiveMask);
  const setActiveTextureSet = useEditorStore((state) => state.setActiveTextureSet);
  const setCaptureSummary = useEditorStore((state) => state.setCaptureSummary);
  const setCaptureActorVisible = useEditorStore((state) => state.setCaptureActorVisible);
  const setDecalSummary = useEditorStore((state) => state.setDecalSummary);
  const setDecalActorVisible = useEditorStore((state) => state.setDecalActorVisible);
  const setDecalPreviewVisible = useEditorStore((state) => state.setDecalPreviewVisible);
  const setViewportStatus = useEditorStore((state) => state.setViewportStatus);
  const patchColorAdjustment = useEditorStore((state) => state.patchColorAdjustment);
  const resetForModel = useEditorStore((state) => state.resetForModel);
  const toolMode = useEditorStore((state) => state.toolMode);
  const brushSettings = useEditorStore((state) => state.brushSettings);
  const pbrSettings = useEditorStore((state) => state.pbrSettings);
  const lightingSettings = useEditorStore((state) => state.lightingSettings);
  const colorAdjustment = useEditorStore((state) => state.colorAdjustment);
  const activeMaterialId = useEditorStore((state) => state.activeSurface?.materialId ?? null);
  const clearMaskToken = useEditorStore((state) => state.clearMaskToken);
  const resetBaseColorToken = useEditorStore((state) => state.resetBaseColorToken);
  const exportBaseColorToken = useEditorStore((state) => state.exportBaseColorToken);
  const captureTransformMode = useEditorStore((state) => state.captureTransformMode);
  const captureActorVisible = useEditorStore((state) => state.captureActorVisible);
  const createCaptureToken = useEditorStore((state) => state.createCaptureToken);
  const captureUpdate = useEditorStore((state) => state.captureUpdate);
  const captureUpdateToken = useEditorStore((state) => state.captureUpdateToken);
  const createDecalToken = useEditorStore((state) => state.createDecalToken);
  const decalMaskEnabled = useEditorStore((state) => state.decalMaskEnabled);
  const decalActorVisible = useEditorStore((state) => state.decalActorVisible);
  const decalPreviewVisible = useEditorStore((state) => state.decalPreviewVisible);
  const decalMaskUpdateToken = useEditorStore((state) => state.decalMaskUpdateToken);
  const bakeDecalToken = useEditorStore((state) => state.bakeDecalToken);

  useEffect(() => {
    if (!hostRef.current) return;

    // Create one viewport for this mounted host. Cleanup is essential because
    // React Strict Mode deliberately replays effects in development.
    const viewport = new ThreeViewport(hostRef.current, {
      onSurfaceHit: setSurfaceHit,
      onMaskChanged: setActiveMask,
      onTextureSetChanged: setActiveTextureSet,
      onCaptureChanged: setCaptureSummary,
      onDecalChanged: setDecalSummary,
      onDecalBaked: (result) => {
        setDecalPreviewVisible(false);
        setViewportStatus({
          kind: "ready",
          message: `Decal baked to ${result.width} × ${result.height} Base Color`,
        });
        patchColorAdjustment({
          hueDegrees: 0,
          saturation: 1,
          brightness: 1,
          contrast: 1,
          strength: 1,
        });
      },
      onCaptureError: (message) => setViewportStatus({
        kind: "error",
        message: `Projection capture failed: ${message}`,
      }),
    });
    viewportRef.current = viewport;
    return () => {
      viewport.dispose();
      viewportRef.current = null;
    };
  }, [patchColorAdjustment, setActiveMask, setActiveTextureSet, setCaptureSummary, setDecalPreviewVisible, setDecalSummary, setSurfaceHit, setViewportStatus]);

  useEffect(() => {
    viewportRef.current?.setToolMode(toolMode);
  }, [toolMode]);

  useEffect(() => {
    viewportRef.current?.setCaptureTransformMode(captureTransformMode);
  }, [captureTransformMode]);

  useEffect(() => {
    viewportRef.current?.setCaptureActorVisible(captureActorVisible);
  }, [captureActorVisible]);

  useEffect(() => {
    viewportRef.current?.setDecalActorVisible(decalActorVisible);
  }, [decalActorVisible]);

  useEffect(() => {
    viewportRef.current?.setDecalPreviewVisible(decalPreviewVisible);
  }, [decalPreviewVisible]);

  useEffect(() => {
    if (createCaptureToken <= 0 || !viewportRef.current) return;
    const created = viewportRef.current.createCaptureActor();
    if (created) setCaptureActorVisible(true);
    setViewportStatus(created
      ? { kind: "ready", message: "Capture Actor created from the painted surface selection" }
      : { kind: "error", message: "Paint a non-empty surface selection before creating a Capture Actor" });
  }, [createCaptureToken, setCaptureActorVisible, setViewportStatus]);

  useEffect(() => {
    if (captureUpdateToken <= 0 || !captureUpdate) return;
    viewportRef.current?.updateCaptureSettings(captureUpdate);
  }, [captureUpdate, captureUpdateToken]);

  useEffect(() => {
    if (createDecalToken <= 0 || !viewportRef.current) return;
    const created = viewportRef.current.createDecalActor();
    if (created) {
      setCaptureActorVisible(false);
      setDecalActorVisible(true);
      setDecalPreviewVisible(true);
    }
    setViewportStatus(created
      ? { kind: "ready", message: "Decal Actor created from the latest projection capture" }
      : { kind: "error", message: "Create and finish a Projection Capture before creating a Decal" });
  }, [createDecalToken, setCaptureActorVisible, setDecalActorVisible, setDecalPreviewVisible, setViewportStatus]);

  useEffect(() => {
    if (decalMaskUpdateToken <= 0) return;
    viewportRef.current?.setDecalUseCaptureMask(decalMaskEnabled);
  }, [decalMaskEnabled, decalMaskUpdateToken]);

  useEffect(() => {
    if (bakeDecalToken <= 0 || !viewportRef.current) return;
    try {
      viewportRef.current.bakeDecal();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      setViewportStatus({ kind: "error", message: `Decal bake failed: ${message}` });
    }
  }, [bakeDecalToken, setViewportStatus]);

  useEffect(() => {
    viewportRef.current?.setBrushSettings(brushSettings);
  }, [brushSettings]);

  useEffect(() => {
    viewportRef.current?.setPbrMaterialSettings(activeMaterialId, pbrSettings);
  }, [activeMaterialId, pbrSettings]);

  useEffect(() => {
    viewportRef.current?.setLightingSettings(lightingSettings);
  }, [lightingSettings]);

  useEffect(() => {
    viewportRef.current?.setBaseColorAdjustment(activeMaterialId, colorAdjustment);
  }, [activeMaterialId, colorAdjustment]);

  useEffect(() => {
    if (resetBaseColorToken > 0) {
      viewportRef.current?.resetBaseColorAdjustment(activeMaterialId);
    }
  }, [resetBaseColorToken]);

  useEffect(() => {
    if (exportBaseColorToken <= 0 || !viewportRef.current) return;
    viewportRef.current.exportBaseColor(activeMaterialId, colorAdjustment)
      .then((exported) => setViewportStatus(exported
        ? { kind: "ready", message: "Browser download started — check your default Downloads folder" }
        : { kind: "error", message: "Export requires a Base Color texture and selection mask" }))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        setViewportStatus({ kind: "error", message: `Base Color export failed: ${message}` });
      });
  }, [exportBaseColorToken, setViewportStatus]);

  useEffect(() => {
    if (!textureImport || !viewportRef.current) return;
    let cancelled = false;
    setViewportStatus({ kind: "loading", message: `Loading ${textureImport.file.name}` });
    viewportRef.current.importMaterialTexture(
      textureImport.materialId,
      textureImport.channel,
      textureImport.file,
    ).then(() => {
      if (!cancelled) {
        setViewportStatus({
          kind: "ready",
          message: `${textureImport.channel} texture applied to selected material`,
        });
      }
    }).catch((error: unknown) => {
      if (cancelled) return;
      const message = error instanceof Error ? error.message : String(error);
      setViewportStatus({ kind: "error", message: `Texture import failed: ${message}` });
    });
    return () => { cancelled = true; };
  }, [setViewportStatus, textureImport]);

  useEffect(() => {
    if (!decalImport || !viewportRef.current) return;
    let cancelled = false;
    setViewportStatus({ kind: "loading", message: `Loading Decal ${decalImport.file.name}` });
    viewportRef.current.setDecalImage({
      blob: decalImport.file,
      label: decalImport.file.name,
      origin: "file",
    }).then(() => {
      if (!cancelled) setViewportStatus({ kind: "ready", message: "Decal image applied" });
    }).catch((error: unknown) => {
      if (cancelled) return;
      const message = error instanceof Error ? error.message : String(error);
      setViewportStatus({ kind: "error", message: `Decal import failed: ${message}` });
    });
    return () => { cancelled = true; };
  }, [decalImport, setViewportStatus]);

  useEffect(() => {
    if (clearMaskToken > 0) viewportRef.current?.clearActiveMask();
  }, [clearMaskToken]);

  useEffect(() => {
    if (!modelFile || !viewportRef.current) return;

    // GLB is supported first because it embeds geometry, buffers, and textures
    // in one file. Standalone .gltf often depends on inaccessible sibling files.
    if (!modelFile.name.toLowerCase().endsWith(".glb")) {
      setViewportStatus({ kind: "error", message: "This stage supports standalone .glb files only" });
      return;
    }

    // File.arrayBuffer() passes data directly to GLTFLoader and avoids managing
    // a temporary object URL. The cancellation flag blocks stale UI updates if
    // another file is selected before parsing finishes.
    let cancelled = false;
    setViewportStatus({ kind: "loading", message: `Loading ${modelFile.name}` });
    resetForModel();
    modelFile.arrayBuffer()
      .then((buffer) => viewportRef.current?.loadGlb(buffer))
      .then(() => {
        if (cancelled) return;
        setModelName(modelFile.name);
        setViewportStatus({ kind: "ready", message: "Model loaded — click a surface to inspect its UV" });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setViewportStatus({ kind: "error", message: `Model load failed: ${message}` });
      });
    // Parsing itself is not aborted, but an obsolete promise cannot overwrite
    // the current model name or status after this effect has been replaced.
    return () => { cancelled = true; };
  }, [modelFile, resetForModel, setModelName, setViewportStatus]);

  return <div ref={hostRef} className="viewport-host" aria-label="3D model viewport" />;
}
