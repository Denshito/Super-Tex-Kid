import * as THREE from "three";

export interface MaskPaintSample {
  u: number;
  v: number;
  alpha: number;
  radiusU: number;
  radiusV: number;
}

/**
 * Stores an authoritative material selection plus a smaller viewport preview.
 * The full-size canvas preserves texture-space precision, while the preview
 * avoids uploading a multi-megabyte texture for every pointer movement.
 */
export class SelectionMask {
  readonly sourceCanvas: HTMLCanvasElement;
  readonly previewCanvas: HTMLCanvasElement;
  readonly previewTexture: THREE.CanvasTexture;

  private readonly sourceContext: CanvasRenderingContext2D;
  private readonly previewContext: CanvasRenderingContext2D;
  private _hasContent = false;

  constructor(
    readonly textureSetId: string,
    readonly width: number,
    readonly height: number,
    maxPreviewSize = 1024,
  ) {
    this.sourceCanvas = document.createElement("canvas");
    this.sourceCanvas.width = width;
    this.sourceCanvas.height = height;
    this.sourceContext = this.getContext(this.sourceCanvas);

    const previewScale = Math.min(1, maxPreviewSize / Math.max(width, height));
    this.previewCanvas = document.createElement("canvas");
    this.previewCanvas.width = Math.max(1, Math.round(width * previewScale));
    this.previewCanvas.height = Math.max(1, Math.round(height * previewScale));
    this.previewContext = this.getContext(this.previewCanvas);

    this.clearContext(this.sourceContext, this.sourceCanvas);
    this.clearContext(this.previewContext, this.previewCanvas);

    this.previewTexture = new THREE.CanvasTexture(this.previewCanvas);
    this.previewTexture.name = `SelectionMask:${textureSetId}`;
    this.previewTexture.colorSpace = THREE.NoColorSpace;
    this.previewTexture.minFilter = THREE.LinearFilter;
    this.previewTexture.magFilter = THREE.LinearFilter;
    this.previewTexture.generateMipmaps = false;
  }

  get hasContent(): boolean {
    return this._hasContent;
  }

  /**
   * Paints both resolutions immediately.
   *
   * This remains useful for one-shot edits. Interactive strokes use the split
   * preview/source methods below so high-resolution Canvas work never blocks
   * every pointer frame.
   */
  paint(samples: MaskPaintSample[]): void {
    if (samples.length === 0) return;
    this.paintSource(samples);
    this.paintPreview(samples);
  }

  /** Updates only the lightweight viewport texture during an active stroke. */
  paintPreview(samples: MaskPaintSample[]): void {
    if (samples.length === 0) return;
    this.paintInto(this.previewContext, this.previewCanvas, samples);
    this.previewTexture.needsUpdate = true;
    this._hasContent = true;
  }

  /** Commits the recorded stroke to the authoritative full-resolution mask. */
  paintSource(samples: MaskPaintSample[]): void {
    if (samples.length === 0) return;
    this.paintInto(this.sourceContext, this.sourceCanvas, samples);
    this._hasContent = true;
  }

  clear(): void {
    this.clearContext(this.sourceContext, this.sourceCanvas);
    this.clearContext(this.previewContext, this.previewCanvas);
    this.previewTexture.needsUpdate = true;
    this._hasContent = false;
  }

  toPreviewDataUrl(): string {
    return this.previewCanvas.toDataURL("image/png");
  }

  exportPng(): string {
    return this.sourceCanvas.toDataURL("image/png");
  }

  dispose(): void {
    this.previewTexture.dispose();
  }

  private paintInto(
    context: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    samples: MaskPaintSample[],
  ): void {
    context.save();
    context.fillStyle = "white";
    context.globalCompositeOperation = "source-over";

    for (const sample of samples) {
      if (sample.u < 0 || sample.u > 1 || sample.v < 0 || sample.v > 1) continue;

      const x = sample.u * canvas.width;
      const y = (1 - sample.v) * canvas.height;
      const radiusX = Math.max(0.75, sample.radiusU * canvas.width);
      const radiusY = Math.max(0.75, sample.radiusV * canvas.height);

      context.globalAlpha = THREE.MathUtils.clamp(sample.alpha, 0, 1);
      context.beginPath();
      context.ellipse(x, y, radiusX, radiusY, 0, 0, Math.PI * 2);
      context.fill();
    }

    context.restore();
  }

  private clearContext(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
    context.save();
    context.globalCompositeOperation = "copy";
    context.fillStyle = "black";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.restore();
  }

  private getContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("2D Canvas is unavailable for the selection mask");
    return context;
  }
}
