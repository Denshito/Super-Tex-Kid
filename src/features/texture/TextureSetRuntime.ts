import * as THREE from "three";
import type {
  ChannelAssetSummary,
  ColorAdjustmentSettings,
  MaterialChannel,
  TextureSetSummary,
} from "../../types/editor";
import type { SelectionMask } from "../mask/SelectionMask";

interface ChannelAsset {
  texture: THREE.Texture;
  fileName: string | null;
  width: number;
  height: number;
}

export interface TextureChannelSource {
  channel: MaterialChannel;
  texture: THREE.Texture;
  width: number;
  height: number;
}

/**
 * Runtime-owned texture data for one material/texture set.
 *
 * Source textures remain immutable. Local effects render into a disposable
 * working CanvasTexture, so Reset can restore the exact source map and future
 * effect-stack or AI nodes can reuse the same source/working boundary.
 */
export class TextureSetRuntime {
  private readonly channels = new Map<MaterialChannel, ChannelAsset>();
  private previewCanvas: HTMLCanvasElement | null = null;
  private adjustedCanvas: HTMLCanvasElement | null = null;
  private previewMaskCanvas: HTMLCanvasElement | null = null;
  private previewTexture: THREE.CanvasTexture | null = null;
  private readonly bakedCanvases = new Map<MaterialChannel, HTMLCanvasElement>();
  private readonly bakedTextures = new Map<MaterialChannel, THREE.CanvasTexture>();
  private readonly modifiedChannels = new Set<MaterialChannel>();

  constructor(private readonly material: THREE.MeshStandardMaterial) {
    this.registerExistingMaps();
  }

  setTexture(channel: MaterialChannel, texture: THREE.Texture, fileName?: string): void {
    if (channel === "baseColor") {
      this.disposeWorkingPreview();
    }
    this.disposeBakedChannel(channel);
    const { width, height } = this.readTextureSize(texture);
    this.channels.set(channel, {
      texture,
      fileName: fileName ?? (texture.name || null),
      width,
      height,
    });
  }

  getChannelSource(channel: MaterialChannel): TextureChannelSource | null {
    const source = this.channels.get(channel);
    return source ? {
      channel,
      texture: source.texture,
      width: source.width,
      height: source.height,
    } : null;
  }

  /** Installs a complete multi-channel bake only after every texture is ready. */
  applyBakedChannels(canvases: Map<MaterialChannel, HTMLCanvasElement>): void {
    const prepared = new Map<MaterialChannel, THREE.CanvasTexture>();
    try {
      for (const [channel, canvas] of canvases) {
        const source = this.channels.get(channel);
        if (!source) throw new Error(`Bake requires an imported ${this.channelLabel(channel)} texture`);
        const texture = new THREE.CanvasTexture(canvas);
        texture.name = `Baked${this.channelLabel(channel)}:${this.material.uuid}`;
        texture.colorSpace = channel === "baseColor" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        // UV-space bake canvases store V=0 at the top to match GLTF image rows.
        texture.flipY = false;
        texture.wrapS = source.texture.wrapS;
        texture.wrapT = source.texture.wrapT;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
        prepared.set(channel, texture);
      }
    } catch (error) {
      for (const texture of prepared.values()) texture.dispose();
      throw error;
    }

    if (canvases.has("baseColor")) this.disposeWorkingPreview();
    for (const [channel, canvas] of canvases) {
      this.disposeBakedChannel(channel);
      const texture = prepared.get(channel);
      if (!texture) continue;
      this.bakedCanvases.set(channel, canvas);
      this.bakedTextures.set(channel, texture);
      this.modifiedChannels.add(channel);
      this.assignMaterialTexture(channel, texture);
    }
    this.material.needsUpdate = true;
  }

  getSummary(): TextureSetSummary {
    return {
      textureSetId: this.material.uuid,
      materialName: this.material.name || "Unnamed Material",
      channels: {
        baseColor: this.channelSummary("baseColor"),
        normal: this.channelSummary("normal"),
        roughness: this.channelSummary("roughness"),
        metallic: this.channelSummary("metallic"),
      },
    };
  }

  /** Renders a capped-resolution working map for responsive PBR feedback. */
  applyBaseColorAdjustment(mask: SelectionMask, settings: ColorAdjustmentSettings): boolean {
    const source = this.channels.get("baseColor");
    if (!source || source.width <= 0 || source.height <= 0) return false;
    if (this.isNeutral(settings) || !mask.hasContent) {
      const bakedTexture = this.bakedTextures.get("baseColor");
      if (bakedTexture) {
        this.disposeWorkingPreview();
        this.material.map = bakedTexture;
        this.material.needsUpdate = true;
        this.modifiedChannels.add("baseColor");
      } else {
        this.resetChannel("baseColor");
      }
      return true;
    }

    const scale = Math.min(1, 1024 / Math.max(source.width, source.height));
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    const effectSource = this.bakedTextures.get("baseColor") ?? source.texture;
    this.ensurePreviewResources(width, height, effectSource);
    if (!this.previewCanvas || !this.adjustedCanvas || !this.previewTexture) return false;

    this.renderComposite(
      this.previewCanvas,
      this.adjustedCanvas,
      effectSource,
      mask.sourceCanvas,
      settings,
    );
    this.previewTexture.needsUpdate = true;
    this.material.map = this.previewTexture;
    this.material.needsUpdate = true;
    this.modifiedChannels.add("baseColor");
    return true;
  }

