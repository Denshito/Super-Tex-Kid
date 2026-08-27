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

interface Viewport3DProps {
  /** The latest GLB selected through the editor shell. */
  modelFile: File | null;
  /** One-shot texture request addressed to a specific material UUID. */
  textureImport: TextureImportRequest | null;
}

/**
 * Bridges React's declarative lifecycle to the imperative ThreeViewport class.
 *
 * React owns the host element and selected File. ThreeViewport owns everything
 * rendered inside the host. Zustand carries events back to the rest of the UI
 * without putting mutable Three.js objects into React state.
 */
export function Viewport3D({ modelFile, textureImport }: Viewport3DProps) {
  // hostRef points to the element that receives the WebGL canvas.
  // viewportRef holds a mutable service object and must not trigger rendering.
  const hostRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<ThreeViewport | null>(null);
  const setModelName = useEditorStore((state) => state.setModelName);
  const setSurfaceHit = useEditorStore((state) => state.setSurfaceHit);
  const setActiveMask = useEditorStore((state) => state.setActiveMask);
  const setViewportStatus = useEditorStore((state) => state.setViewportStatus);
  const resetForModel = useEditorStore((state) => state.resetForModel);
  const toolMode = useEditorStore((state) => state.toolMode);
  const brushSettings = useEditorStore((state) => state.brushSettings);
  const pbrSettings = useEditorStore((state) => state.pbrSettings);
  const lightingSettings = useEditorStore((state) => state.lightingSettings);
  const activeMaterialId = useEditorStore((state) => state.activeSurface?.materialId ?? null);
  const clearMaskToken = useEditorStore((state) => state.clearMaskToken);

  useEffect(() => {
    if (!hostRef.current) return;

    // Create one viewport for this mounted host. Cleanup is essential because
    // React Strict Mode deliberately replays effects in development.
    const viewport = new ThreeViewport(hostRef.current, {
      onSurfaceHit: setSurfaceHit,
      onMaskChanged: setActiveMask,
    });
    viewportRef.current = viewport;
    return () => {
      viewport.dispose();
      viewportRef.current = null;
    };
  }, [setActiveMask, setSurfaceHit]);

  useEffect(() => {
    viewportRef.current?.setToolMode(toolMode);
  }, [toolMode]);

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
    if (clearMaskToken > 0) viewportRef.current?.clearActiveMask();
  }, [clearMaskToken]);

  useEffect(() => {
    if (!modelFile || !viewportRef.current) return;

    // GLB is supported first because it embeds geometry, buffers, and textures
    // in one file. Standalone .gltf often depends on inaccessible sibling files.
    if (!modelFile.name.toLowerCase().endsWith(".glb")) {
      setViewportStatus({ kind: "error", message: "当前阶段仅支持独立的 .glb 文件" });
      return;
    }

    // File.arrayBuffer() passes data directly to GLTFLoader and avoids managing
    // a temporary object URL. The cancellation flag blocks stale UI updates if
    // another file is selected before parsing finishes.
    let cancelled = false;
    setViewportStatus({ kind: "loading", message: `正在加载 ${modelFile.name}` });
    resetForModel();
    modelFile.arrayBuffer()
      .then((buffer) => viewportRef.current?.loadGlb(buffer))
      .then(() => {
        if (cancelled) return;
        setModelName(modelFile.name);
        setViewportStatus({ kind: "ready", message: "模型加载完成，可点击表面读取 UV" });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setViewportStatus({ kind: "error", message: `模型加载失败：${message}` });
      });
    // Parsing itself is not aborted, but an obsolete promise cannot overwrite
    // the current model name or status after this effect has been replaced.
    return () => { cancelled = true; };
  }, [modelFile, resetForModel, setModelName, setViewportStatus]);

  return <div ref={hostRef} className="viewport-host" aria-label="3D 模型视口" />;
}
