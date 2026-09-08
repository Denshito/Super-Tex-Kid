# Super Tex Kid architecture

## Source directories

```text
src/
├─ components/              Shared editor UI components
├─ features/
│  ├─ mask/                 Full-resolution mask and preview texture storage
│  ├─ ai/                   OpenRouter command bridge and session edit UI
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
- `TextureSetRuntime` preserves immutable source maps and owns independent resettable Working Textures and exports for all four PBR channels.
- `ProjectionCaptureRenderer` emits unlit material passes plus ViewNormal and linear depth.
- `DecalActor` owns one transformable projector and four provider-neutral, independently enabled channel sources.
- `DecalRenderer` shares projection, material isolation, depth rejection, angle fading, scalar-channel blending, and projector-aware RNM between live preview and UV bake.
- Tauri/Rust owns the session-only OpenRouter key, request validation and image-generation HTTP boundary; it will also own future trusted filesystem and project services.
- ComfyUI will remain an external provider accessed through a queued job service.

## Current milestone

The deterministic path extends from a painted material selection through orthographic capture, transformable four-channel Decal projection, and transactional Base Color/Roughness/Metallic/Normal UV bake. Imported channel maps remain immutable; each enabled channel receives a disposable Working Texture at its own source resolution and exports through the browser download path.

The first remote AI slice sits before that unchanged projection/bake path. `OpenRouterAiPanel` assembles the current BaseColor, Capture Mask, optional material reference, and optional geometry guides. The Tauri command validates and sends them to OpenRouter GPT Image 2, then the returned Blob re-enters the same `setDecalImage()` interface used by local files. Only the BaseColor Decal source changes; Preview is enabled and the artist must still choose when to Bake. Credentials and edit history are process/session data and are not serialized.

PNG export keeps the browser download path and reports that the file goes to the browser's default Downloads folder. PBR inspection combines a generated neutral Studio IBL, hemispherical fill, and an adjustable directional key light; custom HDRI import is reserved for a later milestone.

## Known extension boundaries

The DeepSeek assistant is a separate Rust service with its own session key. It validates the account through the balance endpoint and uses Chat Completions with the experimental vision model, non-streaming JSON output and no thinking. A compiled-in Skill defines `reply` and optional `imagePrompt`; Rust validates the result before React accepts it. Chat inputs are separate 1024px copies. Session and context versions prevent delayed responses from crossing Decal sessions. The UI retains discussion while switching AI pages; applying a prompt only updates the image editor draft. No chat operation modifies a texture or starts a bake.

- UV transforms, alternate UV sets, UDIM and compressed source textures still require dedicated import mapping.
- CPU ray sampling is BVH-accelerated and remains isolated behind the viewport brush path so a GPU UV buffer can replace it later.
- Selection edge bands are previewed non-destructively; production-quality morphology/SDF generation belongs to the image-processing stage.
- Local Canvas processing is the deterministic baseline; a future GPU effect stack and AI jobs should implement the same source/mask/working-output contract.
- The bake path deliberately supports one static-mesh PBR Decal. Multiple Decal layers, deforming geometry, automatic missing-map creation, and UV-loss diagnostics remain later boundaries.