  resetChannel(channel: MaterialChannel): void {
    const source = this.channels.get(channel);
    if (!source) return;
    if (channel === "baseColor") this.disposeWorkingPreview();
    this.assignMaterialTexture(channel, source.texture);
    this.disposeBakedChannel(channel);
    this.modifiedChannels.delete(channel);
    this.material.needsUpdate = true;
  }

  /** Produces one full-resolution channel PNG without changing the material. */
  async exportChannel(
    channel: MaterialChannel,
    mask?: SelectionMask,
    settings?: ColorAdjustmentSettings,
  ): Promise<Blob | null> {
    const source = this.channels.get(channel);
    if (!source || source.width <= 0 || source.height <= 0) return null;

    const bakedCanvas = this.bakedCanvases.get(channel);
    if (channel !== "baseColor") {
      if (bakedCanvas) return await new Promise((resolve) => bakedCanvas.toBlob(resolve, "image/png"));
      return await this.textureToBlob(source);
    }
    if (!mask || !settings) return null;
    if (bakedCanvas && (this.isNeutral(settings) || !mask.hasContent)) {
      return await new Promise((resolve) => bakedCanvas.toBlob(resolve, "image/png"));
    }

    const output = document.createElement("canvas");
    output.width = source.width;
    output.height = source.height;
    const adjusted = document.createElement("canvas");
    adjusted.width = source.width;
    adjusted.height = source.height;

    if (this.isNeutral(settings) || !mask.hasContent) {
      const context = this.getContext(output);
      context.drawImage(this.textureImage(source.texture), 0, 0, output.width, output.height);
    } else {
      this.renderComposite(
        output,
        adjusted,
        this.bakedTextures.get("baseColor") ?? source.texture,
        mask.sourceCanvas,
        settings,
      );
    }

    return await new Promise((resolve) => output.toBlob(resolve, "image/png"));
  }

  dispose(): void {
    for (const channel of this.channels.keys()) this.resetChannel(channel);
    this.disposeWorkingPreview();
    this.channels.clear();
  }

  private registerExistingMaps(): void {
    if (this.material.map) this.setTexture("baseColor", this.material.map);
    if (this.material.normalMap) this.setTexture("normal", this.material.normalMap);
    if (this.material.roughnessMap) this.setTexture("roughness", this.material.roughnessMap);
    if (this.material.metalnessMap) this.setTexture("metallic", this.material.metalnessMap);
  }

  private channelSummary(channel: MaterialChannel): ChannelAssetSummary {
    const asset = this.channels.get(channel);
    return {
      channel,
      fileName: asset?.fileName ?? null,
      width: asset?.width ?? 0,
      height: asset?.height ?? 0,
      colorSpace: channel === "baseColor" ? "srgb" : "linear",
      isLoaded: Boolean(asset),
      isModified: this.modifiedChannels.has(channel),
    };
  }

  private ensurePreviewResources(
    width: number,
    height: number,
    sourceTexture: THREE.Texture,
  ): void {
    if (this.previewCanvas?.width === width && this.previewCanvas.height === height) return;
    this.disposeWorkingPreview();

    this.previewCanvas = document.createElement("canvas");
    this.previewCanvas.width = width;
    this.previewCanvas.height = height;
    this.adjustedCanvas = document.createElement("canvas");
    this.adjustedCanvas.width = width;
    this.adjustedCanvas.height = height;
    this.previewMaskCanvas = document.createElement("canvas");
    this.previewMaskCanvas.width = width;
    this.previewMaskCanvas.height = height;

    this.previewTexture = new THREE.CanvasTexture(this.previewCanvas);
    this.previewTexture.name = `WorkingBaseColor:${this.material.uuid}`;
    this.previewTexture.colorSpace = THREE.SRGBColorSpace;
    this.previewTexture.flipY = sourceTexture.flipY;
    this.previewTexture.wrapS = sourceTexture.wrapS;
    this.previewTexture.wrapT = sourceTexture.wrapT;
    this.previewTexture.minFilter = THREE.LinearFilter;
    this.previewTexture.magFilter = THREE.LinearFilter;
    this.previewTexture.generateMipmaps = false;
  }

