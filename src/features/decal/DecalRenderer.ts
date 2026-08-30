import * as THREE from "three";
import type { BaseColorSource } from "../texture/TextureSetRuntime";
import { DecalActor } from "./DecalActor";

interface MeshCloneRecord {
  source: THREE.Mesh;
  clone: THREE.Mesh;
}

interface DecalUniforms {
  decalMap: THREE.IUniform<THREE.Texture | null>;
  maskMap: THREE.IUniform<THREE.Texture | null>;
  depthMap: THREE.IUniform<THREE.Texture | null>;
  useMask: THREE.IUniform<number>;
  projectorInverse: THREE.IUniform<THREE.Matrix4>;
  projectorNormal: THREE.IUniform<THREE.Vector3>;
  projectorWidth: THREE.IUniform<number>;
  projectorHeight: THREE.IUniform<number>;
  projectorNear: THREE.IUniform<number>;
  projectorFar: THREE.IUniform<number>;
  depthBias: THREE.IUniform<number>;
  previewOpacity: THREE.IUniform<number>;
}

/** Projective preview and one-shot UV-space BaseColor bake for one DecalActor. */
export class DecalRenderer {
  private readonly bakeMaterial: THREE.ShaderMaterial;
  private readonly discardMaterial = new THREE.ShaderMaterial({
    vertexShader: "void main(){gl_Position=vec4(0.0);}",
    fragmentShader: "void main(){discard;}",
  });
  private readonly depthMaterial = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: true,
    depthTest: true,
    side: THREE.DoubleSide,
  });
  private readonly copyMaterial: THREE.ShaderMaterial;
  private readonly fullscreenScene = new THREE.Scene();
  private readonly fullscreenCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly fullscreenQuad: THREE.Mesh;
  private readonly depthScene = new THREE.Scene();
  private readonly bakeScene = new THREE.Scene();
  private readonly depthRecords: MeshCloneRecord[] = [];
  private readonly bakeRecords: MeshCloneRecord[] = [];
  private readonly previewUniforms: DecalUniforms;
  private depthTarget: THREE.WebGLRenderTarget | null = null;
  private previewVisible = true;
  private previewMaterial: THREE.MeshStandardMaterial | null = null;
  private originalOnBeforeCompile: THREE.Material["onBeforeCompile"] | null = null;
  private originalCacheKey: THREE.Material["customProgramCacheKey"] | null = null;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.previewUniforms = {
      decalMap: { value: null as THREE.Texture | null },
      maskMap: { value: null as THREE.Texture | null },
      depthMap: { value: null as THREE.Texture | null },
      useMask: { value: 1 },
      projectorInverse: { value: new THREE.Matrix4() },
      projectorNormal: { value: new THREE.Vector3(0, 0, 1) },
      projectorWidth: { value: 1 },
      projectorHeight: { value: 1 },
      projectorNear: { value: 0.01 },
      projectorFar: { value: 1 },
      depthBias: { value: 0.001 },
      previewOpacity: { value: 1 },
    };
    const bakeFragmentShader = `
uniform sampler2D decalMap;
uniform sampler2D maskMap;
uniform sampler2D depthMap;
uniform float useMask;
uniform mat4 projectorInverse;
uniform vec3 projectorNormal;
uniform float projectorWidth;
uniform float projectorHeight;
uniform float projectorNear;
uniform float projectorFar;
uniform float depthBias;
varying vec3 vWorldPosition;
varying vec3 vWorldNormal;
void main() {
  vec3 localPosition = ( projectorInverse * vec4( vWorldPosition, 1.0 ) ).xyz;
  float viewDepth = -localPosition.z;
  if (
    abs( localPosition.x ) > projectorWidth * 0.5
    || abs( localPosition.y ) > projectorHeight * 0.5
    || viewDepth < projectorNear
    || viewDepth > projectorFar
  ) discard;

  float facing = dot( normalize( vWorldNormal ), normalize( projectorNormal ) );
  float angleFade = smoothstep( 0.258819, 0.5, facing );
  if ( angleFade <= 0.001 ) discard;

  vec2 depthUv = vec2(
    localPosition.x / projectorWidth + 0.5,
    localPosition.y / projectorHeight + 0.5
  );
  float sceneDepth = texture2D( depthMap, depthUv ).r;
  float surfaceDepth = ( viewDepth - projectorNear ) / ( projectorFar - projectorNear );
  if ( surfaceDepth > sceneDepth + depthBias ) discard;

  vec2 sourceUv = depthUv;
  vec4 decal = texture2D( decalMap, sourceUv );
  float captureMask = useMask > 0.5 ? texture2D( maskMap, sourceUv ).r : 1.0;
  decal.a *= captureMask * angleFade;
  if ( decal.a <= 0.001 ) discard;
  gl_FragColor = decal;
}`;
    this.bakeMaterial = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(
        this.previewUniforms as unknown as { [uniform: string]: THREE.IUniform },
      ),
      vertexShader: `
varying vec3 vWorldPosition;
varying vec3 vWorldNormal;
void main() {
  vec4 worldPosition = modelMatrix * vec4( position, 1.0 );
  vWorldPosition = worldPosition.xyz;
  vWorldNormal = normalize( mat3( modelMatrix ) * normal );
  vec2 bakeUv = vec2( uv.x, 1.0 - uv.y );
  gl_Position = vec4( bakeUv * 2.0 - 1.0, 0.0, 1.0 );
}`,
      fragmentShader: bakeFragmentShader,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.copyMaterial = new THREE.ShaderMaterial({
      uniforms: { sourceMap: { value: null } },
      vertexShader: `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}`,
      fragmentShader: `
uniform sampler2D sourceMap;
varying vec2 vUv;
void main() { gl_FragColor = texture2D( sourceMap, vec2( vUv.x, 1.0 - vUv.y ) ); }
`,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.fullscreenQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.copyMaterial);
    this.fullscreenScene.add(this.fullscreenQuad);
  }

  rebuild(
    contentRoot: THREE.Object3D,
    actor: DecalActor,
    targetMaterial: THREE.MeshStandardMaterial,
  ): void {
    this.clearMeshRecords();
    this.attachPreviewMaterial(targetMaterial);
    contentRoot.updateMatrixWorld(true);
    contentRoot.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const hasPositionMorphs = (child.geometry.morphAttributes.position?.length ?? 0) > 0;
      if (child instanceof THREE.SkinnedMesh || hasPositionMorphs) return;

      const depthClone = this.createClone(child, this.depthMaterial);
      this.depthScene.add(depthClone);
      this.depthRecords.push({ source: child, clone: depthClone });

      if (!child.geometry.getAttribute("uv")) return;
      const bakeMaterials = this.materialsForTarget(child, actor.targetMaterialId, this.bakeMaterial);
      if (!bakeMaterials) return;
      const bakeClone = this.createClone(child, bakeMaterials);
      this.bakeScene.add(bakeClone);
      this.bakeRecords.push({ source: child, clone: bakeClone });
    });
    this.update(actor, 512);
  }

  update(actor: DecalActor, depthResolution: number): void {
    actor.root.updateMatrixWorld(true);
    this.syncCloneMatrices(this.depthRecords);
    this.syncCloneMatrices(this.bakeRecords);
    this.ensureDepthTarget(depthResolution);
    if (!this.depthTarget?.depthTexture) return;

    const previousTarget = this.renderer.getRenderTarget();
    try {
      this.renderer.setRenderTarget(this.depthTarget);
      this.renderer.clear(true, true, true);
      this.renderer.render(this.depthScene, actor.camera);
    } finally {
      this.renderer.setRenderTarget(previousTarget);
    }

    this.updateUniforms(this.previewUniforms, actor, this.depthTarget.depthTexture);
    this.updateMaterial(this.bakeMaterial, actor, this.depthTarget.depthTexture);
  }

  bake(actor: DecalActor, source: BaseColorSource, depthResolution: number): HTMLCanvasElement {
    if (this.bakeRecords.length === 0) {
      throw new Error("The target material has no static UV-bearing triangles to bake");
    }
    const maxTextureSize = this.renderer.capabilities.maxTextureSize;
    if (source.width > maxTextureSize || source.height > maxTextureSize) {
      throw new Error(`Base Color exceeds the GPU texture limit (${maxTextureSize}px)`);
    }
    this.update(actor, depthResolution);
    const target = new THREE.WebGLRenderTarget(source.width, source.height, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    target.texture.name = "DecalBaseColorBake";
    target.texture.colorSpace = THREE.SRGBColorSpace;

    const previousTarget = this.renderer.getRenderTarget();
    const previousAutoClear = this.renderer.autoClear;
    try {
      this.copyMaterial.uniforms.sourceMap.value = source.texture;
      this.renderer.setRenderTarget(target);
      this.renderer.autoClear = true;
      this.renderer.clear(true, true, true);
      this.renderer.render(this.fullscreenScene, this.fullscreenCamera);
      this.renderer.autoClear = false;
      this.renderer.render(this.bakeScene, this.fullscreenCamera);
      return this.readTarget(target);
    } finally {
      this.renderer.autoClear = previousAutoClear;
      this.renderer.setRenderTarget(previousTarget);
      target.dispose();
    }
  }

  dispose(): void {
    this.clearMeshRecords();
    this.depthTarget?.dispose();
    this.depthTarget = null;
    this.bakeMaterial.dispose();
    this.discardMaterial.dispose();
    this.depthMaterial.dispose();
    this.copyMaterial.dispose();
    this.fullscreenQuad.geometry.dispose();
  }

  clear(): void {
    this.clearMeshRecords();
  }

  setPreviewVisible(visible: boolean): void {
    this.previewVisible = visible;
    this.previewUniforms.previewOpacity.value = visible ? 1 : 0;
  }

  private updateMaterial(
    material: THREE.ShaderMaterial,
    actor: DecalActor,
    depthTexture: THREE.Texture,
  ): void {
    this.updateUniforms(material.uniforms as unknown as DecalUniforms, actor, depthTexture);
  }

  private updateUniforms(
    uniforms: DecalUniforms,
    actor: DecalActor,
    depthTexture: THREE.Texture,
  ): void {
    uniforms.decalMap.value = actor.getSourceTexture();
    uniforms.maskMap.value = actor.getMaskTexture();
    uniforms.depthMap.value = depthTexture;
    uniforms.useMask.value = actor.getUseCaptureMask() ? 1 : 0;
    uniforms.projectorInverse.value.copy(actor.root.matrixWorld).invert();
    uniforms.projectorNormal.value.set(0, 0, 1).transformDirection(actor.root.matrixWorld);
    uniforms.projectorWidth.value = actor.getWidth();
    uniforms.projectorHeight.value = actor.getHeight();
    uniforms.projectorNear.value = actor.getNear();
    uniforms.projectorFar.value = actor.getFar();
    uniforms.depthBias.value = Math.max(
      (actor.getFar() - actor.getNear()) * 0.002,
      0.0001,
    ) / Math.max(actor.getFar() - actor.getNear(), 0.0001);
    uniforms.previewOpacity.value = this.previewVisible ? 1 : 0;
  }

  /** Adds BaseColor projection before the standard material evaluates PBR lighting. */
  private attachPreviewMaterial(material: THREE.MeshStandardMaterial): void {
    this.detachPreviewMaterial();
    this.previewMaterial = material;
    this.originalOnBeforeCompile = material.onBeforeCompile;
    this.originalCacheKey = material.customProgramCacheKey;
    const previousCompile = this.originalOnBeforeCompile;
    const previousCacheKey = this.originalCacheKey;
    const uniforms = this.previewUniforms;

    material.customProgramCacheKey = () => `${previousCacheKey.call(material)}|stk-decal-preview-v1`;
    material.onBeforeCompile = (shader, renderer) => {
      previousCompile.call(material, shader, renderer);
      shader.uniforms.uStkDecalMap = uniforms.decalMap;
      shader.uniforms.uStkDecalMaskMap = uniforms.maskMap;
      shader.uniforms.uStkDecalDepthMap = uniforms.depthMap;
      shader.uniforms.uStkDecalUseMask = uniforms.useMask;
      shader.uniforms.uStkDecalProjectorInverse = uniforms.projectorInverse;
      shader.uniforms.uStkDecalProjectorNormal = uniforms.projectorNormal;
      shader.uniforms.uStkDecalWidth = uniforms.projectorWidth;
      shader.uniforms.uStkDecalHeight = uniforms.projectorHeight;
      shader.uniforms.uStkDecalNear = uniforms.projectorNear;
      shader.uniforms.uStkDecalFar = uniforms.projectorFar;
      shader.uniforms.uStkDecalDepthBias = uniforms.depthBias;
      shader.uniforms.uStkDecalPreviewOpacity = uniforms.previewOpacity;

      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          `#include <common>
varying vec3 vStkDecalWorldPosition;
varying vec3 vStkDecalWorldNormal;`,
        )
        .replace(
          "#include <beginnormal_vertex>",
          `#include <beginnormal_vertex>
vStkDecalWorldNormal = normalize( mat3( modelMatrix ) * objectNormal );`,
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
vStkDecalWorldPosition = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
uniform sampler2D uStkDecalMap;
uniform sampler2D uStkDecalMaskMap;
uniform sampler2D uStkDecalDepthMap;
uniform float uStkDecalUseMask;
uniform mat4 uStkDecalProjectorInverse;
uniform vec3 uStkDecalProjectorNormal;
uniform float uStkDecalWidth;
uniform float uStkDecalHeight;
uniform float uStkDecalNear;
uniform float uStkDecalFar;
uniform float uStkDecalDepthBias;
uniform float uStkDecalPreviewOpacity;
varying vec3 vStkDecalWorldPosition;
varying vec3 vStkDecalWorldNormal;`,
        )
        .replace(
          "#include <map_fragment>",
          `#include <map_fragment>
vec3 stkDecalLocal = ( uStkDecalProjectorInverse * vec4( vStkDecalWorldPosition, 1.0 ) ).xyz;
float stkDecalViewDepth = -stkDecalLocal.z;
bool stkDecalInside = abs( stkDecalLocal.x ) <= uStkDecalWidth * 0.5
  && abs( stkDecalLocal.y ) <= uStkDecalHeight * 0.5
  && stkDecalViewDepth >= uStkDecalNear
  && stkDecalViewDepth <= uStkDecalFar;
if ( stkDecalInside && uStkDecalPreviewOpacity > 0.0 ) {
  float stkDecalFacing = dot(
    normalize( vStkDecalWorldNormal ),
    normalize( uStkDecalProjectorNormal )
  );
  float stkDecalAngleFade = smoothstep( 0.258819, 0.5, stkDecalFacing );
  vec2 stkDecalUv = vec2(
    stkDecalLocal.x / uStkDecalWidth + 0.5,
    stkDecalLocal.y / uStkDecalHeight + 0.5
  );
  float stkDecalSceneDepth = texture2D( uStkDecalDepthMap, stkDecalUv ).r;
  float stkDecalSurfaceDepth = ( stkDecalViewDepth - uStkDecalNear )
    / ( uStkDecalFar - uStkDecalNear );
  if ( stkDecalSurfaceDepth <= stkDecalSceneDepth + uStkDecalDepthBias ) {
    vec2 stkDecalSourceUv = stkDecalUv;
    vec4 stkDecalSample = texture2D( uStkDecalMap, stkDecalSourceUv );
    float stkDecalMask = uStkDecalUseMask > 0.5
      ? texture2D( uStkDecalMaskMap, stkDecalSourceUv ).r
      : 1.0;
    float stkDecalAlpha = stkDecalSample.a * stkDecalMask
      * stkDecalAngleFade * uStkDecalPreviewOpacity;
    diffuseColor.rgb = mix( diffuseColor.rgb, stkDecalSample.rgb * diffuse, stkDecalAlpha );
  }
}`,
        );
    };
    material.needsUpdate = true;
  }

  private detachPreviewMaterial(): void {
    if (!this.previewMaterial || !this.originalOnBeforeCompile || !this.originalCacheKey) return;
    this.previewMaterial.onBeforeCompile = this.originalOnBeforeCompile;
    this.previewMaterial.customProgramCacheKey = this.originalCacheKey;
    this.previewMaterial.needsUpdate = true;
    this.previewMaterial = null;
    this.originalOnBeforeCompile = null;
    this.originalCacheKey = null;
  }

  private materialsForTarget(
    mesh: THREE.Mesh,
    targetMaterialId: string,
    targetMaterial: THREE.Material,
  ): THREE.Material | THREE.Material[] | null {
    if (!Array.isArray(mesh.material)) {
      return mesh.material.uuid === targetMaterialId ? targetMaterial : null;
    }
    if (!mesh.material.some((material) => material.uuid === targetMaterialId)) return null;
    return mesh.material.map((material) => (
      material.uuid === targetMaterialId ? targetMaterial : this.discardMaterial
    ));
  }

  private createClone(
    source: THREE.Mesh,
    material: THREE.Material | THREE.Material[],
  ): THREE.Mesh {
    const clone = new THREE.Mesh(source.geometry, material);
    clone.matrixAutoUpdate = false;
    clone.frustumCulled = false;
    clone.matrix.copy(source.matrixWorld);
    return clone;
  }

  private syncCloneMatrices(records: MeshCloneRecord[]): void {
    for (const record of records) {
      record.source.updateWorldMatrix(true, false);
      record.clone.matrix.copy(record.source.matrixWorld);
      record.clone.matrixWorldNeedsUpdate = true;
    }
  }

  private ensureDepthTarget(resolution: number): void {
    const size = THREE.MathUtils.clamp(Math.round(resolution), 256, 1024);
    if (this.depthTarget?.width === size && this.depthTarget.height === size) return;
    this.depthTarget?.dispose();
    this.depthTarget = new THREE.WebGLRenderTarget(size, size, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.depthTarget.depthTexture = new THREE.DepthTexture(size, size, THREE.UnsignedIntType);
    this.depthTarget.depthTexture.format = THREE.DepthFormat;
    this.depthTarget.depthTexture.minFilter = THREE.NearestFilter;
    this.depthTarget.depthTexture.magFilter = THREE.NearestFilter;
  }

  private readTarget(target: THREE.WebGLRenderTarget): HTMLCanvasElement {
    const pixels = new Uint8Array(target.width * target.height * 4);
    this.renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, pixels);
    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2D Canvas is unavailable for the Base Color bake");
    const image = context.createImageData(target.width, target.height);
    const stride = target.width * 4;
    for (let y = 0; y < target.height; y += 1) {
      const sourceOffset = (target.height - 1 - y) * stride;
      image.data.set(pixels.subarray(sourceOffset, sourceOffset + stride), y * stride);
    }
    context.putImageData(image, 0, 0);
    return canvas;
  }

  private clearMeshRecords(): void {
    this.detachPreviewMaterial();
    for (const record of this.depthRecords) record.clone.removeFromParent();
    for (const record of this.bakeRecords) record.clone.removeFromParent();
    this.depthRecords.length = 0;
    this.bakeRecords.length = 0;
  }
}
