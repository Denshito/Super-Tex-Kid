import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { DeepSeekAssistant } from "./DeepSeekAssistant";
import type { DeepSeekKeyStatus } from "./deepSeekApi";
import type {
  DecalActorSummary,
  ProjectionCaptureSummary,
  ViewportStatus,
} from "../../types/editor";
import {
  dataUrlToBlob,
  fileToDataUrl,
  generateOpenRouterDecalEdit,
  type OpenRouterKeyStatus,
  type OpenRouterQuality,
} from "./openRouterApi";

interface AiRevision {
  id: number;
  instruction: string;
  imageUrl: string;
  blob: Blob;
  source: "capture" | "generated";
  costUsd: number | null;
  createdAt: number;
}

interface OpenRouterAiPanelProps {
  capture: ProjectionCaptureSummary | null;
  decal: DecalActorSummary | null;
  keyStatus: OpenRouterKeyStatus | null;
  deepSeekStatus: DeepSeekKeyStatus | null;
  onOpenSettings: () => void;
  onApplyGenerated: (blob: Blob, label: string, origin: "capture" | "generated") => void;
  onStatus: (status: ViewportStatus) => void;
}

/** Session-only BaseColor edit history backed by OpenRouter's dedicated Image API. */
export function OpenRouterAiPanel({
  capture,
  decal,
  keyStatus,
  deepSeekStatus,
  onOpenSettings,
  onApplyGenerated,
  onStatus,
}: OpenRouterAiPanelProps) {
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const [page, setPage] = useState<"assistant" | "image">("assistant");
  const ownedUrlsRef = useRef(new Set<string>());
  const nextRevisionIdRef = useRef(1);
  const [instruction, setInstruction] = useState("");
  const [quality, setQuality] = useState<OpenRouterQuality>("medium");
  const [includeGeometry, setIncludeGeometry] = useState(false);
  const [reference, setReference] = useState<{ name: string; dataUrl: string } | null>(null);
  const [revisions, setRevisions] = useState<AiRevision[]>([]);
  const [activeRevisionId, setActiveRevisionId] = useState<number | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const releaseOwnedUrls = (): void => {
    for (const url of ownedUrlsRef.current) URL.revokeObjectURL(url);
    ownedUrlsRef.current.clear();
  };

  useEffect(() => () => releaseOwnedUrls(), []);

  useEffect(() => {
    let cancelled = false;
    releaseOwnedUrls();
    setPage("assistant");
    setInstruction("");
    setReference(null);
    setRevisions([]);
    setActiveRevisionId(null);
    setError(null);
    nextRevisionIdRef.current = 1;
    const source = decal?.channels.baseColor.previewDataUrl;
    if (!source) return () => { cancelled = true; };
    dataUrlToBlob(source).then((blob) => {
      if (cancelled) return;
      const original: AiRevision = {
        id: 0,
        instruction: "Original Capture",
        imageUrl: source,
        blob,
        source: "capture",
        costUsd: null,
        createdAt: Date.now(),
      };
      setRevisions([original]);
      setActiveRevisionId(0);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { cancelled = true; };
  }, [decal?.sessionId]);

  const applyRevision = (revision: AiRevision): void => {
    setActiveRevisionId(revision.id);
    onApplyGenerated(
      revision.blob,
      revision.source === "capture" ? "Captured Base Color" : `AI Edit ${revision.id}`,
      revision.source,
    );
  };

  const addRevision = (revision: AiRevision): void => {
    setRevisions((current) => {
      const next = [...current, revision];
      if (next.length <= 9) return next;
      const removed = next.splice(1, 1)[0];
      if (removed?.imageUrl.startsWith("blob:")) {
        URL.revokeObjectURL(removed.imageUrl);
        ownedUrlsRef.current.delete(removed.imageUrl);
      }
      return next;
    });
  };

  const generate = async (): Promise<void> => {
    if (!capture || !decal || !instruction.trim() || generating) return;
    setGenerating(true);
    setError(null);
    onStatus({ kind: "loading", message: "Generating BaseColor Decal with GPT Image 2" });
    try {
      const activeRevision = revisions.find((revision) => revision.id === activeRevisionId);
      const baseColorDataUrl = activeRevision
        ? await fileToDataUrl(activeRevision.blob)
        : decal.channels.baseColor.previewDataUrl;
      const result = await generateOpenRouterDecalEdit({
        instruction,
        baseColorDataUrl,
        maskDataUrl: capture.maskPreviewDataUrl,
        referenceImageDataUrl: reference?.dataUrl ?? null,
        viewNormalDataUrl: includeGeometry ? capture.viewNormalPreviewDataUrl : null,
        linearDepthDataUrl: includeGeometry ? capture.linearDepthPreviewDataUrl : null,
        quality,
      });
      const blob = await dataUrlToBlob(result.imageDataUrl);
      const imageUrl = URL.createObjectURL(blob);
      ownedUrlsRef.current.add(imageUrl);
      const id = nextRevisionIdRef.current++;
      const revision: AiRevision = {
        id,
        instruction: instruction.trim(),
        imageUrl,
        blob,
        source: "generated",
        costUsd: result.costUsd,
        createdAt: Date.now(),
      };
      addRevision(revision);
      setActiveRevisionId(id);
      onApplyGenerated(blob, `AI Edit ${id}`, "generated");
      setInstruction("");
      onStatus({
        kind: "ready",
        message: result.costUsd == null
          ? "AI BaseColor applied to the live Decal preview"
          : `AI BaseColor applied · $${result.costUsd.toFixed(4)}`,
      });
    } catch (reason: unknown) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      onStatus({ kind: "error", message: `AI edit failed: ${message}` });
    } finally {
      setGenerating(false);
    }
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void generate();
  };

  const targetReady = Boolean(decal?.targetTextureSet.channels.baseColor.isLoaded);
  const canGenerate = Boolean(
    keyStatus?.configured
    && capture
    && decal
    && targetReady
    && instruction.trim()
    && !generating,
  );
  const blockedReason = !keyStatus?.configured
    ? "Connect an OpenRouter API key"
    : !decal || !capture
      ? "Create a Capture and Decal first"
      : !targetReady
        ? "Import a target Base Color map first"
        : null;

  return (
    <>
      <nav className="workbench-tabs" aria-label="AI editor pages">
        <button className={page === "assistant" ? "is-active" : ""} onClick={() => setPage("assistant")}>Assistant</button>
        <button className={page === "image" ? "is-active" : ""} onClick={() => setPage("image")}>Image Edit</button>
      </nav>
      <div hidden={page !== "assistant"}>
        <DeepSeekAssistant sessionId={decal?.sessionId ?? null} keyStatus={deepSeekStatus}
          images={{ baseColor: decal?.channels.baseColor.previewDataUrl ?? "", mask: capture?.maskPreviewDataUrl ?? "",
            reference: reference?.dataUrl ?? null, viewNormal: includeGeometry ? capture?.viewNormalPreviewDataUrl ?? null : null,
            depth: includeGeometry ? capture?.linearDepthPreviewDataUrl ?? null : null }}
          onSettings={onOpenSettings} onApply={(prompt) => { setInstruction(prompt); setPage("image"); }} />
      </div>
      <div hidden={page !== "image"}>
    <section className="ai-panel" aria-label="OpenRouter AI BaseColor editor">
      <div className="ai-connection-row">
        <span className={`connection-dot ${keyStatus?.configured ? "is-connected" : ""}`} />
        <div>
          <b>{keyStatus?.configured ? "OpenRouter connected" : "OpenRouter not connected"}</b>
          <span>{keyStatus?.label ?? "Session-only API access"}</span>
        </div>
        <button className="text-button" onClick={onOpenSettings}>Settings</button>
      </div>

      <div className="ai-current-preview checkerboard">
        {decal ? (
          <img src={decal.channels.baseColor.previewDataUrl} alt="Current AI BaseColor Decal" />
        ) : (
          <p>Create a Decal to start AI editing.</p>
        )}
      </div>

      <div className="ai-input-strip">
        <figure><img src={decal?.channels.baseColor.previewDataUrl} alt="Current BaseColor input" /><figcaption>Base</figcaption></figure>
        <figure><img src={capture?.maskPreviewDataUrl} alt="Selection Mask input" /><figcaption>Mask</figcaption></figure>
        <button className="ai-reference-slot" onClick={() => referenceInputRef.current?.click()}>
          {reference ? <img src={reference.dataUrl} alt={reference.name} /> : <span>+ Reference</span>}
        </button>
        {includeGeometry ? (
          <>
            <figure><img src={capture?.viewNormalPreviewDataUrl} alt="View Normal guide" /><figcaption>Normal</figcaption></figure>
            <figure><img src={capture?.linearDepthPreviewDataUrl} alt="Linear Depth guide" /><figcaption>Depth</figcaption></figure>
          </>
        ) : null}
      </div>
      <input
        ref={referenceInputRef}
        className="visually-hidden"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (!file) return;
          event.currentTarget.value = "";
          fileToDataUrl(file)
            .then((dataUrl) => setReference({ name: file.name, dataUrl }))
            .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
        }}
      />
      {reference ? (
        <div className="ai-reference-meta"><span>{reference.name}</span><button className="text-button" onClick={() => setReference(null)}>Remove</button></div>
      ) : null}

      <div className="ai-history" aria-label="AI edit history">
        {revisions.map((revision) => (
          <button
            key={revision.id}
            className={`ai-history-card ${activeRevisionId === revision.id ? "is-active" : ""}`}
            onClick={() => applyRevision(revision)}
          >
            <img src={revision.imageUrl} alt={revision.instruction} />
            <span><b>{revision.instruction}</b><small>{revision.costUsd == null ? revision.source : `$${revision.costUsd.toFixed(4)}`}</small></span>
          </button>
        ))}
      </div>

      <div className="ai-options">
        <label>Quality
          <select value={quality} onChange={(event) => setQuality(event.currentTarget.value as OpenRouterQuality)}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </label>
        <label className="capture-mask-toggle">
          <input type="checkbox" checked={includeGeometry} onChange={(event) => setIncludeGeometry(event.currentTarget.checked)} />
          Geometry Guides
        </label>
      </div>

      <div className="ai-composer">
        <textarea
          value={instruction}
          maxLength={2000}
          placeholder="Describe the selected surface change…"
          onChange={(event) => setInstruction(event.currentTarget.value)}
          onKeyDown={handleComposerKeyDown}
        />
        {error ? <p className="status-inline-error">{error}</p> : blockedReason ? <p>{blockedReason}</p> : null}
        <div><span>{instruction.length}/2000 · Shift+Enter for newline</span><button className="button button-primary" disabled={!canGenerate} onClick={() => void generate()}>{generating ? "Generating…" : "Generate"}</button></div>
      </div>
    </section>
      </div>
    </>
  );
}