  private renderComposite(
    output: HTMLCanvasElement,
    adjusted: HTMLCanvasElement,
    sourceTexture: THREE.Texture,
    maskCanvas: HTMLCanvasElement,
    settings: ColorAdjustmentSettings,
  ): void {
    const sourceImage = this.textureImage(sourceTexture);
    const outputContext = this.getContext(output, false);
    const adjustedContext = this.getContext(adjusted, true);

    adjustedContext.save();
    adjustedContext.clearRect(0, 0, adjusted.width, adjusted.height);
    adjustedContext.filter = [
      `hue-rotate(${settings.hueDegrees}deg)`,
      `saturate(${settings.saturation})`,
      `brightness(${settings.brightness})`,
      `contrast(${settings.contrast})`,
    ].join(" ");
    adjustedContext.drawImage(sourceImage, 0, 0, adjusted.width, adjusted.height);
    adjustedContext.filter = "none";
    adjustedContext.restore();

    // SelectionMask stores coverage in RGB on an opaque canvas. Convert its
    // red channel into adjusted-image alpha instead of using destination-in,
    // which would incorrectly treat both black and white mask pixels as opaque.
    const scaledMask = adjusted === this.adjustedCanvas && this.previewMaskCanvas
      ? this.previewMaskCanvas
      : document.createElement("canvas");
    scaledMask.width = adjusted.width;
    scaledMask.height = adjusted.height;
    const maskContext = this.getContext(scaledMask, false);
    maskContext.save();
    // SelectionMask stores canonical UV space with V=1 at the canvas top.
    // CanvasTexture normally flips that image during upload, which is why the
    // red/gray viewport overlay aligns. GLTF and manually imported maps use
    // flipY=false, however, so their raw image rows run in the opposite
    // direction. Mirror only the compositing mask to match the source map's
    // actual upload orientation; the authoritative selection remains intact.
    if (!sourceTexture.flipY) {
      maskContext.translate(0, scaledMask.height);
      maskContext.scale(1, -1);
    }
    maskContext.drawImage(maskCanvas, 0, 0, scaledMask.width, scaledMask.height);
    maskContext.restore();
    const maskPixels = maskContext.getImageData(0, 0, scaledMask.width, scaledMask.height).data;
    const adjustedImage = adjustedContext.getImageData(0, 0, adjusted.width, adjusted.height);
    const strength = THREE.MathUtils.clamp(settings.strength, 0, 1);
    for (let offset = 0; offset < adjustedImage.data.length; offset += 4) {
      adjustedImage.data[offset + 3] = Math.round(maskPixels[offset] * strength);
    }
    adjustedContext.putImageData(adjustedImage, 0, 0);

    outputContext.save();
    outputContext.globalCompositeOperation = "copy";
    outputContext.drawImage(sourceImage, 0, 0, output.width, output.height);
    outputContext.globalCompositeOperation = "source-over";
    outputContext.drawImage(adjusted, 0, 0, output.width, output.height);
    outputContext.restore();
  }

  private isNeutral(settings: ColorAdjustmentSettings): boolean {
    return settings.strength <= 0
      || (Math.abs(settings.hueDegrees) < 0.001
        && Math.abs(settings.saturation - 1) < 0.001
        && Math.abs(settings.brightness - 1) < 0.001
        && Math.abs(settings.contrast - 1) < 0.001);
  }

  private textureImage(texture: THREE.Texture): CanvasImageSource {
    const image = texture.source.data as CanvasImageSource | null;
    if (!image) throw new Error("Base Color texture has no CPU-readable image source");
    return image;
  }

  private readTextureSize(texture: THREE.Texture): { width: number; height: number } {
    const image = texture.source.data as {
      width?: number;
      height?: number;
      naturalWidth?: number;
      naturalHeight?: number;
      videoWidth?: number;
      videoHeight?: number;
    } | null;
    return {
      width: image?.width ?? image?.naturalWidth ?? image?.videoWidth ?? 0,
      height: image?.height ?? image?.naturalHeight ?? image?.videoHeight ?? 0,
    };
  }

  private getContext(canvas: HTMLCanvasElement, alpha = false): CanvasRenderingContext2D {
    const context = canvas.getContext("2d", { alpha });
    if (!context) throw new Error("2D Canvas is unavailable for texture processing");
    return context;
  }

  private disposeWorkingPreview(): void {
    this.previewTexture?.dispose();
    this.previewTexture = null;
    this.previewCanvas = null;
    this.adjustedCanvas = null;
    this.previewMaskCanvas = null;
  }

  private disposeBakedChannel(channel: MaterialChannel): void {
    this.bakedTextures.get(channel)?.dispose();
    this.bakedTextures.delete(channel);
    this.bakedCanvases.delete(channel);
    this.modifiedChannels.delete(channel);
  }

  private assignMaterialTexture(channel: MaterialChannel, texture: THREE.Texture): void {
    switch (channel) {
      case "baseColor": this.material.map = texture; break;
      case "roughness": this.material.roughnessMap = texture; break;
      case "metallic": this.material.metalnessMap = texture; break;
      case "normal": this.material.normalMap = texture; break;
    }
  }

  private async textureToBlob(source: ChannelAsset): Promise<Blob | null> {
    const canvas = document.createElement("canvas");
    canvas.width = source.width;
    canvas.height = source.height;
    this.getContext(canvas, true).drawImage(
      this.textureImage(source.texture),
      0,
      0,
      canvas.width,
      canvas.height,
    );
    return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  }

  private channelLabel(channel: MaterialChannel): string {
    return {
      baseColor: "BaseColor",
      roughness: "Roughness",
      metallic: "Metallic",
      normal: "Normal",
    }[channel];
  }
}
