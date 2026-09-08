use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use std::{sync::Mutex, time::Duration};
use tauri::State;
mod deepseek;

const OPENROUTER_BASE_URL: &str = "https://openrouter.ai/api/v1";
const OPENROUTER_IMAGE_MODEL: &str = "openai/gpt-image-2";
const MAX_PROMPT_CHARS: usize = 2_000;
const MAX_IMAGE_BYTES: usize = 24 * 1024 * 1024;
const MAX_REQUEST_IMAGE_BYTES: usize = 80 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;

struct OpenRouterState {
    api_key: Mutex<Option<String>>,
    client: Client,
}

impl Default for OpenRouterState {
    fn default() -> Self {
        Self {
            api_key: Mutex::new(None),
            client: Client::builder()
                .timeout(Duration::from_secs(180))
                .build()
                .expect("failed to create the OpenRouter HTTP client"),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenRouterKeyStatus {
    configured: bool,
    label: Option<String>,
    limit_remaining: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenRouterImageEditRequest {
    instruction: String,
    base_color_data_url: String,
    mask_data_url: String,
    reference_image_data_url: Option<String>,
    view_normal_data_url: Option<String>,
    linear_depth_data_url: Option<String>,
    quality: ImageQuality,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum ImageQuality {
    Low,
    Medium,
    High,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenRouterImageEditResponse {
    image_data_url: String,
    media_type: String,
    cost_usd: Option<f64>,
}

#[derive(Deserialize)]
struct CurrentKeyEnvelope {
    data: CurrentKeyData,
}

#[derive(Deserialize)]
struct CurrentKeyData {
    label: Option<String>,
    limit_remaining: Option<f64>,
}

#[derive(Serialize)]
struct ImageGenerationPayload {
    model: &'static str,
    prompt: String,
    quality: ImageQuality,
    aspect_ratio: &'static str,
    background: &'static str,
    n: u8,
    stream: bool,
    input_references: Vec<ImageReference>,
}

#[derive(Serialize)]
struct ImageReference {
    r#type: &'static str,
    image_url: ImageUrl,
}

#[derive(Serialize)]
struct ImageUrl {
    url: String,
}

#[derive(Deserialize)]
struct ImageGenerationResponse {
    data: Vec<GeneratedImage>,
    usage: Option<ImageUsage>,
}

#[derive(Deserialize)]
struct GeneratedImage {
    b64_json: String,
    media_type: Option<String>,
}

#[derive(Deserialize)]
struct ImageUsage {
    cost: Option<f64>,
}

#[tauri::command]
async fn configure_openrouter_key(
    api_key: String,
    state: State<'_, OpenRouterState>,
) -> Result<OpenRouterKeyStatus, String> {
    let api_key = api_key.trim();
    if !api_key.starts_with("sk-or-") || api_key.len() > 512 {
        return Err("Enter a valid OpenRouter API key".into());
    }

    let response = state
        .client
        .get(format!("{OPENROUTER_BASE_URL}/key"))
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(map_transport_error)?;
    let status = response.status();
    let bytes = response.bytes().await.map_err(map_transport_error)?;
    if !status.is_success() {
        return Err(map_http_error(status, &bytes));
    }
    let current: CurrentKeyEnvelope = serde_json::from_slice(&bytes)
        .map_err(|_| "OpenRouter returned an unreadable key status".to_string())?;

    *state
        .api_key
        .lock()
        .map_err(|_| "OpenRouter key storage is unavailable".to_string())? =
        Some(api_key.to_owned());
    Ok(OpenRouterKeyStatus {
        configured: true,
        label: current.data.label,
        limit_remaining: current.data.limit_remaining,
    })
}

#[tauri::command]
fn clear_openrouter_key(state: State<'_, OpenRouterState>) -> Result<(), String> {
    *state
        .api_key
        .lock()
        .map_err(|_| "OpenRouter key storage is unavailable".to_string())? = None;
    Ok(())
}

#[tauri::command]
async fn generate_openrouter_decal_edit(
    request: OpenRouterImageEditRequest,
    state: State<'_, OpenRouterState>,
) -> Result<OpenRouterImageEditResponse, String> {
    let api_key = state
        .api_key
        .lock()
        .map_err(|_| "OpenRouter key storage is unavailable".to_string())?
        .clone()
        .ok_or_else(|| "Connect an OpenRouter API key before generating".to_string())?;
    let payload = build_image_payload(request)?;
    let response = state
        .client
        .post(format!("{OPENROUTER_BASE_URL}/images"))
        .bearer_auth(api_key)
        .header("X-Title", "Super Tex Kid")
        .json(&payload)
        .send()
        .await
        .map_err(map_transport_error)?;
    let status = response.status();
    let bytes = read_limited_response(response, MAX_RESPONSE_BYTES).await?;
    if !status.is_success() {
        return Err(map_http_error(status, &bytes));
    }
    parse_image_response(&bytes)
}

fn build_image_payload(
    request: OpenRouterImageEditRequest,
) -> Result<ImageGenerationPayload, String> {
    let instruction = request.instruction.trim();
    if instruction.is_empty() {
        return Err("Enter an edit instruction".into());
    }
    if instruction.chars().count() > MAX_PROMPT_CHARS {
        return Err(format!(
            "Edit instructions are limited to {MAX_PROMPT_CHARS} characters"
        ));
    }

    let mut inputs = vec![
        (request.base_color_data_url, "current unlit Base Color"),
        (
            request.mask_data_url,
            "binary selection mask; white is editable",
        ),
    ];
    if let Some(image) = request.reference_image_data_url {
        inputs.push((image, "material appearance reference"));
    }
    if let Some(image) = request.view_normal_data_url {
        inputs.push((image, "view-space geometry normal guide"));
    }
    if let Some(image) = request.linear_depth_data_url {
        inputs.push((image, "linear depth guide"));
    }

    let mut total_bytes = 0;
    for (data_url, _) in &inputs {
        let image_bytes = validate_image_data_url(data_url)?;
        if image_bytes > MAX_IMAGE_BYTES {
            return Err("Each AI input image must be 24 MiB or smaller".into());
        }
        total_bytes += image_bytes;
    }
    if total_bytes > MAX_REQUEST_IMAGE_BYTES {
        return Err("The combined AI input images must be 80 MiB or smaller".into());
    }

    let reference_notes = inputs
        .iter()
        .enumerate()
        .map(|(index, (_, label))| format!("Reference image {} is the {}.", index + 1, label))
        .collect::<Vec<_>>()
        .join("\n");
    let prompt = format!(
        "Edit a projected material patch for a 3D asset.\n\
         {reference_notes}\n\
         Preserve projection framing, image orientation, aspect ratio, and surface structure. \
         Output flat albedo information only: no lighting, highlights, reflections, or cast shadows. \
         Modify only the white region described by the mask and preserve useful boundary continuity. \
         Geometry guide images describe shape only; never reproduce their colors.\n\
         User instruction: {instruction}"
    );
    let input_references = inputs
        .into_iter()
        .map(|(url, _)| ImageReference {
            r#type: "image_url",
            image_url: ImageUrl { url },
        })
        .collect();

    Ok(ImageGenerationPayload {
        model: OPENROUTER_IMAGE_MODEL,
        prompt,
        quality: request.quality,
        aspect_ratio: "1:1",
        background: "opaque",
        n: 1,
        stream: false,
        input_references,
    })
}

fn validate_image_data_url(data_url: &str) -> Result<usize, String> {
    const PREFIXES: [&str; 3] = [
        "data:image/png;base64,",
        "data:image/jpeg;base64,",
        "data:image/webp;base64,",
    ];
    let payload = PREFIXES
        .iter()
        .find_map(|prefix| data_url.strip_prefix(prefix))
        .ok_or_else(|| "AI inputs must be PNG, JPEG, or WebP data URLs".to_string())?;
    if payload.is_empty() {
        return Err("An AI input image is empty".into());
    }
    if payload.len() % 4 != 0
        || payload.bytes().any(|byte| {
            !matches!(byte,
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'+' | b'/' | b'=')
        })
        || payload.trim_end_matches('=').contains('=')
        || payload.len() - payload.trim_end_matches('=').len() > 2
    {
        return Err("An AI input contains invalid Base64 image data".into());
    }
    let padding = payload.len() - payload.trim_end_matches('=').len();
    Ok(payload.len().saturating_mul(3) / 4 - padding)
}

async fn read_limited_response(
    mut response: reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err("OpenRouter returned an image response that is too large".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(map_transport_error)? {
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err("OpenRouter returned an image response that is too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn parse_image_response(bytes: &[u8]) -> Result<OpenRouterImageEditResponse, String> {
    let response: ImageGenerationResponse = serde_json::from_slice(bytes)
        .map_err(|_| "OpenRouter returned an unreadable image response".to_string())?;
    let image = response
        .data
        .into_iter()
        .next()
        .filter(|image| !image.b64_json.is_empty())
        .ok_or_else(|| "OpenRouter completed without returning an image".to_string())?;
    let media_type = image.media_type.unwrap_or_else(|| "image/png".to_string());
    if !matches!(
        media_type.as_str(),
        "image/png" | "image/jpeg" | "image/webp"
    ) {
        return Err(format!(
            "OpenRouter returned an unsupported image type: {media_type}"
        ));
    }
    Ok(OpenRouterImageEditResponse {
        image_data_url: format!("data:{media_type};base64,{}", image.b64_json),
        media_type,
        cost_usd: response.usage.and_then(|usage| usage.cost),
    })
}

fn map_transport_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "OpenRouter timed out after 180 seconds".into()
    } else {
        format!("Could not reach OpenRouter: {error}")
    }
}

fn map_http_error(status: StatusCode, bytes: &[u8]) -> String {
    let message = extract_error_message(bytes);
    match status.as_u16() {
        401 => "OpenRouter rejected the API key".into(),
        402 => "OpenRouter credits are insufficient for this request".into(),
        429 => "OpenRouter rate limit reached; wait and try again".into(),
        500..=599 => format!("OpenRouter is temporarily unavailable ({status})"),
        _ if message.is_empty() => format!("OpenRouter request failed ({status})"),
        _ => format!("OpenRouter request failed ({status}): {message}"),
    }
}

fn extract_error_message(bytes: &[u8]) -> String {
    let value: serde_json::Value = match serde_json::from_slice(bytes) {
        Ok(value) => value,
        Err(_) => return String::new(),
    };
    value
        .pointer("/error/message")
        .or_else(|| value.get("error"))
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .chars()
        .take(512)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(instruction: &str) -> OpenRouterImageEditRequest {
        OpenRouterImageEditRequest {
            instruction: instruction.into(),
            base_color_data_url: "data:image/png;base64,AAAA".into(),
            mask_data_url: "data:image/png;base64,BBBB".into(),
            reference_image_data_url: None,
            view_normal_data_url: None,
            linear_depth_data_url: None,
            quality: ImageQuality::Medium,
        }
    }

    #[test]
    fn validates_inputs_and_builds_reference_order() {
        assert!(build_image_payload(request("  ")).is_err());
        assert!(build_image_payload(request(&"x".repeat(MAX_PROMPT_CHARS + 1))).is_err());
        let payload = build_image_payload(request("add worn paint")).unwrap();
        assert_eq!(payload.input_references.len(), 2);
        assert!(payload
            .prompt
            .contains("Reference image 2 is the binary selection mask"));
        assert!(validate_image_data_url("data:text/plain;base64,AAAA").is_err());
        assert!(validate_image_data_url("data:image/png;base64,not valid!").is_err());
    }

    #[test]
    fn parses_success_and_maps_provider_errors() {
        let parsed =
            parse_image_response(br#"{"data":[{"b64_json":"AAAA"}],"usage":{"cost":0.05}}"#)
                .unwrap();
        assert_eq!(parsed.media_type, "image/png");
        assert_eq!(parsed.cost_usd, Some(0.05));
        assert_eq!(
            map_http_error(StatusCode::UNAUTHORIZED, b"{}"),
            "OpenRouter rejected the API key"
        );
        assert_eq!(
            map_http_error(StatusCode::PAYMENT_REQUIRED, b"{}"),
            "OpenRouter credits are insufficient for this request"
        );
        assert_eq!(
            map_http_error(StatusCode::TOO_MANY_REQUESTS, b"{}"),
            "OpenRouter rate limit reached; wait and try again"
        );
        assert!(map_http_error(StatusCode::BAD_GATEWAY, b"{}").contains("temporarily unavailable"));
        assert!(parse_image_response(br#"{"data":[]}"#).is_err());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Builder configures native plugins and commands, creates the WebView window
    // from tauri.conf.json, and then enters Tauri's desktop event loop.
    tauri::Builder::default()
        .manage(OpenRouterState::default())
        .manage(deepseek::DeepSeekState::default())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            configure_openrouter_key,
            clear_openrouter_key,
            generate_openrouter_decal_edit,
            deepseek::configure_deepseek_key,
            deepseek::clear_deepseek_key,
            deepseek::chat_deepseek
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
