import * as THREE from "three";
import type { MaterialChannel } from "../../types/editor";
import type { TextureChannelSource } from "../texture/TextureSetRuntime";
import { DecalActor } from "./DecalActor";

interface MeshCloneRecord {
  source: THREE.Mesh;
  clone: THREE.Mesh;
}

interface DecalUniforms {
  baseColorMap: THREE.IUniform<THREE.Texture | null>;
  roughnessMap: THREE.IUniform<THREE.Texture | null>;
  metallicMap: THREE.IUniform<THREE.Texture | null>;
  normalMap: THREE.IUniform<THREE.Texture | null>;
  maskMap: THREE.IUniform<THREE.Texture | null>;
  depthMap: THREE.IUniform<THREE.Texture | null>;
  baseColorEnabled: THREE.IUniform<number>;
  roughnessEnabled: THREE.IUniform<number>;
  metallicEnabled: THREE.IUniform<number>;
  normalEnabled: THREE.IUniform<number>;
  useMask: THREE.IUniform<number>;
  projectorInverse: THREE.IUniform<THREE.Matrix4>;
  projectorNormal: THREE.IUniform<THREE.Vector3>;
  projectorXAxis: THREE.IUniform<THREE.Vector3>;
  projectorYAxis: THREE.IUniform<THREE.Vector3>;
  projectorWidth: THREE.IUniform<number>;
  projectorHeight: THREE.IUniform<number>;
  projectorNear: THREE.IUniform<number>;
  projectorFar: THREE.IUniform<number>;
  depthBias: THREE.IUniform<number>;
  previewOpacity: THREE.IUniform<number>;
}

const CHANNEL_MODE: Record<MaterialChannel, number> = {
  baseColor: 0,
  roughness: 1,
  metallic: 2,
  normal: 3,
};

const DECAL_GLSL_HELPERS = `
mat3 stkCotangentFrame( vec3 N, vec3 p, vec2 uv ) {
  vec3 dp1 = dFdx( p );
  vec3 dp2 = dFdy( p );
  vec2 duv1 = dFdx( uv );
  vec2 duv2 = dFdy( uv );
  vec3 dp2perp = cross( dp2, N );
  vec3 dp1perp = cross( N, dp1 );
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
  float maxLength = max( dot( T, T ), dot( B, B ) );
  float scale = maxLength > 0.0 ? inversesqrt( maxLength ) : 0.0;
  return mat3( T * scale, B * scale, N );
}

vec3 stkBlendRnm( vec3 baseNormal, vec3 detailNormal ) {
  vec3 t = baseNormal + vec3( 0.0, 0.0, 1.0 );
  vec3 u = detailNormal * vec3( -1.0, -1.0, 1.0 );
  return normalize( t * dot( t, u ) / max( t.z, 0.0001 ) - u );
}

vec3 stkProjectorNormalToTarget(
  vec3 encodedNormal,
  vec3 worldPosition,
  vec3 geometryNormal,
  vec2 targetUv,
  vec3 projectorX,
  vec3 projectorY
) {
  vec3 N = normalize( geometryNormal );
  mat3 targetFrame = stkCotangentFrame( N, worldPosition, targetUv );
  vec3 T = projectorX - N * dot( projectorX, N );
  if ( dot( T, T ) < 0.000001 ) T = targetFrame[ 0 ];
  T = normalize( T );
  vec3 B = normalize( cross( N, T ) );
  if ( dot( B, projectorY ) < 0.0 ) B = -B;
  vec3 decalNormal = normalize( encodedNormal * 2.0 - 1.0 );
  vec3 worldNormal = normalize( T * decalNormal.x + B * decalNormal.y + N * decalNormal.z );
  return normalize( vec3(
    dot( worldNormal, targetFrame[ 0 ] ),
    dot( worldNormal, targetFrame[ 1 ] ),
    dot( worldNormal, targetFrame[ 2 ] )
  ) );
}`;

