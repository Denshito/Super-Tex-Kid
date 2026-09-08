import { invoke } from "@tauri-apps/api/core";

export type OpenRouterQuality = "low" | "medium" | "high";

export interface OpenRouterKeyStatus {
  configured: boolean;
  label: string | null;
  limitRemaining: number | null;
}

export interface OpenRouterImageEditRequest {
  instruction: string;
  baseColorDataUrl: string;
  maskDataUrl: string;
  referenceImageDataUrl: string | null;
  viewNormalDataUrl: string | null;
  linearDepthDataUrl: string | null;
  quality: OpenRouterQuality;
}

export interface OpenRouterImageEditResponse {
  imageDataUrl: string;
  mediaType: string;
  costUsd: number | null;
}

export function configureOpenRouterKey(apiKey: string): Promise<OpenRouterKeyStatus> {
  return invoke("configure_openrouter_key", { apiKey });
}

export function clearOpenRouterKey(): Promise<void> {
  return invoke("clear_openrouter_key");
}

export function generateOpenRouterDecalEdit(
  request: OpenRouterImageEditRequest,
): Promise<OpenRouterImageEditResponse> {
  return invoke("generate_openrouter_decal_edit", { request });
}

export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl);
  if (!response.ok) throw new Error("Could not decode the generated image");
  return response.blob();
}

export function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the reference image"));
    reader.readAsDataURL(file);
  });
}
