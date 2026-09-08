use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{sync::Mutex, time::Duration};
use tauri::State;

const MODEL: &str = "deepseek-v4-flash-vision-exp";
const SKILL: &str = include_str!("../../skills/stk-decal-prompt/SKILL.md");
const MAX_BODY: usize = 32 * 1024 * 1024;

pub struct DeepSeekState {
    key: Mutex<Option<String>>,
    client: Client,
}

impl Default for DeepSeekState {
    fn default() -> Self {
        Self {
            key: Mutex::new(None),
            client: Client::builder()
                .timeout(Duration::from_secs(120))
                .build()
                .expect("HTTP client"),
        }
    }
}

#[derive(Serialize, Deserialize)]
pub struct Balance {
    currency: String,
    total_balance: String,
}

#[derive(Serialize, Deserialize)]
pub struct KeyStatus {
    is_available: bool,
    balance_infos: Vec<Balance>,
}

#[derive(Deserialize)]
pub struct Turn {
    instruction: String,
    reply: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    session_id: u64,
    context_version: u64,
    instruction: String,
    history: Vec<Turn>,
    base_color: String,
    mask: String,
    reference: Option<String>,
    view_normal: Option<String>,
    depth: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Draft {
    reply: String,
    image_prompt: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatResponse {
    session_id: u64,
    context_version: u64,
    reply: String,
    image_prompt: Option<String>,
    usage: Option<Value>,
}

fn transport(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "DeepSeek timed out after 120 seconds".into()
    } else {
        "Could not reach DeepSeek".into()
    }
}

fn http_error(status: StatusCode) -> String {
    match status.as_u16() {
        401 => "DeepSeek rejected the API key".into(),
        402 => "DeepSeek balance is insufficient".into(),
        429 => "DeepSeek rate limit reached; try again later".into(),
        500..=599 => "DeepSeek is temporarily unavailable".into(),
        _ => {
            format!("DeepSeek request failed ({status}); check vision model availability and input")
        }
    }
}

async fn read_response(mut response: reqwest::Response) -> Result<Vec<u8>, String> {
    if !response.status().is_success() {
        return Err(http_error(response.status()));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(transport)? {
        if bytes.len() + chunk.len() > 1024 * 1024 {
            return Err("DeepSeek response exceeds 1 MiB".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[tauri::command]
pub async fn configure_deepseek_key(
    api_key: String,
    state: State<'_, DeepSeekState>,
) -> Result<KeyStatus, String> {
    let key = api_key.trim();
    if key.is_empty() || key.len() > 512 || key.chars().any(char::is_whitespace) {
        return Err("Enter a valid DeepSeek key".into());
    }
    let response = state
        .client
        .get("https://api.deepseek.com/user/balance")
        .bearer_auth(key)
        .send()
        .await
        .map_err(transport)?;
    let result: KeyStatus = serde_json::from_slice(&read_response(response).await?)
        .map_err(|_| "Invalid DeepSeek balance response")?;
    *state.key.lock().map_err(|_| "Key storage unavailable")? = Some(key.to_owned());
    Ok(result)
}

#[tauri::command]
pub fn clear_deepseek_key(state: State<'_, DeepSeekState>) -> Result<(), String> {
    *state.key.lock().map_err(|_| "Key storage unavailable")? = None;
    Ok(())
}

fn payload(request: &ChatRequest) -> Result<Vec<u8>, String> {
    if request.instruction.trim().is_empty() || request.instruction.chars().count() > 2000 {
        return Err("Enter a message of 1–2000 characters".into());
    }
    if request.history.len() > 20 {
        return Err("Chat history exceeds 20 rounds".into());
    }
    let mut messages = vec![json!({"role":"system", "content":SKILL})];
    for turn in request
        .history
        .iter()
        .skip(request.history.len().saturating_sub(10))
    {
        if turn.instruction.chars().count() > 2000 || turn.reply.chars().count() > 16000 {
            return Err("Chat history message is too long".into());
        }
        messages.push(json!({"role":"user", "content":turn.instruction}));
        messages.push(json!({"role":"assistant", "content":turn.reply}));
    }
    let mut content = vec![json!({"type":"text", "text":request.instruction})];
    for (name, image) in [
        ("Current BaseColor", Some(&request.base_color)),
        ("Selection Mask: white is editable", Some(&request.mask)),
        ("Material reference", request.reference.as_ref()),
        ("View-space normal guide", request.view_normal.as_ref()),
        ("Linear depth guide", request.depth.as_ref()),
    ] {
        if let Some(image) = image {
            if !image.starts_with("data:image/png;base64,") {
                return Err("Chat images must be PNG data URLs".into());
            }
            let size = crate::validate_image_data_url(image)?;
            if size > 4 * 1024 * 1024 {
                return Err("Each chat image must be 4 MiB or smaller".into());
            }
            content.push(json!({"type":"text", "text":name}));
            content.push(json!({"type":"image_url", "image_url":{"url":image}}));
        }
    }
    messages.push(json!({"role":"user", "content":content}));
    let bytes = serde_json::to_vec(&json!({
        "model":MODEL, "messages":messages, "stream":false,
        "thinking":{"type":"disabled"}, "max_tokens":2048,
        "response_format":{"type":"json_object"}
    }))
    .map_err(|_| "Could not encode chat request")?;
    validate_body_size(bytes.len())?;
    Ok(bytes)
}

fn validate_body_size(size: usize) -> Result<(), String> {
    if size > MAX_BODY {
        Err("Chat request exceeds 32 MiB".into())
    } else {
        Ok(())
    }
}

fn parse_reply(bytes: &[u8]) -> Result<(Draft, Option<Value>), String> {
    let body: Value = serde_json::from_slice(bytes).map_err(|_| "Invalid DeepSeek response")?;
    if body
        .pointer("/choices/0/finish_reason")
        .and_then(Value::as_str)
        != Some("stop")
    {
        return Err("DeepSeek reply was incomplete; draft unchanged".into());
    }
    let content = body
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .ok_or("DeepSeek returned no reply")?;
    let mut draft: Draft = serde_json::from_str(content)
        .map_err(|_| "DeepSeek returned invalid prompt JSON; draft unchanged")?;
    draft.reply = draft.reply.trim().into();
    if draft.reply.is_empty() || draft.reply.chars().count() > 12000 {
        return Err("DeepSeek returned an empty or oversized reply".into());
    }
    if let Some(prompt) = &mut draft.image_prompt {
        *prompt = prompt.trim().into();
        if prompt.is_empty() || prompt.chars().count() > 2000 {
            return Err("DeepSeek prompt must contain 1–2000 characters".into());
        }
    }
    Ok((draft, body.get("usage").cloned()))
}

#[tauri::command]
pub async fn chat_deepseek(
    request: ChatRequest,
    state: State<'_, DeepSeekState>,
) -> Result<ChatResponse, String> {
    let key = state
        .key
        .lock()
        .map_err(|_| "Key storage unavailable")?
        .clone()
        .ok_or("Connect DeepSeek first")?;
    let bytes = payload(&request)?;
    let response = state
        .client
        .post("https://api.deepseek.com/chat/completions")
        .bearer_auth(key)
        .header("Content-Type", "application/json")
        .body(bytes)
        .send()
        .await
        .map_err(transport)?;
    let (draft, usage) = parse_reply(&read_response(response).await?)?;
    Ok(ChatResponse {
        session_id: request.session_id,
        context_version: request.context_version,
        reply: draft.reply,
        image_prompt: draft.image_prompt,
        usage,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> ChatRequest {
        ChatRequest {
            session_id: 1,
            context_version: 1,
            instruction: "Weather the bricks".into(),
            history: vec![],
            base_color: "data:image/png;base64,AAAA".into(),
            mask: "data:image/png;base64,BBBB".into(),
            reference: None,
            view_normal: None,
            depth: None,
        }
    }
    #[test]
    fn orders_images_and_bounds_history() {
        let mut req = request();
        req.history = (0..20)
            .map(|i| Turn {
                instruction: i.to_string(),
                reply: "ok".into(),
            })
            .collect();
        req.reference = Some(req.base_color.clone());
        let body: Value = serde_json::from_slice(&payload(&req).unwrap()).unwrap();
        assert_eq!(body["messages"].as_array().unwrap().len(), 22);
        assert_eq!(body["messages"][1]["content"], "10");
        let content = body["messages"][21]["content"].as_array().unwrap();
        assert_eq!(content[1]["text"], "Current BaseColor");
        assert_eq!(content[3]["text"], "Selection Mask: white is editable");
        assert_eq!(content[5]["text"], "Material reference");
        req.view_normal = Some(req.base_color.clone());
        req.depth = Some(req.base_color.clone());
        let body: Value = serde_json::from_slice(&payload(&req).unwrap()).unwrap();
        assert_eq!(
            body["messages"][21]["content"][7]["text"],
            "View-space normal guide"
        );
        assert_eq!(
            body["messages"][21]["content"][9]["text"],
            "Linear depth guide"
        );
        req.instruction.clear();
        assert!(payload(&req).is_err());
        req.instruction = "edit".into();
        req.mask = "https://invalid".into();
        assert!(payload(&req).is_err());
        assert!(validate_body_size(MAX_BODY + 1).is_err());
        req.mask = format!(
            "data:image/png;base64,{}",
            "AAAA".repeat(4 * 1024 * 1024 / 3 + 1)
        );
        assert!(payload(&req).unwrap_err().contains("4 MiB"));
        req.mask = "data:image/png;base64,==".into();
        assert!(payload(&req).is_err());
    }
    #[test]
    fn validates_drafts_and_errors() {
        let envelope = |draft: Value, finish: &str| {
            serde_json::to_vec(&json!({"choices":[{"finish_reason":finish,"message":{"content":draft.to_string()}}]})).unwrap()
        };
        assert!(parse_reply(&envelope(
            json!({"reply":"ok","imagePrompt":"Worn bricks"}),
            "stop"
        ))
        .is_ok());
        assert!(parse_reply(&envelope(
            json!({"reply":"question","imagePrompt":null}),
            "stop"
        ))
        .is_ok());
        assert!(parse_reply(&envelope(json!({"reply":"","imagePrompt":null}), "stop")).is_err());
        assert!(parse_reply(&envelope(
            json!({"reply":"ok","imagePrompt":"x".repeat(2001)}),
            "stop"
        ))
        .is_err());
        assert!(parse_reply(&envelope(json!({"reply":"ok"}), "length")).is_err());
        assert!(parse_reply(b"{}").is_err());
        assert!(http_error(StatusCode::UNAUTHORIZED).contains("API key"));
        assert!(http_error(StatusCode::PAYMENT_REQUIRED).contains("balance"));
        assert!(http_error(StatusCode::TOO_MANY_REQUESTS).contains("rate limit"));
        assert!(http_error(StatusCode::BAD_GATEWAY).contains("temporarily"));
        let invalid = br#"{"choices":[{"finish_reason":"stop","message":{"content":"not JSON"}}]}"#;
        assert!(parse_reply(invalid).is_err());
    }
}
