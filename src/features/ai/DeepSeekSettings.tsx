import { useState } from "react";
import { configureDeepSeekKey, clearDeepSeekKey, type DeepSeekKeyStatus } from "./deepSeekApi";

export function DeepSeekSettings({ status, onChange }: {
  status: DeepSeekKeyStatus | null; onChange: (status: DeepSeekKeyStatus | null) => void;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const connect = async () => {
    if (busy || !key.trim()) return;
    setBusy(true); setError("");
    try { onChange(await configureDeepSeekKey(key.trim())); setKey(""); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  return <div className="deepseek-settings">
    <h3>Prompt Assistant · DeepSeek</h3>
    <p className="field-note">Session-only key. Connection validates your account; vision access is checked on the first chat.</p>
    <label>DeepSeek API Key<input type="password" autoComplete="off" value={key}
      onChange={(event) => setKey(event.target.value)}
      onKeyDown={(event) => { if (event.key === "Enter") void connect(); }} /></label>
    {status && <p className="field-note">Connected · {status.balance_infos.map((balance) => `${balance.total_balance} ${balance.currency}`).join(" / ")}{!status.is_available && " · Balance unavailable for requests"}</p>}
    {error && <p role="alert" className="status-inline-error">{error}</p>}
    <div className="effect-actions">
      <button className="button" disabled={!status || busy} onClick={() => {
        setBusy(true); setError("");
        void clearDeepSeekKey().then(() => onChange(null)).catch((reason) => setError(String(reason))).finally(() => setBusy(false));
      }}>Disconnect</button>
      <button className="button button-primary" disabled={busy || !key.trim()} onClick={() => void connect()}>{busy ? "Connecting…" : "Connect"}</button>
    </div>
  </div>;
}
