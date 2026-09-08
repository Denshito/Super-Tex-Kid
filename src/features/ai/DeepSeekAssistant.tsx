import { useEffect, useRef, useState } from "react";
import { chatDeepSeek, type ChatImages, type ChatResult, type ChatTurn, type DeepSeekKeyStatus } from "./deepSeekApi";

interface Turn extends ChatTurn { result: ChatResult; stale: boolean }
interface Props {
  sessionId: number | null;
  images: ChatImages;
  keyStatus: DeepSeekKeyStatus | null;
  onSettings: () => void;
  onApply: (prompt: string) => void;
}

/** Kept mounted across Assistant/Image Edit tabs; no transcript is persisted. */
export function DeepSeekAssistant({ sessionId, images, keyStatus, onSettings, onApply }: Props) {
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [draftVersion, setDraftVersion] = useState(-1);
  const [applied, setApplied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const contextRef = useRef(0);
  const latestSession = useRef(sessionId);
  latestSession.current = sessionId;
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    contextRef.current += 1;
    setVersion(contextRef.current); setApplied(false);
  }, [sessionId, images.baseColor, images.mask, images.reference, images.viewNormal, images.depth]);
  useEffect(() => {
    setTurns([]); setDraft(""); setInput(""); setError(""); setDraftVersion(-1);
  }, [sessionId]);

  const send = async () => {
    if (pending.current || !keyStatus?.is_available || sessionId == null || !images.baseColor || !images.mask || !input.trim()) return;
    pending.current = true; setBusy(true); setError("");
    const requestSession = sessionId;
    const requestVersion = contextRef.current;
    const instruction = input.trim();
    try {
      const result = await chatDeepSeek(sessionId, requestVersion, instruction,
        turns.filter((turn) => !turn.stale).map((turn) => ({ instruction: turn.instruction,
          reply: JSON.stringify({ reply: turn.reply, imagePrompt: turn.result.imagePrompt }),
        })), images);
      if (!mounted.current || latestSession.current !== requestSession) return;
      const stale = contextRef.current !== requestVersion || result.contextVersion !== requestVersion || result.sessionId !== requestSession;
      setTurns((previous) => [...previous, { instruction, reply: result.reply, result, stale }].slice(-20));
      if (!stale) {
        setInput("");
        if (result.imagePrompt) { setDraft(result.imagePrompt); setDraftVersion(requestVersion); setApplied(false); }
      }
    } catch (reason) {
      if (mounted.current && latestSession.current === requestSession) setError(String(reason));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return <section className="assistant-panel" aria-label="DeepSeek material assistant">
    <div className="ai-connection-row"><span className={`connection-dot ${keyStatus ? "is-connected" : ""}`} />
      <div><b>DeepSeek Vision</b><span>{keyStatus ? "Connected · STK Decal Prompt v1" : "Connect to discuss your material"}</span></div>
        <button className="text-button" onClick={onSettings}>Settings</button></div>
    {!keyStatus ? <p className="field-note">Connect your DeepSeek key in Settings to send messages.</p>
      : !keyStatus.is_available ? <p className="field-note status-inline-error">DeepSeek reports insufficient available balance.</p>
      : sessionId == null ? <p className="field-note">Create a Capture and Decal to discuss the selected patch.</p> : null}
    <details><summary>Current visual inputs</summary><div className="ai-input-strip">
      {Object.entries(images).filter(([, url]) => url).map(([label, url]) => <figure key={label}><img src={url!} alt={label} /><figcaption>{label}</figcaption></figure>)}
    </div><p className="field-note">Set Reference and Geometry Guides in Image Edit.</p></details>
    <p className="field-note">Session history: 20 rounds. Each request uses the latest 10 rounds and current images.</p>
    <div className="assistant-history" role="log" aria-live="polite">
      {!turns.length && <p className="empty-copy">Describe your material edit. Discuss the result, then apply an English prompt to Image Edit.</p>}
      {turns.map((turn, index) => <article key={index} className="assistant-turn">
        <p className="chat-user">{turn.instruction}</p><p>{turn.reply}</p>
        {turn.stale && <small>Previous input context · not applied</small>}
        {turn.result.usage && <small>Tokens · input {turn.result.usage.prompt_tokens ?? "—"} / output {turn.result.usage.completion_tokens ?? "—"}</small>}
        {turn.result.imagePrompt && <button className="text-button" onClick={() => {
          setDraft(turn.result.imagePrompt!); setDraftVersion(turn.result.contextVersion); setApplied(false);
        }}>Load prompt draft</button>}
      </article>)}
    </div>
    {draft && <div className="assistant-draft"><label>English Prompt<textarea value={draft} maxLength={2000}
      onChange={(event) => { setDraft(event.target.value); setApplied(false); }} /></label>
      <p className="field-note">{draftVersion !== version ? "Inputs changed. Review this prompt before applying it again." : applied ? "Applied to Image Edit" : "Review before generating"}</p>
      <div className="effect-actions"><button className="button" onClick={() => {
        void navigator.clipboard.writeText(draft).catch(() => setError("Copy failed; select the prompt text to copy manually"));
      }}>Copy</button><button className="button button-primary" disabled={!draft.trim() || sessionId == null} onClick={() => {
        onApply(draft); setDraftVersion(version); setApplied(true);
      }}>Apply to Image Edit</button></div></div>}
    <div className="ai-composer"><textarea aria-label="Message DeepSeek" value={input} maxLength={2000}
      disabled={busy} placeholder="Discuss the selected material…" onChange={(event) => setInput(event.target.value)}
      onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
      {error && <p role="alert" className="status-inline-error">{error}</p>}
      <div><span>Enter to send · Shift+Enter for newline</span><button className="button button-primary"
        disabled={busy || !input.trim() || !keyStatus?.is_available || sessionId == null || !images.baseColor || !images.mask}
        onClick={() => void send()}>{busy ? "Thinking…" : "Send"}</button></div>
    </div>
  </section>;
}
