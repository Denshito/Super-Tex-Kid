import * as THREE from "three";
import type {
  DecalChannelSummary,
  DecalImageInput,
  DecalImageOrigin,
  MaterialChannel,
} from "../../types/editor";
import { ProjectionCaptureActor } from "../capture/ProjectionCaptureActor";

const CHANNELS: MaterialChannel[] = ["baseColor", "roughness", "metallic", "normal"];

interface DecalChannelResource {
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  label: string;
  origin: DecalImageOrigin;
  previewDataUrl: string;
  enabled: boolean;
}

/** One transformable projector with provider-neutral PBR channel sources. */
export class DecalActor extends ProjectionCaptureActor {
  readonly targetMaterialId: string;

  private readonly maskCanvas: HTMLCanvasElement;
  private readonly maskTexture: THREE.CanvasTexture;
  private readonly channels = new Map<MaterialChannel, DecalChannelResource>();
  private useCaptureMask = true;

  constructor(
    captureActor: ProjectionCaptureActor,
    targetMaterialId: string,
    capturedChannels: Record<MaterialChannel, HTMLCanvasElement>,
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
    this.maskCanvas = this.cloneCanvas(capturedMask);
    this.maskTexture = this.createTexture(this.maskCanvas, false, "DecalCaptureMask");
    for (const channel of CHANNELS) {
      const canvas = this.cloneCanvas(capturedChannels[channel]);
      this.channels.set(channel, {
        canvas,
        texture: this.createTexture(
          canvas,
          channel === "baseColor",
          `DecalSource:${channel}`,
        ),
        label: `Captured ${this.channelLabel(channel)}`,
        origin: "capture",
        previewDataUrl: canvas.toDataURL("image/png"),
        enabled: true,
      });
    }
    this.root.updateMatrixWorld(true);
  }

  getChannelTexture(channel: MaterialChannel): THREE.Texture {
    const resource = this.channels.get(channel);
    if (!resource) throw new Error(`Missing Decal ${channel} source`);
    return resource.texture;
  }

  getChannelCanvas(channel: MaterialChannel): HTMLCanvasElement {
    const resource = this.channels.get(channel);
    if (!resource) throw new Error(`Missing Decal ${channel} source`);
    return resource.canvas;
  }

  isChannelEnabled(channel: MaterialChannel): boolean {
    return this.channels.get(channel)?.enabled ?? false;
  }

  setChannelEnabled(channel: MaterialChannel, enabled: boolean): void {
    const resource = this.channels.get(channel);
    if (resource) resource.enabled = enabled;
  }

  getEnabledChannels(): MaterialChannel[] {
    return CHANNELS.filter((channel) => this.isChannelEnabled(channel));
  }

  getChannelSummaries(): Record<MaterialChannel, DecalChannelSummary> {
    return Object.fromEntries(CHANNELS.map((channel) => {
      const resource = this.channels.get(channel);
      if (!resource) throw new Error(`Missing Decal ${channel} source`);
      return [channel, {
        channel,
        sourceLabel: resource.label,
        sourceOrigin: resource.origin,
        previewDataUrl: resource.previewDataUrl,
        enabled: resource.enabled,
      }];
    })) as Record<MaterialChannel, DecalChannelSummary>;
  }

  getMaskTexture(): THREE.Texture { return this.maskTexture; }
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

    const resource = this.channels.get(input.channel);
    if (!resource) throw new Error(`Unknown Decal channel: ${input.channel}`);
    const texture = this.createTexture(
      canvas,
      input.channel === "baseColor",
      `DecalSource:${input.channel}:${input.label}`,
    );
    resource.texture.dispose();
    resource.canvas = canvas;
    resource.texture = texture;
    resource.label = input.label;
    resource.origin = input.origin;
    resource.previewDataUrl = canvas.toDataURL("image/png");
  }

  override dispose(): void {
    for (const resource of this.channels.values()) resource.texture.dispose();
    this.channels.clear();
    this.maskTexture.dispose();
    super.dispose();
  }

  private channelLabel(channel: MaterialChannel): string {
    return {
      baseColor: "Base Color",
      roughness: "Roughness",
      metallic: "Metallic",
      normal: "Normal",
    }[channel];
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
