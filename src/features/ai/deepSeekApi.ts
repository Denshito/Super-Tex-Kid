import { invoke } from "@tauri-apps/api/core";
import { fileToDataUrl } from "./openRouterApi";

export interface DeepSeekKeyStatus {
  is_available: boolean;
  balance_infos: { currency: string; total_balance: string }[];
}
export interface ChatTurn { instruction: string; reply: string }
export interface ChatResult {
  sessionId: number;
  contextVersion: number;
  reply: string;
  imagePrompt: string | null;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
}
export interface ChatImages {
  baseColor: string;
  mask: string;
  reference: string | null;
  viewNormal: string | null;
  depth: string | null;
}
export const configureDeepSeekKey = (apiKey: string): Promise<DeepSeekKeyStatus> =>
  invoke("configure_deepseek_key", { apiKey });
export const clearDeepSeekKey = (): Promise<void> => invoke("clear_deepseek_key");

/** Create small chat-only copies; source image and bake resolution stay intact. */
export async function chatImageCopy(url: string): Promise<string> {
  const image = new Image();
  image.src = url;
  await image.decode();
  const scale = Math.min(1, 1024 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Cannot prepare chat image");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
    (value) => value ? resolve(value) : reject(new Error("Cannot encode chat image")), "image/png",
  ));
  if (blob.size > 4 * 1024 * 1024) throw new Error("Chat image exceeds 4 MiB");
  return fileToDataUrl(blob);
}

export async function chatDeepSeek(
  sessionId: number, contextVersion: number, instruction: string, history: ChatTurn[], images: ChatImages,
): Promise<ChatResult> {
  const copies = Object.fromEntries(await Promise.all(Object.entries(images).map(async ([key, url]) =>
    [key, url ? await chatImageCopy(url) : null],
  )));
  return invoke("chat_deepseek", { request: { sessionId, contextVersion, instruction, history, ...copies } });
}
