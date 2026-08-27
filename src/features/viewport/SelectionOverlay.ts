import * as THREE from "three";
import type { BrushSettings } from "../../types/editor";

interface OverlayUniforms {
  selectionMap: THREE.IUniform<THREE.Texture>;
  innerOffset: THREE.IUniform<THREE.Vector2>;
  outerOffset: THREE.IUniform<THREE.Vector2>;
}

/**
 * Injects a non-destructive red/gray selection visualization into a standard
 * PBR material. The underlying BaseColor/Normal/Roughness textures are never
 * changed by this preview.
 */
export class SelectionOverlay {
  private readonly originalOnBeforeCompile: THREE.Material["onBeforeCompile"];
  private readonly originalCacheKey: THREE.Material["customProgramCacheKey"];
  private readonly originalDefines: Record<string, unknown> | undefined;
  private shaderUniforms: OverlayUniforms | null = null;
  private settings: BrushSettings;

  constructor(
    private readonly material: THREE.MeshStandardMaterial,
    private readonly selectionMap: THREE.Texture,
    private readonly previewWidth: number,
    private readonly previewHeight: number,
    settings: BrushSettings,
  ) {
    this.settings = settings;
    this.originalOnBeforeCompile = material.onBeforeCompile;
    this.originalCacheKey = material.customProgramCacheKey;
    this.originalDefines = material.defines ? { ...material.defines } : undefined;

    // USE_UV guarantees that the standard material exposes vUv even when it has
    // no BaseColor map. The overlay is only attached to meshes with UV data.
    material.defines = { ...material.defines, USE_UV: "" };
    material.customProgramCacheKey = () => `${this.originalCacheKey.call(material)}|stk-selection-v1`;
    material.onBeforeCompile = (shader, renderer) => {
      this.originalOnBeforeCompile.call(material, shader, renderer);

      const uniforms: OverlayUniforms = {
        selectionMap: { value: this.selectionMap },
        innerOffset: { value: this.offsetFor(this.settings.innerReferencePx) },
        outerOffset: { value: this.offsetFor(this.settings.outerReferencePx) },
      };
      this.shaderUniforms = uniforms;
      shader.uniforms.uStkSelectionMap = uniforms.selectionMap;
      shader.uniforms.uStkInnerOffset = uniforms.innerOffset;
      shader.uniforms.uStkOuterOffset = uniforms.outerOffset;

      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <uv_pars_fragment>",
        `#include <uv_pars_fragment>
uniform sampler2D uStkSelectionMap;
uniform vec2 uStkInnerOffset;
uniform vec2 uStkOuterOffset;`,
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <opaque_fragment>",
        `float stkCenter = texture2D( uStkSelectionMap, vUv ).r;

float stkInner = stkCenter;
stkInner = min( stkInner, texture2D( uStkSelectionMap, vUv + vec2( uStkInnerOffset.x, 0.0 ) ).r );
stkInner = min( stkInner, texture2D( uStkSelectionMap, vUv - vec2( uStkInnerOffset.x, 0.0 ) ).r );
stkInner = min( stkInner, texture2D( uStkSelectionMap, vUv + vec2( 0.0, uStkInnerOffset.y ) ).r );
stkInner = min( stkInner, texture2D( uStkSelectionMap, vUv - vec2( 0.0, uStkInnerOffset.y ) ).r );

float stkOuter = stkCenter;
stkOuter = max( stkOuter, texture2D( uStkSelectionMap, vUv + vec2( uStkOuterOffset.x, 0.0 ) ).r );
stkOuter = max( stkOuter, texture2D( uStkSelectionMap, vUv - vec2( uStkOuterOffset.x, 0.0 ) ).r );
stkOuter = max( stkOuter, texture2D( uStkSelectionMap, vUv + vec2( 0.0, uStkOuterOffset.y ) ).r );
stkOuter = max( stkOuter, texture2D( uStkSelectionMap, vUv - vec2( 0.0, uStkOuterOffset.y ) ).r );

float stkSelectionEdge = clamp( stkCenter - stkInner, 0.0, 1.0 );
float stkOuterRing = clamp( stkOuter - stkCenter, 0.0, 1.0 );
vec3 stkRedMultiply = outgoingLight * vec3( 1.0, 0.18, 0.18 );
vec3 stkRedVisible = mix( stkRedMultiply, vec3( 0.62, 0.035, 0.03 ), 0.22 );
vec3 stkGrayMultiply = outgoingLight * vec3( 0.38 );

outgoingLight = mix( outgoingLight, stkRedVisible, stkCenter * 0.72 );
outgoingLight = mix( outgoingLight, stkRedMultiply, stkSelectionEdge * 0.38 );
outgoingLight = mix( outgoingLight, stkGrayMultiply, stkOuterRing * 0.7 );

#include <opaque_fragment>`,
      );
    };
    material.needsUpdate = true;
  }

  updateSettings(settings: BrushSettings): void {
    this.settings = settings;
    if (!this.shaderUniforms) return;
    this.shaderUniforms.innerOffset.value.copy(this.offsetFor(settings.innerReferencePx));
    this.shaderUniforms.outerOffset.value.copy(this.offsetFor(settings.outerReferencePx));
  }

  dispose(): void {
    this.material.onBeforeCompile = this.originalOnBeforeCompile;
    this.material.customProgramCacheKey = this.originalCacheKey;
    this.material.defines = this.originalDefines;
    this.material.needsUpdate = true;
  }

  private offsetFor(pixels: number): THREE.Vector2 {
    return new THREE.Vector2(
      Math.max(pixels, 0) / this.previewWidth,
      Math.max(pixels, 0) / this.previewHeight,
    );
  }
}
