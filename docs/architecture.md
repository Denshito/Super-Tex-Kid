# Super Tex Kid architecture

## Source directories

```text
src/
├─ components/              Shared editor UI components
├─ features/
│  ├─ mask/                 Full-resolution mask and preview texture storage
│  ├─ texture/              Texture-set assets and local non-destructive effects
│  └─ viewport/             Renderer, brush projection and selection overlay
├─ state/                   Global editor state
├─ types/                   Shared TypeScript domain types
├─ App.tsx                  Desktop editor shell
└─ main.tsx                 React entry point
src-tauri/
├─ capabilities/            Tauri permission boundaries
└─ src/                     Rust commands and desktop services
skills/                     Versioned AI skill manifests
workflows/                  Versioned ComfyUI API workflows
docs/                       Architecture and development notes
```

## Runtime boundary

- React owns panels, commands and editor state.
- `ThreeViewport` owns WebGL resources, camera controls, model loading, material-aware picking and screen-space brush projection.
- `SelectionMask` keeps a full-resolution texture-space mask plus a smaller GPU preview.
- `SelectionOverlay` injects red core and gray context visualization without modifying material textures.
- `TextureSetRuntime` preserves source channel maps, renders a capped working preview, and produces full-resolution local exports.
- `ProjectionCaptureRenderer` emits unlit material passes plus ViewNormal and linear depth.
- `DecalActor` owns one transformable projector and provider-neutral image source.
- `DecalRenderer` shares projection, material isolation, depth rejection, and angle fading between live preview and UV bake.
- Tauri/Rust will own trusted filesystem access, project manifests, secrets and process lifecycle.
- ComfyUI will remain an external provider accessed through a queued job service.

## Current milestone

The deterministic path now extends from a painted material selection through orthographic capture, transformable Decal projection, and a full-resolution Base Color bake. The imported Base Color remains immutable; baked pixels live in a disposable Working Texture and export through the browser download path. No ComfyUI or remote image API participates in this stage.

PNG export keeps the browser download path and reports that the file goes to the browser's default Downloads folder. PBR inspection combines a generated neutral Studio IBL, hemispherical fill, and an adjustable directional key light; custom HDRI import is reserved for a later milestone.

## Known extension boundaries

- UV transforms, alternate UV sets, UDIM and compressed source textures still require dedicated import mapping.
- CPU ray sampling is BVH-accelerated and remains isolated behind the viewport brush path so a GPU UV buffer can replace it later.
- Selection edge bands are previewed non-destructively; production-quality morphology/SDF generation belongs to the image-processing stage.
- Local Canvas processing is the deterministic baseline; a future GPU effect stack and AI jobs should implement the same source/mask/working-output contract.
- The first bake path deliberately supports one static-mesh Base Color Decal. Normal/Roughness/Metallic blending, multiple Decal layers, deforming geometry, and UV-loss diagnostics remain later boundaries.