/** Projective PBR preview and transactional UV-space bake for one DecalActor. */
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
    this.previewUniforms = this.createDecalUniforms();
    const bakeUniforms = {
      ...THREE.UniformsUtils.clone(
        this.previewUniforms as unknown as { [uniform: string]: THREE.IUniform },
      ),
      targetMap: { value: null as THREE.Texture | null },
      channelMode: { value: 0 },
    };
    this.bakeMaterial = new THREE.ShaderMaterial({
      uniforms: bakeUniforms,
      vertexShader: `
varying vec3 vWorldPosition;
varying vec3 vWorldNormal;
varying vec2 vTargetUv;
void main() {
  vec4 worldPosition = modelMatrix * vec4( position, 1.0 );
  vWorldPosition = worldPosition.xyz;
  vWorldNormal = normalize( mat3( modelMatrix ) * normal );
  vTargetUv = uv;
  vec2 bakeUv = vec2( uv.x, 1.0 - uv.y );
  gl_Position = vec4( bakeUv * 2.0 - 1.0, 0.0, 1.0 );
}`,
      fragmentShader: `
uniform sampler2D targetMap;
uniform sampler2D baseColorMap;
uniform sampler2D roughnessMap;
uniform sampler2D metallicMap;
uniform sampler2D normalMap;
uniform sampler2D maskMap;
uniform sampler2D depthMap;
uniform float useMask;
uniform mat4 projectorInverse;
uniform vec3 projectorNormal;
uniform vec3 projectorXAxis;
uniform vec3 projectorYAxis;
uniform float projectorWidth;
uniform float projectorHeight;
uniform float projectorNear;
uniform float projectorFar;
uniform float depthBias;
uniform int channelMode;
varying vec3 vWorldPosition;
varying vec3 vWorldNormal;
varying vec2 vTargetUv;
${DECAL_GLSL_HELPERS}
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

  vec2 sourceUv = vec2(
    localPosition.x / projectorWidth + 0.5,
    localPosition.y / projectorHeight + 0.5
  );
  float sceneDepth = texture2D( depthMap, sourceUv ).r;
  float surfaceDepth = ( viewDepth - projectorNear ) / ( projectorFar - projectorNear );
  if ( surfaceDepth > sceneDepth + depthBias ) discard;

  vec4 baseDecal = texture2D( baseColorMap, sourceUv );
  vec4 channelDecal = channelMode == 0
    ? baseDecal
    : channelMode == 1
      ? texture2D( roughnessMap, sourceUv )
      : channelMode == 2
        ? texture2D( metallicMap, sourceUv )
        : texture2D( normalMap, sourceUv );
  float captureMask = useMask > 0.5 ? texture2D( maskMap, sourceUv ).r : 1.0;
  float alpha = baseDecal.a * captureMask * angleFade;
  if ( channelMode != 0 ) alpha *= channelDecal.a;
  if ( alpha <= 0.001 ) discard;

  vec4 targetSample = texture2D( targetMap, vTargetUv );
  if ( channelMode == 0 ) {
    targetSample.rgb = mix( targetSample.rgb, baseDecal.rgb, alpha );
    targetSample.a = alpha + targetSample.a * ( 1.0 - alpha );
  } else if ( channelMode == 1 ) {
    targetSample.g = mix( targetSample.g, channelDecal.g, alpha );
  } else if ( channelMode == 2 ) {
    targetSample.b = mix( targetSample.b, channelDecal.b, alpha );
  } else {
    vec3 baseNormal = normalize( targetSample.rgb * 2.0 - 1.0 );
    vec3 detailNormal = stkProjectorNormalToTarget(
      channelDecal.rgb,
      vWorldPosition,
      vWorldNormal,
      vTargetUv,
      projectorXAxis,
      projectorYAxis
    );
    vec3 combinedNormal = stkBlendRnm( baseNormal, detailNormal );
    targetSample.rgb = normalize( mix( baseNormal, combinedNormal, alpha ) ) * 0.5 + 0.5;
  }
  gl_FragColor = targetSample;
}`,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
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

    this.updateUniforms(this.previewUniforms, actor, this.depthTarget.depthTexture, true);
    this.updateUniforms(
      this.bakeMaterial.uniforms as unknown as DecalUniforms,
      actor,
      this.depthTarget.depthTexture,
      false,
    );
  }

  bake(
    actor: DecalActor,
    sources: Map<MaterialChannel, TextureChannelSource>,
    depthResolution: number,
  ): Map<MaterialChannel, HTMLCanvasElement> {
    if (this.bakeRecords.length === 0) {
      throw new Error("The target material has no static UV-bearing triangles to bake");
    }
    const maxTextureSize = this.renderer.capabilities.maxTextureSize;
    for (const source of sources.values()) {
      if (source.width > maxTextureSize || source.height > maxTextureSize) {
        throw new Error(`${source.channel} exceeds the GPU texture limit (${maxTextureSize}px)`);
      }
    }
    this.update(actor, depthResolution);
    const outputs = new Map<MaterialChannel, HTMLCanvasElement>();
    for (const channel of actor.getEnabledChannels()) {
      const source = sources.get(channel);
      if (!source) throw new Error(`Missing target ${channel} texture`);
      outputs.set(channel, this.bakeChannel(source));
    }
    return outputs;
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

  private bakeChannel(source: TextureChannelSource): HTMLCanvasElement {
    const target = new THREE.WebGLRenderTarget(source.width, source.height, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    target.texture.name = `Decal${source.channel}Bake`;
    target.texture.colorSpace = source.channel === "baseColor"
      ? THREE.SRGBColorSpace
      : THREE.NoColorSpace;

    const previousTarget = this.renderer.getRenderTarget();
    const previousAutoClear = this.renderer.autoClear;
    try {
      this.copyMaterial.uniforms.sourceMap.value = source.texture;
      this.bakeMaterial.uniforms.targetMap.value = source.texture;
      this.bakeMaterial.uniforms.channelMode.value = CHANNEL_MODE[source.channel];
      this.renderer.setRenderTarget(target);
      this.renderer.autoClear = true;
      this.renderer.clear(true, true, true);
      this.renderer.render(this.fullscreenScene, this.fullscreenCamera);
      this.renderer.autoClear = false;
      this.renderer.render(this.bakeScene, this.fullscreenCamera);
      return this.readTarget(target, source.channel);
    } finally {
      this.renderer.autoClear = previousAutoClear;
      this.renderer.setRenderTarget(previousTarget);
      target.dispose();
    }
  }

  private createDecalUniforms(): DecalUniforms {
    return {
      baseColorMap: { value: null },
      roughnessMap: { value: null },
      metallicMap: { value: null },
      normalMap: { value: null },
      maskMap: { value: null },
      depthMap: { value: null },
      baseColorEnabled: { value: 1 },
      roughnessEnabled: { value: 1 },
      metallicEnabled: { value: 1 },
      normalEnabled: { value: 1 },
      useMask: { value: 1 },
      projectorInverse: { value: new THREE.Matrix4() },
      projectorNormal: { value: new THREE.Vector3(0, 0, 1) },
      projectorXAxis: { value: new THREE.Vector3(1, 0, 0) },
      projectorYAxis: { value: new THREE.Vector3(0, 1, 0) },
      projectorWidth: { value: 1 },
      projectorHeight: { value: 1 },
      projectorNear: { value: 0.01 },
      projectorFar: { value: 1 },
      depthBias: { value: 0.001 },
      previewOpacity: { value: 1 },
    };
  }

  private updateUniforms(
    uniforms: DecalUniforms,
    actor: DecalActor,
    depthTexture: THREE.Texture,
    respectTargetAvailability: boolean,
  ): void {
    uniforms.baseColorMap.value = actor.getChannelTexture("baseColor");
    uniforms.roughnessMap.value = actor.getChannelTexture("roughness");
    uniforms.metallicMap.value = actor.getChannelTexture("metallic");
    uniforms.normalMap.value = actor.getChannelTexture("normal");
    uniforms.maskMap.value = actor.getMaskTexture();
    uniforms.depthMap.value = depthTexture;
    const material = this.previewMaterial;
    uniforms.baseColorEnabled.value = actor.isChannelEnabled("baseColor")
      && (!respectTargetAvailability || Boolean(material?.map)) ? 1 : 0;
    uniforms.roughnessEnabled.value = actor.isChannelEnabled("roughness")
      && (!respectTargetAvailability || Boolean(material?.roughnessMap)) ? 1 : 0;
    uniforms.metallicEnabled.value = actor.isChannelEnabled("metallic")
      && (!respectTargetAvailability || Boolean(material?.metalnessMap)) ? 1 : 0;
    uniforms.normalEnabled.value = actor.isChannelEnabled("normal")
      && (!respectTargetAvailability || Boolean(material?.normalMap)) ? 1 : 0;
    uniforms.useMask.value = actor.getUseCaptureMask() ? 1 : 0;
    uniforms.projectorInverse.value.copy(actor.root.matrixWorld).invert();
    uniforms.projectorNormal.value.set(0, 0, 1).transformDirection(actor.root.matrixWorld);
    uniforms.projectorXAxis.value.set(1, 0, 0).transformDirection(actor.root.matrixWorld);
    uniforms.projectorYAxis.value.set(0, 1, 0).transformDirection(actor.root.matrixWorld);
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

  /** Injects all Decal channels before the standard PBR lighting evaluation. */
  private attachPreviewMaterial(material: THREE.MeshStandardMaterial): void {
    this.detachPreviewMaterial();
    this.previewMaterial = material;
    this.originalOnBeforeCompile = material.onBeforeCompile;
    this.originalCacheKey = material.customProgramCacheKey;
    const previousCompile = this.originalOnBeforeCompile;
    const previousCacheKey = this.originalCacheKey;
    const uniforms = this.previewUniforms;

    material.customProgramCacheKey = () => `${previousCacheKey.call(material)}|stk-decal-preview-v2`;
    material.onBeforeCompile = (shader, renderer) => {
      previousCompile.call(material, shader, renderer);
      Object.assign(shader.uniforms, {
        uStkBaseColorMap: uniforms.baseColorMap,
        uStkRoughnessMap: uniforms.roughnessMap,
        uStkMetallicMap: uniforms.metallicMap,
        uStkNormalMap: uniforms.normalMap,
        uStkMaskMap: uniforms.maskMap,
        uStkDepthMap: uniforms.depthMap,
        uStkBaseColorEnabled: uniforms.baseColorEnabled,
        uStkRoughnessEnabled: uniforms.roughnessEnabled,
        uStkMetallicEnabled: uniforms.metallicEnabled,
        uStkNormalEnabled: uniforms.normalEnabled,
        uStkUseMask: uniforms.useMask,
        uStkProjectorInverse: uniforms.projectorInverse,
        uStkProjectorNormal: uniforms.projectorNormal,
        uStkProjectorXAxis: uniforms.projectorXAxis,
        uStkProjectorYAxis: uniforms.projectorYAxis,
        uStkWidth: uniforms.projectorWidth,
        uStkHeight: uniforms.projectorHeight,
        uStkNear: uniforms.projectorNear,
        uStkFar: uniforms.projectorFar,
        uStkDepthBias: uniforms.depthBias,
        uStkPreviewOpacity: uniforms.previewOpacity,
      });

      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          `#include <common>
varying vec3 vStkDecalWorldPosition;
varying vec3 vStkDecalWorldNormal;
varying vec2 vStkDecalTargetUv;`,
        )
        .replace(
          "#include <beginnormal_vertex>",
          `#include <beginnormal_vertex>
vStkDecalWorldNormal = normalize( mat3( modelMatrix ) * objectNormal );`,
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
vStkDecalWorldPosition = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
vStkDecalTargetUv = uv;`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
uniform sampler2D uStkBaseColorMap;
uniform sampler2D uStkRoughnessMap;
uniform sampler2D uStkMetallicMap;
uniform sampler2D uStkNormalMap;
uniform sampler2D uStkMaskMap;
uniform sampler2D uStkDepthMap;
uniform float uStkBaseColorEnabled;
uniform float uStkRoughnessEnabled;
uniform float uStkMetallicEnabled;
uniform float uStkNormalEnabled;
uniform float uStkUseMask;
uniform mat4 uStkProjectorInverse;
uniform vec3 uStkProjectorNormal;
uniform vec3 uStkProjectorXAxis;
uniform vec3 uStkProjectorYAxis;
uniform float uStkWidth;
uniform float uStkHeight;
uniform float uStkNear;
uniform float uStkFar;
uniform float uStkDepthBias;
uniform float uStkPreviewOpacity;
varying vec3 vStkDecalWorldPosition;
varying vec3 vStkDecalWorldNormal;
varying vec2 vStkDecalTargetUv;
${DECAL_GLSL_HELPERS}`,
        )
        .replace(
          "#include <map_fragment>",
          `#include <map_fragment>
vec4 stkBaseColorSample = vec4( 1.0 );
vec4 stkRoughnessSample = vec4( 1.0 );
vec4 stkMetallicSample = vec4( 1.0 );
vec4 stkNormalSample = vec4( 0.5, 0.5, 1.0, 1.0 );
float stkCoverage = 0.0;
vec3 stkLocal = ( uStkProjectorInverse * vec4( vStkDecalWorldPosition, 1.0 ) ).xyz;
float stkViewDepth = -stkLocal.z;
bool stkInside = abs( stkLocal.x ) <= uStkWidth * 0.5
  && abs( stkLocal.y ) <= uStkHeight * 0.5
  && stkViewDepth >= uStkNear
  && stkViewDepth <= uStkFar;
if ( stkInside && uStkPreviewOpacity > 0.0 ) {
  float stkFacing = dot( normalize( vStkDecalWorldNormal ), normalize( uStkProjectorNormal ) );
  float stkAngleFade = smoothstep( 0.258819, 0.5, stkFacing );
  vec2 stkUv = vec2( stkLocal.x / uStkWidth + 0.5, stkLocal.y / uStkHeight + 0.5 );
  float stkSceneDepth = texture2D( uStkDepthMap, stkUv ).r;
  float stkSurfaceDepth = ( stkViewDepth - uStkNear ) / ( uStkFar - uStkNear );
  if ( stkSurfaceDepth <= stkSceneDepth + uStkDepthBias ) {
    stkBaseColorSample = texture2D( uStkBaseColorMap, stkUv );
    stkRoughnessSample = texture2D( uStkRoughnessMap, stkUv );
    stkMetallicSample = texture2D( uStkMetallicMap, stkUv );
    stkNormalSample = texture2D( uStkNormalMap, stkUv );
    float stkMask = uStkUseMask > 0.5 ? texture2D( uStkMaskMap, stkUv ).r : 1.0;
    stkCoverage = stkBaseColorSample.a * stkMask * stkAngleFade * uStkPreviewOpacity;
  }
}
float stkBaseColorAlpha = stkCoverage * uStkBaseColorEnabled;
float stkRoughnessAlpha = stkCoverage * stkRoughnessSample.a * uStkRoughnessEnabled;
float stkMetallicAlpha = stkCoverage * stkMetallicSample.a * uStkMetallicEnabled;
float stkNormalAlpha = stkCoverage * stkNormalSample.a * uStkNormalEnabled;
diffuseColor.rgb = mix( diffuseColor.rgb, stkBaseColorSample.rgb * diffuse, stkBaseColorAlpha );`,
        )
        .replace(
          "#include <roughnessmap_fragment>",
          `#include <roughnessmap_fragment>
roughnessFactor = mix( roughnessFactor, roughness * stkRoughnessSample.g, stkRoughnessAlpha );`,
        )
        .replace(
          "#include <metalnessmap_fragment>",
          `#include <metalnessmap_fragment>
metalnessFactor = mix( metalnessFactor, metalness * stkMetallicSample.b, stkMetallicAlpha );`,
        )
        .replace(
          "#include <normal_fragment_maps>",
          `#if defined( USE_NORMALMAP_TANGENTSPACE )
vec3 stkBaseNormal = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
#if defined( USE_PACKED_NORMALMAP )
stkBaseNormal = vec3(
  stkBaseNormal.xy,
  sqrt( saturate( 1.0 - dot( stkBaseNormal.xy, stkBaseNormal.xy ) ) )
);
#endif
vec3 stkMapNormal = stkBaseNormal;
if ( stkNormalAlpha > 0.001 ) {
  vec3 stkDetailNormal = stkProjectorNormalToTarget(
    stkNormalSample.rgb,
    vStkDecalWorldPosition,
    vStkDecalWorldNormal,
    vStkDecalTargetUv,
    uStkProjectorXAxis,
    uStkProjectorYAxis
  );
  vec3 stkCombinedNormal = stkBlendRnm( normalize( stkBaseNormal ), stkDetailNormal );
  stkMapNormal = normalize( mix( normalize( stkBaseNormal ), stkCombinedNormal, stkNormalAlpha ) );
}
stkMapNormal.xy *= normalScale;
normal = normalize( tbn * stkMapNormal );
#else
#include <normal_fragment_maps>
#endif`,
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

  private readTarget(
    target: THREE.WebGLRenderTarget,
    channel: MaterialChannel,
  ): HTMLCanvasElement {
    const pixels = new Uint8Array(target.width * target.height * 4);
    this.renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, pixels);
    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error(`2D Canvas is unavailable for the ${channel} bake`);
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
