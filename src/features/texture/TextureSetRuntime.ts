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

export interface BaseColorSource {
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
  private bakedCanvas: HTMLCanvasElement | null = null;
  private bakedTexture: THREE.CanvasTexture | null = null;
  private baseColorModified = false;

  constructor(private readonly material: THREE.MeshStandardMaterial) {
    this.registerExistingMaps();
  }

  setTexture(channel: MaterialChannel, texture: THREE.Texture, fileName?: string): void {
    if (channel === "baseColor") {
      this.disposeWorkingPreview();
      this.disposeBakedBaseColor();
    }
    const { width, height } = this.readTextureSize(texture);
    this.channels.set(channel, {
      texture,
      fileName: fileName ?? (texture.name || null),
      width,
      height,
    });
  }

  getBaseColorSource(): BaseColorSource | null {
    const source = this.channels.get("baseColor");
    return source ? { texture: source.texture, width: source.width, height: source.height } : null;
  }

  /** Installs one full-resolution bake while keeping the imported source intact. */
  applyBakedBaseColor(canvas: HTMLCanvasElement): void {
    const source = this.channels.get("baseColor");
    if (!source) throw new Error("Bake requires an imported Base Color texture");
    this.disposeWorkingPreview();
    this.disposeBakedBaseColor();
    this.bakedCanvas = canvas;
    this.bakedTexture = new THREE.CanvasTexture(canvas);
    this.bakedTexture.name = `BakedBaseColor:${this.material.uuid}`;
    this.bakedTexture.colorSpace = THREE.SRGBColorSpace;
    // UV-space bake canvases store V=0 at the top to match GLTF image rows.
    this.bakedTexture.flipY = false;
    this.bakedTexture.wrapS = source.texture.wrapS;
    this.bakedTexture.wrapT = source.texture.wrapT;
    this.bakedTexture.minFilter = THREE.LinearFilter;
    this.bakedTexture.magFilter = THREE.LinearFilter;
    this.bakedTexture.generateMipmaps = false;
    this.material.map = this.bakedTexture;
    this.material.needsUpdate = true;
    this.baseColorModified = true;
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
      if (this.bakedTexture) {
        this.disposeWorkingPreview();
        this.material.map = this.bakedTexture;
        this.material.needsUpdate = true;
        this.baseColorModified = true;
      } else {
        this.resetBaseColor();
      }
      return true;
    }

    const scale = Math.min(1, 1024 / Math.max(source.width, source.height));
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    const effectSource = this.bakedTexture ?? source.texture;
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
    this.baseColorModified = true;
    return true;
  }

  resetBaseColor(): void {
    const source = this.channels.get("baseColor");
    if (source && this.material.map !== source.texture) {
      this.material.map = source.texture;
      this.material.needsUpdate = true;
    }
    this.disposeBakedBaseColor();
    this.baseColorModified = false;
  }

  /** Produces a full-resolution PNG without replacing the live preview map. */
  async exportBaseColor(
    mask: SelectionMask,
    settings: ColorAdjustmentSettings,
  ): Promise<Blob | null> {
    const source = this.channels.get("baseColor");
    if (!source || source.width <= 0 || source.height <= 0) return null;

    if (this.bakedCanvas && (this.isNeutral(settings) || !mask.hasContent)) {
      return await new Promise((resolve) => this.bakedCanvas?.toBlob(resolve, "image/png"));
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
        this.bakedTexture ?? source.texture,
        mask.sourceCanvas,
        settings,
      );
    }

    return await new Promise((resolve) => output.toBlob(resolve, "image/png"));
  }

  dispose(): void {
    this.resetBaseColor();
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
      isModified: channel === "baseColor" && this.baseColorModified,
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
    this.baseColorModified = false;
  }

  private disposeBakedBaseColor(): void {
    this.bakedTexture?.dispose();
    this.bakedTexture = null;
    this.bakedCanvas = null;
  }
}
