import { useEffect, useRef, useState } from "react";
import {
  Viewport3D,
  type DecalImportRequest,
  type TextureImportRequest,
} from "./features/viewport/Viewport3D";
import { useEditorStore } from "./state/editorStore";
import type { CaptureTransformMode, MaterialChannel } from "./types/editor";
import "./App.css";

const TRANSFORM_MODES: readonly [CaptureTransformMode, "W" | "E" | "R"][] = [
  ["translate", "W"],
  ["rotate", "E"],
  ["scale", "R"],
];

/**
 * Top-level desktop editor shell.
 *
 * This component owns file selection and layout composition. Rendering details
 * remain inside Viewport3D, while cross-panel values come from Zustand.
 */
function App() {
  // The file input stays visually hidden; the toolbar button opens the native
  // picker. modelFile is intentionally local because the File object belongs to
  // this browser session and should not be serialized into project state.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textureInputRef = useRef<HTMLInputElement>(null);
  const decalInputRef = useRef<HTMLInputElement>(null);
  const textureTargetRef = useRef<{ materialId: string; channel: MaterialChannel } | null>(null);
  const textureRequestIdRef = useRef(0);
  const decalRequestIdRef = useRef(0);
  const [modelFile, setModelFile] = useState<File | null>(null);
  const [textureImport, setTextureImport] = useState<TextureImportRequest | null>(null);
  const [decalImport, setDecalImport] = useState<DecalImportRequest | null>(null);

  // Subscribe to individual store slices so unrelated state changes do not
  // redraw the entire editor shell.
  const modelName = useEditorStore((state) => state.modelName);
  const viewportStatus = useEditorStore((state) => state.viewportStatus);
  const pickedUv = useEditorStore((state) => state.pickedUv);
  const activeSurface = useEditorStore((state) => state.activeSurface);
  const activeMask = useEditorStore((state) => state.activeMask);
  const activeTextureSet = useEditorStore((state) => state.activeTextureSet);
  const toolMode = useEditorStore((state) => state.toolMode);
  const activeChannel = useEditorStore((state) => state.activeChannel);
  const brushSettings = useEditorStore((state) => state.brushSettings);
  const pbrSettings = useEditorStore((state) => state.pbrSettings);
  const lightingSettings = useEditorStore((state) => state.lightingSettings);
  const colorAdjustment = useEditorStore((state) => state.colorAdjustment);
  const captureSummary = useEditorStore((state) => state.captureSummary);
  const captureActorVisible = useEditorStore((state) => state.captureActorVisible);
  const captureTransformMode = useEditorStore((state) => state.captureTransformMode);
  const decalSummary = useEditorStore((state) => state.decalSummary);
  const decalActorVisible = useEditorStore((state) => state.decalActorVisible);
  const decalPreviewVisible = useEditorStore((state) => state.decalPreviewVisible);
  const decalMaskEnabled = useEditorStore((state) => state.decalMaskEnabled);
  const setToolMode = useEditorStore((state) => state.setToolMode);
  const setActiveChannel = useEditorStore((state) => state.setActiveChannel);
  const patchBrushSettings = useEditorStore((state) => state.patchBrushSettings);
  const patchPbrSettings = useEditorStore((state) => state.patchPbrSettings);
  const patchLightingSettings = useEditorStore((state) => state.patchLightingSettings);
  const patchColorAdjustment = useEditorStore((state) => state.patchColorAdjustment);
  const requestClearMask = useEditorStore((state) => state.requestClearMask);
  const requestResetBaseColor = useEditorStore((state) => state.requestResetBaseColor);
  const requestExportBaseColor = useEditorStore((state) => state.requestExportBaseColor);
  const setCaptureTransformMode = useEditorStore((state) => state.setCaptureTransformMode);
  const requestCreateCapture = useEditorStore((state) => state.requestCreateCapture);
  const setCaptureActorVisible = useEditorStore((state) => state.setCaptureActorVisible);
  const requestCaptureUpdate = useEditorStore((state) => state.requestCaptureUpdate);
  const requestCreateDecal = useEditorStore((state) => state.requestCreateDecal);
  const setDecalActorVisible = useEditorStore((state) => state.setDecalActorVisible);
  const setDecalPreviewVisible = useEditorStore((state) => state.setDecalPreviewVisible);
  const setDecalMaskEnabled = useEditorStore((state) => state.setDecalMaskEnabled);
  const requestBakeDecal = useEditorStore((state) => state.requestBakeDecal);

  const canAdjustBaseColor = Boolean(
    activeTextureSet?.channels.baseColor.isLoaded && activeMask?.hasContent,
  );

  const patchCaptureSettings = (
    patch: Partial<{ near: number; far: number; resolution: number }>,
  ): void => {
    if (!captureSummary) return;
    requestCaptureUpdate({
      near: captureSummary.near,
      far: captureSummary.far,
      resolution: captureSummary.resolution,
      ...patch,
    });
  };

  /** Normalizes file-picker and drag-and-drop input into one state update. */
  const chooseModel = (file: File | undefined): void => {
    if (file) setModelFile(file);
  };

  /** Opens one image picker and remembers the exact material/channel target. */
  const chooseTexture = (channel: MaterialChannel): void => {
    if (!activeSurface || !textureInputRef.current) return;
    textureTargetRef.current = { materialId: activeSurface.materialId, channel };
    textureInputRef.current.value = "";
    textureInputRef.current.click();
  };

  useEffect(() => {
    const handleTransformShortcut = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (
        target.isContentEditable
        || Boolean(target.closest("input, textarea, select, button, [contenteditable='true']"))
      )) return;

      const actorReady = toolMode === "capture"
        ? Boolean(captureSummary && captureActorVisible)
        : toolMode === "decal"
          ? Boolean(decalSummary && decalActorVisible)
          : false;
      if (!actorReady) return;
      const modeByCode: Partial<Record<KeyboardEvent["code"], CaptureTransformMode>> = {
        KeyW: "translate",
        KeyE: "rotate",
        KeyR: "scale",
      };
      const mode = modeByCode[event.code];
      if (!mode) return;
      event.preventDefault();
      setCaptureTransformMode(mode);
    };
    window.addEventListener("keydown", handleTransformShortcut);
    return () => window.removeEventListener("keydown", handleTransformShortcut);
  }, [
    captureActorVisible,
    captureSummary,
    decalActorVisible,
    decalSummary,
    setCaptureTransformMode,
    toolMode,
  ]);

  return (
    <main
      className="editor-shell"
      // Preventing the default drag behavior allows files to be dropped anywhere
      // on the editor instead of being opened as a new WebView document.
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        chooseModel(event.dataTransfer.files[0]);
      }}
    >
      <header className="app-bar">
        <div className="brand">
          <span className="brand-mark">STK</span>
          <div>
            <strong>Super Tex Kid</strong>
            <span>AI Texture Workspace</span>
          </div>
        </div>
        <div className="app-actions">
          {/* The browser reads the file; Tauri filesystem permissions are not
              needed for this first in-memory GLB import path. */}
          <input
            ref={fileInputRef}
            className="visually-hidden"
            type="file"
            accept=".glb,model/gltf-binary"
            onChange={(event) => chooseModel(event.currentTarget.files?.[0])}
          />
          <input
            ref={textureInputRef}
            className="visually-hidden"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/bmp"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              const target = textureTargetRef.current;
              if (!file || !target) return;
              textureRequestIdRef.current += 1;
              setTextureImport({
                id: textureRequestIdRef.current,
                materialId: target.materialId,
                channel: target.channel,
                file,
              });
            }}
          />
          <input
            ref={decalInputRef}
            className="visually-hidden"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/bmp"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (!file) return;
              decalRequestIdRef.current += 1;
              setDecalImport({ id: decalRequestIdRef.current, file });
            }}
          />
          <button className="button button-primary" onClick={() => fileInputRef.current?.click()}>
            Import GLB
          </button>
        </div>
      </header>

      <section className="workspace">
        <aside className="tool-rail" aria-label="Texture tools">
          <button
            className={`tool-button ${toolMode === "orbit" ? "is-active" : ""}`}
            title="Orbit mode"
            onClick={() => setToolMode("orbit")}
          >
            ◉
          </button>
          <button
            className={`tool-button ${toolMode === "brush" ? "is-active" : ""}`}
            title="Screen-space brush"
            onClick={() => setToolMode("brush")}
          >
            ✎
          </button>
          <button
            className={`tool-button ${toolMode === "capture" ? "is-active" : ""}`}
            title="Projection Capture Actor"
            disabled={!captureSummary}
            onClick={() => setToolMode("capture")}
          >
            C
          </button>
          <button
            className={`tool-button ${toolMode === "decal" ? "is-active" : ""}`}
            title="Decal Actor"
            disabled={!decalSummary}
            onClick={() => setToolMode("decal")}
          >
            D
          </button>
        </aside>

        <section className="viewport-panel">
          {/* Viewport3D owns the WebGL canvas inside this resizable center panel. */}
          <Viewport3D
            modelFile={modelFile}
            textureImport={textureImport}
            decalImport={decalImport}
          />
          {captureSummary && (
            <section className="capture-preview-window" aria-label="Projection capture preview">
              <div className="capture-preview-header">
                <div>
                  <span>CAPTURE PREVIEW</span>
                  <b>{captureSummary.resolution} × {captureSummary.resolution}</b>
                </div>
                <span className="live-badge">LIVE</span>
              </div>
              <div className="capture-preview-main checkerboard">
                <img src={captureSummary.compositePreviewDataUrl} alt="Surface capture with selection overlay" />
              </div>
              <div className="capture-preview-passes">
                <figure>
                  <img src={captureSummary.baseColorPreviewDataUrl} alt="Captured unlit Base Color" />
                  <figcaption>Base Color</figcaption>
                </figure>
                <figure>
                  <img src={captureSummary.roughnessPreviewDataUrl} alt="Captured Roughness" />
                  <figcaption>Roughness</figcaption>
                </figure>
                <figure>
                  <img src={captureSummary.materialNormalPreviewDataUrl} alt="Captured tangent-space material Normal" />
                  <figcaption>Material Normal</figcaption>
                </figure>
                <figure>
                  <img src={captureSummary.metallicPreviewDataUrl} alt="Captured Metallic" />
                  <figcaption>Metallic</figcaption>
                </figure>
                <figure>
                  <img src={captureSummary.maskPreviewDataUrl} alt="Captured selection mask" />
                  <figcaption>Mask</figcaption>
                </figure>
                <figure>
                  <img src={captureSummary.viewNormalPreviewDataUrl} alt="Captured view-space geometry Normal" />
                  <figcaption>View Normal</figcaption>
                </figure>
                <figure>
                  <img src={captureSummary.linearDepthPreviewDataUrl} alt="Captured linear camera depth" />
                  <figcaption>Linear Depth</figcaption>
                </figure>
              </div>
            </section>
          )}
          <div className="viewport-hint">
            {toolMode === "brush"
              ? "Brush mode · Drag across visible surfaces · Each stroke locks one material"
              : toolMode === "capture"
                ? "Capture Actor · W Move · E Rotate · R Scale"
                : toolMode === "decal"
                  ? "Decal Actor · W Move · E Rotate · R Scale"
                  : "Left drag orbit · Right drag pan · Wheel zoom · Click a surface to inspect UV"}
          </div>
        </section>

        <aside className="inspector" aria-label="Inspector">
          <details className="inspector-section" open>
            <summary>
              <span className="section-title">Asset &amp; Surface</span>
              <span className="section-meta">{activeSurface?.materialName ?? "No surface"}</span>
            </summary>
            <div className="panel-section">
              <div className="inspector-subsection">
                <p className="eyebrow">Asset</p>
                <h2>{modelName}</h2>
                <dl className="property-list">
                  <div><dt>Renderer</dt><dd>Three.js / WebGL</dd></div>
                  <div><dt>Color Space</dt><dd>sRGB</dd></div>
                  <div><dt>Material Model</dt><dd>Metallic / Roughness</dd></div>
                </dl>
              </div>
              <div className="inspector-subsection">
                <p className="eyebrow">Picked Surface</p>
                <h3>{activeSurface?.materialName ?? "No material selected"}</h3>
                {pickedUv ? (
                  <>
                    <div className="surface-meta">
                      <span>{activeSurface?.meshName}</span>
                      <span>Slot {activeSurface?.materialIndex}</span>
                    </div>
                    <div className="uv-readout">
                      <span>U&nbsp; {pickedUv.u.toFixed(4)}</span>
                      <span>V&nbsp; {pickedUv.v.toFixed(4)}</span>
                    </div>
                  </>
                ) : (
                  <p className="empty-copy">Click a model surface to inspect its UV coordinates.</p>
                )}
              </div>
              <div className="inspector-subsection">
                <p className="eyebrow">Target Channel</p>
                <select
                  className="select-control"
                  value={activeChannel}
                  onChange={(event) => setActiveChannel(event.currentTarget.value as typeof activeChannel)}
                >
                  <option value="baseColor">Base Color</option>
                  <option value="normal">Normal</option>
                  <option value="roughness">Roughness</option>
                  <option value="metallic">Metallic</option>
                </select>
                <p className="field-note">The selection belongs to the current Texture Set and can be reused across channels.</p>
              </div>
            </div>
          </details>

          <details className="inspector-section" open>
            <summary>
              <span className="section-title">Selection</span>
              <span className="section-meta">{activeMask?.hasContent ? `${activeMask.width} × ${activeMask.height}` : "Empty"}</span>
            </summary>
            <div className="panel-section">
              <div className="inspector-subsection">
                <p className="eyebrow">Screen-Space Brush</p>
                <label className="range-field">
                  <span>Radius <b>{brushSettings.radiusPx}px</b></span>
                  <input type="range" min="8" max="120" value={brushSettings.radiusPx}
                    onChange={(event) => patchBrushSettings({ radiusPx: Number(event.currentTarget.value) })} />
                </label>
                <label className="range-field">
                  <span>Hardness <b>{Math.round(brushSettings.hardness * 100)}%</b></span>
                  <input type="range" min="0.1" max="0.95" step="0.05" value={brushSettings.hardness}
                    onChange={(event) => patchBrushSettings({ hardness: Number(event.currentTarget.value) })} />
                </label>
                <div className="threshold-grid">
                  <label>Inner Reference
                    <input type="number" min="0" max="64" value={brushSettings.innerReferencePx}
                      onChange={(event) => patchBrushSettings({ innerReferencePx: Number(event.currentTarget.value) })} />
                  </label>
                  <label>Outer Reference
                    <input type="number" min="0" max="128" value={brushSettings.outerReferencePx}
                      onChange={(event) => patchBrushSettings({ outerReferencePx: Number(event.currentTarget.value) })} />
                  </label>
                </div>
              </div>
              <div className="inspector-subsection">
                <div className="section-heading-row">
                  <p className="eyebrow">Selection Mask</p>
                  <button className="text-button" disabled={!activeMask?.hasContent} onClick={requestClearMask}>Clear</button>
                </div>
                {activeMask ? (
                  <>
                    <div className="mask-preview checkerboard">
                      <img src={activeMask.previewDataUrl} alt={`${activeMask.materialName} selection mask`} />
                    </div>
                    <p className="mask-resolution">{activeMask.width} × {activeMask.height}</p>
                  </>
                ) : (
                  <p className="empty-copy">Switch to Brush mode and paint on the model surface.</p>
                )}
              </div>
            </div>
          </details>

          <details className="inspector-section" open>
            <summary>
              <span className="section-title">Projection Capture</span>
              <span className="section-meta">{captureSummary ? `${captureSummary.resolution}px` : "Not created"}</span>
            </summary>
            <div className="panel-section">
              <button className="button button-primary capture-create-button" disabled={!activeMask?.hasContent}
                onClick={() => { setToolMode("capture"); requestCreateCapture(); }}>
                {captureSummary ? "Rebuild from Selection" : "Create Capture Actor"}
              </button>
              <label className="capture-mask-toggle">
                <input type="checkbox" checked={captureActorVisible} disabled={!captureSummary}
                  onChange={(event) => setCaptureActorVisible(event.currentTarget.checked)} />
                Show Capture Actor
              </label>
              <div className="segmented-control" aria-label="Capture transform mode">
                {TRANSFORM_MODES.map(([mode, key]) => (
                  <button key={mode} className={captureTransformMode === mode ? "is-active" : ""}
                    aria-keyshortcuts={key} disabled={!captureSummary} onClick={() => setCaptureTransformMode(mode)}>
                    <kbd>{key}</kbd>{mode[0].toUpperCase() + mode.slice(1)}
                  </button>
                ))}
              </div>
              {captureSummary ? (
                <>
                  <div className="threshold-grid capture-number-grid">
                    <label>Near Plane
                      <input type="number" min="0.001" step="0.01" value={Number(captureSummary.near.toFixed(3))}
                        onChange={(event) => patchCaptureSettings({ near: Number(event.currentTarget.value) })} />
                    </label>
                    <label>Far Plane
                      <input type="number" min="0.002" step="0.05" value={Number(captureSummary.far.toFixed(3))}
                        onChange={(event) => patchCaptureSettings({ far: Number(event.currentTarget.value) })} />
                    </label>
                  </div>
                  <label className="capture-select-label">Preview Resolution
                    <select className="select-control" value={captureSummary.resolution}
                      onChange={(event) => patchCaptureSettings({ resolution: Number(event.currentTarget.value) })}>
                      <option value="256">256 × 256</option>
                      <option value="512">512 × 512</option>
                      <option value="1024">1024 × 1024</option>
                    </select>
                  </label>
                  <p className="capture-volume-readout">Box {captureSummary.width.toFixed(2)} × {captureSummary.height.toFixed(2)}</p>
                </>
              ) : (
                <p className="field-note">Paint a selection first. Its bounds and average normal seed the Actor.</p>
              )}
            </div>
          </details>

          <details className="inspector-section">
            <summary>
              <span className="section-title">Decal &amp; Bake</span>
              <span className="section-meta">{decalSummary?.sourceLabel ?? "Not created"}</span>
            </summary>
            <div className="panel-section">
              <button className="button button-primary capture-create-button" disabled={!captureSummary}
                onClick={() => { setToolMode("decal"); requestCreateDecal(); }}>
                {decalSummary ? "Rebuild Decal from Capture" : "Create Decal from Capture"}
              </button>
              <div className="segmented-control" aria-label="Decal transform mode">
                {TRANSFORM_MODES.map(([mode, key]) => (
                  <button key={mode} className={captureTransformMode === mode ? "is-active" : ""}
                    aria-keyshortcuts={key} disabled={!decalSummary} onClick={() => setCaptureTransformMode(mode)}>
                    <kbd>{key}</kbd>{mode[0].toUpperCase() + mode.slice(1)}
                  </button>
                ))}
              </div>
              {decalSummary ? (
                <>
                  <div className="mask-preview checkerboard">
                    <img src={decalSummary.previewDataUrl} alt="Current Decal source" />
                  </div>
                  <p className="field-note">{decalSummary.sourceLabel} · {decalSummary.sourceOrigin}</p>
                  <button className="button full-width-button" onClick={() => {
                    if (!decalInputRef.current) return;
                    decalInputRef.current.value = "";
                    decalInputRef.current.click();
                  }}>Import Decal Image</button>
                  <label className="capture-mask-toggle">
                    <input type="checkbox" checked={decalMaskEnabled}
                      onChange={(event) => setDecalMaskEnabled(event.currentTarget.checked)} />Use Capture Mask
                  </label>
                  <label className="capture-mask-toggle">
                    <input type="checkbox" checked={decalActorVisible}
                      onChange={(event) => setDecalActorVisible(event.currentTarget.checked)} />Show Decal Actor
                  </label>
                  <label className="capture-mask-toggle">
                    <input type="checkbox" checked={decalPreviewVisible}
                      onChange={(event) => setDecalPreviewVisible(event.currentTarget.checked)} />Show Decal Preview
                  </label>
                  <p className="capture-volume-readout">Box {decalSummary.width.toFixed(2)} × {decalSummary.height.toFixed(2)}</p>
                  <div className="effect-actions decal-actions">
                    <button className="button button-primary" disabled={!activeTextureSet?.channels.baseColor.isLoaded}
                      onClick={requestBakeDecal}>Bake to BaseColor</button>
                    <button className="button" disabled={!activeTextureSet?.channels.baseColor.isModified}
                      onClick={requestResetBaseColor}>Reset Bake</button>
                    <button className="button" disabled={!activeTextureSet?.channels.baseColor.isLoaded}
                      onClick={requestExportBaseColor}>Export PNG</button>
                  </div>
                </>
              ) : (
                <p className="field-note">Finish a Capture first. The Decal inherits its projector transform and mask.</p>
              )}
            </div>
          </details>

          <details className="inspector-section">
            <summary>
              <span className="section-title">Material</span>
              <span className="section-meta">{activeTextureSet?.materialName ?? "No material"}</span>
            </summary>
            <div className="panel-section">
              <div className="inspector-subsection">
                <p className="eyebrow">PBR Texture Maps</p>
                <div className="texture-grid">
                  {([[
                    "baseColor", "Base Color",
                  ], ["roughness", "Roughness"], ["normal", "Normal"], ["metallic", "Metallic"]] as const)
                    .map(([channel, label]) => (
                      <button key={channel} className="texture-slot-button" disabled={!activeSurface}
                        onClick={() => chooseTexture(channel)}>
                        <span>{label}</span>
                        <b>{activeTextureSet?.channels[channel].fileName ?? "Import"}</b>
                      </button>
                    ))}
                </div>
                <p className="field-note">Maps affect only the selected material. Normal maps expect OpenGL +Y.</p>
              </div>
              <div className="inspector-subsection">
                <div className="section-heading-row"><p className="eyebrow">Local Base Color</p><span className="local-badge">LOCAL</span></div>
                <label className="range-field"><span>Hue <b>{colorAdjustment.hueDegrees}°</b></span>
                  <input type="range" min="-180" max="180" step="1" value={colorAdjustment.hueDegrees}
                    disabled={!canAdjustBaseColor} onChange={(event) => patchColorAdjustment({ hueDegrees: Number(event.currentTarget.value) })} />
                </label>
                <label className="range-field"><span>Saturation <b>{colorAdjustment.saturation.toFixed(2)}</b></span>
                  <input type="range" min="0" max="2" step="0.01" value={colorAdjustment.saturation}
                    disabled={!canAdjustBaseColor} onChange={(event) => patchColorAdjustment({ saturation: Number(event.currentTarget.value) })} />
                </label>
                <label className="range-field"><span>Brightness <b>{colorAdjustment.brightness.toFixed(2)}</b></span>
                  <input type="range" min="0" max="2" step="0.01" value={colorAdjustment.brightness}
                    disabled={!canAdjustBaseColor} onChange={(event) => patchColorAdjustment({ brightness: Number(event.currentTarget.value) })} />
                </label>
                <label className="range-field"><span>Contrast <b>{colorAdjustment.contrast.toFixed(2)}</b></span>
                  <input type="range" min="0" max="2" step="0.01" value={colorAdjustment.contrast}
                    disabled={!canAdjustBaseColor} onChange={(event) => patchColorAdjustment({ contrast: Number(event.currentTarget.value) })} />
                </label>
                <label className="range-field"><span>Effect Strength <b>{colorAdjustment.strength.toFixed(2)}</b></span>
                  <input type="range" min="0" max="1" step="0.01" value={colorAdjustment.strength}
                    disabled={!canAdjustBaseColor} onChange={(event) => patchColorAdjustment({ strength: Number(event.currentTarget.value) })} />
                </label>
                <div className="effect-actions">
                  <button className="button" disabled={!activeTextureSet?.channels.baseColor.isLoaded}
                    onClick={requestResetBaseColor}>Reset</button>
                  <button className="button button-primary" disabled={!canAdjustBaseColor}
                    onClick={requestExportBaseColor}>Export PNG</button>
                </div>
              </div>
              <div className="inspector-subsection">
                <p className="eyebrow">PBR Shader</p>
                <label className="color-field"><span>Base Color Tint</span>
                  <input type="color" value={pbrSettings.baseColor} disabled={!activeSurface}
                    onChange={(event) => patchPbrSettings({ baseColor: event.currentTarget.value })} />
                </label>
                <label className="range-field"><span>Roughness <b>{pbrSettings.roughness.toFixed(2)}</b></span>
                  <input type="range" min="0" max="1" step="0.01" value={pbrSettings.roughness}
                    disabled={!activeSurface} onChange={(event) => patchPbrSettings({ roughness: Number(event.currentTarget.value) })} />
                </label>
                <label className="range-field"><span>Metallic <b>{pbrSettings.metallic.toFixed(2)}</b></span>
                  <input type="range" min="0" max="1" step="0.01" value={pbrSettings.metallic}
                    disabled={!activeSurface} onChange={(event) => patchPbrSettings({ metallic: Number(event.currentTarget.value) })} />
                </label>
                <label className="range-field"><span>Normal Strength <b>{pbrSettings.normalScale.toFixed(2)}</b></span>
                  <input type="range" min="0" max="3" step="0.05" value={pbrSettings.normalScale}
                    disabled={!activeSurface} onChange={(event) => patchPbrSettings({ normalScale: Number(event.currentTarget.value) })} />
                </label>
              </div>
            </div>
          </details>

          <details className="inspector-section">
            <summary>
              <span className="section-title">Lighting</span>
              <span className="section-meta">IBL {lightingSettings.environmentIntensity.toFixed(2)}</span>
            </summary>
            <div className="panel-section">
              <label className="color-field"><span>Environment Color</span>
                <input type="color" value={lightingSettings.environmentColor}
                  onChange={(event) => patchLightingSettings({ environmentColor: event.currentTarget.value })} />
              </label>
              <label className="range-field"><span>Environment / IBL <b>{lightingSettings.environmentIntensity.toFixed(2)}</b></span>
                <input type="range" min="0" max="5" step="0.05" value={lightingSettings.environmentIntensity}
                  onChange={(event) => patchLightingSettings({ environmentIntensity: Number(event.currentTarget.value) })} />
              </label>
              <label className="color-field"><span>Directional Color</span>
                <input type="color" value={lightingSettings.directionalColor}
                  onChange={(event) => patchLightingSettings({ directionalColor: event.currentTarget.value })} />
              </label>
              <label className="range-field"><span>Directional <b>{lightingSettings.directionalIntensity.toFixed(2)}</b></span>
                <input type="range" min="0" max="10" step="0.1" value={lightingSettings.directionalIntensity}
                  onChange={(event) => patchLightingSettings({ directionalIntensity: Number(event.currentTarget.value) })} />
              </label>
              <label className="range-field"><span>Azimuth <b>{lightingSettings.directionalAzimuthDeg}°</b></span>
                <input type="range" min="-180" max="180" step="1" value={lightingSettings.directionalAzimuthDeg}
                  onChange={(event) => patchLightingSettings({ directionalAzimuthDeg: Number(event.currentTarget.value) })} />
              </label>
              <label className="range-field"><span>Elevation <b>{lightingSettings.directionalElevationDeg}°</b></span>
                <input type="range" min="-10" max="90" step="1" value={lightingSettings.directionalElevationDeg}
                  onChange={(event) => patchLightingSettings({ directionalElevationDeg: Number(event.currentTarget.value) })} />
              </label>
              <p className="field-note">Environment controls the Studio IBL and hemispherical fill light.</p>
            </div>
          </details>
        </aside>
      </section>

      <footer className="status-bar">
        {/* The status kind also selects the colored CSS indicator. */}
        <span className={`status-indicator status-${viewportStatus.kind}`} />
        <span>{viewportStatus.message}</span>
        <span className="status-spacer" />
        <span>Drop .glb anywhere to import</span>
      </footer>
    </main>
  );
}

export default App;
