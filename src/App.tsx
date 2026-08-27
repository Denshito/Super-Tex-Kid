import { useRef, useState } from "react";
import {
  Viewport3D,
  type TextureImportRequest,
} from "./features/viewport/Viewport3D";
import { useEditorStore } from "./state/editorStore";
import type { MaterialChannel } from "./types/editor";
import "./App.css";

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
  const textureTargetRef = useRef<{ materialId: string; channel: MaterialChannel } | null>(null);
  const textureRequestIdRef = useRef(0);
  const [modelFile, setModelFile] = useState<File | null>(null);
  const [textureImport, setTextureImport] = useState<TextureImportRequest | null>(null);

  // Subscribe to individual store slices so unrelated state changes do not
  // redraw the entire editor shell.
  const modelName = useEditorStore((state) => state.modelName);
  const viewportStatus = useEditorStore((state) => state.viewportStatus);
  const pickedUv = useEditorStore((state) => state.pickedUv);
  const activeSurface = useEditorStore((state) => state.activeSurface);
  const activeMask = useEditorStore((state) => state.activeMask);
  const toolMode = useEditorStore((state) => state.toolMode);
  const activeChannel = useEditorStore((state) => state.activeChannel);
  const brushSettings = useEditorStore((state) => state.brushSettings);
  const pbrSettings = useEditorStore((state) => state.pbrSettings);
  const lightingSettings = useEditorStore((state) => state.lightingSettings);
  const setToolMode = useEditorStore((state) => state.setToolMode);
  const setActiveChannel = useEditorStore((state) => state.setActiveChannel);
  const patchBrushSettings = useEditorStore((state) => state.patchBrushSettings);
  const patchPbrSettings = useEditorStore((state) => state.patchPbrSettings);
  const patchLightingSettings = useEditorStore((state) => state.patchLightingSettings);
  const requestClearMask = useEditorStore((state) => state.requestClearMask);

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
          <button className="button button-primary" onClick={() => fileInputRef.current?.click()}>
            导入 GLB
          </button>
        </div>
      </header>

      <section className="workspace">
        <aside className="tool-rail" aria-label="纹理工具">
          <button
            className={`tool-button ${toolMode === "orbit" ? "is-active" : ""}`}
            title="观察模式"
            onClick={() => setToolMode("orbit")}
          >
            ◉
          </button>
          <button
            className={`tool-button ${toolMode === "brush" ? "is-active" : ""}`}
            title="屏幕空间画笔"
            onClick={() => setToolMode("brush")}
          >
            ✎
          </button>
        </aside>

        <section className="viewport-panel">
          {/* Viewport3D owns the WebGL canvas inside this resizable center panel. */}
          <Viewport3D modelFile={modelFile} textureImport={textureImport} />
          <div className="viewport-hint">
            {toolMode === "brush"
              ? "画笔模式 · 在可见表面拖动 · 单次笔划锁定当前材质"
              : "左键旋转 · 右键平移 · 滚轮缩放 · 点击表面读取 UV"}
          </div>
        </section>

        <aside className="inspector">
          <section className="panel-section">
            <p className="eyebrow">场景</p>
            <h2>{modelName}</h2>
            <dl className="property-list">
              <div><dt>渲染器</dt><dd>Three.js / WebGL</dd></div>
              <div><dt>工作色彩空间</dt><dd>sRGB</dd></div>
              <div><dt>材质模型</dt><dd>Metallic / Roughness</dd></div>
            </dl>
          </section>

          <section className="panel-section">
            <p className="eyebrow">拾取结果</p>
            <h3>{activeSurface?.materialName ?? "未选择材质"}</h3>
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
              <p className="empty-copy">点击模型表面后显示坐标。</p>
            )}
          </section>

          <section className="panel-section">
            <p className="eyebrow">准备修改的通道</p>
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
            <p className="field-note">选区属于当前 Texture Set，可供多个通道复用。</p>
          </section>

          <section className="panel-section">
            <p className="eyebrow">屏幕空间画笔</p>
            <label className="range-field">
              <span>半径 <b>{brushSettings.radiusPx}px</b></span>
              <input
                type="range"
                min="8"
                max="120"
                value={brushSettings.radiusPx}
                onChange={(event) => patchBrushSettings({ radiusPx: Number(event.currentTarget.value) })}
              />
            </label>
            <label className="range-field">
              <span>硬度 <b>{Math.round(brushSettings.hardness * 100)}%</b></span>
              <input
                type="range"
                min="0.1"
                max="0.95"
                step="0.05"
                value={brushSettings.hardness}
                onChange={(event) => patchBrushSettings({ hardness: Number(event.currentTarget.value) })}
              />
            </label>
            <div className="threshold-grid">
              <label>
                内参考
                <input
                  type="number"
                  min="0"
                  max="64"
                  value={brushSettings.innerReferencePx}
                  onChange={(event) => patchBrushSettings({ innerReferencePx: Number(event.currentTarget.value) })}
                />
              </label>
              <label>
                外参考
                <input
                  type="number"
                  min="0"
                  max="128"
                  value={brushSettings.outerReferencePx}
                  onChange={(event) => patchBrushSettings({ outerReferencePx: Number(event.currentTarget.value) })}
                />
              </label>
            </div>
          </section>

          <section className="panel-section">
            <p className="eyebrow">PBR Texture Maps</p>
            <div className="texture-grid">
              {([
                ["baseColor", "Base Color"],
                ["roughness", "Roughness"],
                ["normal", "Normal"],
                ["metallic", "Metallic"],
              ] as const).map(([channel, label]) => (
                <button
                  key={channel}
                  className="texture-slot-button"
                  disabled={!activeSurface}
                  onClick={() => chooseTexture(channel)}
                >
                  <span>{label}</span>
                  <b>Import</b>
                </button>
              ))}
            </div>
            <p className="field-note">
              Maps apply only to the selected material. Normal maps expect OpenGL +Y convention.
            </p>
          </section>

          <section className="panel-section">
            <p className="eyebrow">PBR Shader Uniforms</p>
            <label className="color-field">
              <span>Base Color Tint</span>
              <input
                type="color"
                value={pbrSettings.baseColor}
                disabled={!activeSurface}
                onChange={(event) => patchPbrSettings({ baseColor: event.currentTarget.value })}
              />
            </label>
            <label className="range-field">
              <span>Roughness <b>{pbrSettings.roughness.toFixed(2)}</b></span>
              <input
                type="range" min="0" max="1" step="0.01"
                value={pbrSettings.roughness} disabled={!activeSurface}
                onChange={(event) => patchPbrSettings({ roughness: Number(event.currentTarget.value) })}
              />
            </label>
            <label className="range-field">
              <span>Metallic <b>{pbrSettings.metallic.toFixed(2)}</b></span>
              <input
                type="range" min="0" max="1" step="0.01"
                value={pbrSettings.metallic} disabled={!activeSurface}
                onChange={(event) => patchPbrSettings({ metallic: Number(event.currentTarget.value) })}
              />
            </label>
            <label className="range-field">
              <span>Normal Strength <b>{pbrSettings.normalScale.toFixed(2)}</b></span>
              <input
                type="range" min="0" max="3" step="0.05"
                value={pbrSettings.normalScale} disabled={!activeSurface}
                onChange={(event) => patchPbrSettings({ normalScale: Number(event.currentTarget.value) })}
              />
            </label>
          </section>

          <section className="panel-section">
            <p className="eyebrow">Lighting</p>
            <label className="color-field">
              <span>Environment Color</span>
              <input
                type="color" value={lightingSettings.environmentColor}
                onChange={(event) => patchLightingSettings({ environmentColor: event.currentTarget.value })}
              />
            </label>
            <label className="range-field">
              <span>Environment <b>{lightingSettings.environmentIntensity.toFixed(2)}</b></span>
              <input
                type="range" min="0" max="5" step="0.05"
                value={lightingSettings.environmentIntensity}
                onChange={(event) => patchLightingSettings({ environmentIntensity: Number(event.currentTarget.value) })}
              />
            </label>
            <label className="color-field">
              <span>Directional Color</span>
              <input
                type="color" value={lightingSettings.directionalColor}
                onChange={(event) => patchLightingSettings({ directionalColor: event.currentTarget.value })}
              />
            </label>
            <label className="range-field">
              <span>Directional <b>{lightingSettings.directionalIntensity.toFixed(2)}</b></span>
              <input
                type="range" min="0" max="10" step="0.1"
                value={lightingSettings.directionalIntensity}
                onChange={(event) => patchLightingSettings({ directionalIntensity: Number(event.currentTarget.value) })}
              />
            </label>
            <label className="range-field">
              <span>Azimuth <b>{lightingSettings.directionalAzimuthDeg}°</b></span>
              <input
                type="range" min="-180" max="180" step="1"
                value={lightingSettings.directionalAzimuthDeg}
                onChange={(event) => patchLightingSettings({ directionalAzimuthDeg: Number(event.currentTarget.value) })}
              />
            </label>
            <label className="range-field">
              <span>Elevation <b>{lightingSettings.directionalElevationDeg}°</b></span>
              <input
                type="range" min="-10" max="90" step="1"
                value={lightingSettings.directionalElevationDeg}
                onChange={(event) => patchLightingSettings({ directionalElevationDeg: Number(event.currentTarget.value) })}
              />
            </label>
            <p className="field-note">Environment is hemispherical fill light; HDRI/IBL is not connected yet.</p>
          </section>

          <section className="panel-section panel-grow">
            <div className="section-heading-row">
              <p className="eyebrow">Selection Mask</p>
              <button className="text-button" disabled={!activeMask?.hasContent} onClick={requestClearMask}>清空</button>
            </div>
            {activeMask ? (
              <>
                <div className="mask-preview checkerboard">
                  <img src={activeMask.previewDataUrl} alt={`${activeMask.materialName} selection mask`} />
                </div>
                <p className="mask-resolution">{activeMask.width} × {activeMask.height}</p>
              </>
            ) : (
              <p className="empty-copy">切换到画笔模式并在模型表面绘制。</p>
            )}
          </section>
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
