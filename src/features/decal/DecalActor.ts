import * as THREE from "three";
import type { DecalImageInput, DecalImageOrigin } from "../../types/editor";
import { ProjectionCaptureActor } from "../capture/ProjectionCaptureActor";

/** One transformable projector and its provider-neutral RGBA source. */
export class DecalActor extends ProjectionCaptureActor {
  readonly targetMaterialId: string;

  private sourceCanvas: HTMLCanvasElement;
  private readonly maskCanvas: HTMLCanvasElement;
  private sourceTexture: THREE.CanvasTexture;
  private readonly maskTexture: THREE.CanvasTexture;
  private sourceLabel = "Captured BaseColor";
  private sourceOrigin: DecalImageOrigin = "capture";
  private useCaptureMask = true;
  private previewDataUrl: string;

  constructor(
    captureActor: ProjectionCaptureActor,
    targetMaterialId: string,
    capturedBaseColor: HTMLCanvasElement,
    capturedMask: HTMLCanvasElement,
  ) {
    super({
      center: captureActor.root.position,
      surfaceNormal: new THREE.Vector3(0, 0, 1),
      width: captureActor.getWidth(),
      height: captureActor.getHeight(),
      near: captureActor.getNear(),
      far: captureActor.getFar(),
    });
    this.root.name = "DecalActor";
    this.gizmo.name = "DecalGizmoBox";
    const captureGizmoMaterial = this.gizmo.material;
    if (Array.isArray(captureGizmoMaterial)) {
      captureGizmoMaterial.forEach((material) => material.dispose());
    } else {
      captureGizmoMaterial.dispose();
    }
    this.gizmo.material = new THREE.LineBasicMaterial({
      color: 0xffb35c,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      toneMapped: false,
    });
    this.root.position.copy(captureActor.root.position);
    this.root.quaternion.copy(captureActor.root.quaternion);
    this.targetMaterialId = targetMaterialId;
    this.sourceCanvas = this.cloneCanvas(capturedBaseColor);
    this.maskCanvas = this.cloneCanvas(capturedMask);
    this.previewDataUrl = this.sourceCanvas.toDataURL("image/png");
    this.sourceTexture = this.createTexture(this.sourceCanvas, true, "DecalSource");
    this.maskTexture = this.createTexture(this.maskCanvas, false, "DecalCaptureMask");
    this.root.updateMatrixWorld(true);
  }

  getSourceTexture(): THREE.Texture { return this.sourceTexture; }
  getMaskTexture(): THREE.Texture { return this.maskTexture; }
  getSourceCanvas(): HTMLCanvasElement { return this.sourceCanvas; }
  getSourceLabel(): string { return this.sourceLabel; }
  getSourceOrigin(): DecalImageOrigin { return this.sourceOrigin; }
  getUseCaptureMask(): boolean { return this.useCaptureMask; }

  setUseCaptureMask(enabled: boolean): void {
    this.useCaptureMask = enabled;
  }

  async setImage(input: DecalImageInput): Promise<void> {
    const image = await this.decodeBlob(input.blob);
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2D Canvas is unavailable for the Decal image");
    context.drawImage(image, 0, 0);

    const texture = this.createTexture(canvas, true, `DecalSource:${input.label}`);
    this.sourceTexture.dispose();
    this.sourceCanvas = canvas;
    this.sourceTexture = texture;
    this.sourceLabel = input.label;
    this.sourceOrigin = input.origin;
    this.previewDataUrl = canvas.toDataURL("image/png");
  }

  toPreviewDataUrl(): string {
    return this.previewDataUrl;
  }

  override dispose(): void {
    this.sourceTexture.dispose();
    this.maskTexture.dispose();
    super.dispose();
  }

  private createTexture(
    canvas: HTMLCanvasElement,
    srgb: boolean,
    name: string,
  ): THREE.CanvasTexture {
    const texture = new THREE.CanvasTexture(canvas);
    texture.name = name;
    texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    return texture;
  }

  private cloneCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = source.width;
    canvas.height = source.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2D Canvas is unavailable for Decal capture data");
    context.drawImage(source, 0, 0);
    return canvas;
  }

  private async decodeBlob(blob: Blob): Promise<HTMLImageElement> {
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.decoding = "async";
      image.src = url;
      await image.decode();
      if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
        throw new Error("The Decal image has no readable pixels");
      }
      return image;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}
