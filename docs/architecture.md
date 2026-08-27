# Super Tex Kid architecture

## Source directories

```text
src/
├─ components/              Shared editor UI components
├─ features/
│  ├─ mask/                 Full-resolution mask and preview texture storage
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
- Tauri/Rust will own trusted filesystem access, project manifests, secrets and process lifecycle.
- ComfyUI will remain an external provider accessed through a queued job service.

## Current milestone

Screen-space pointer strokes are projected through independent raycasts into a material-locked UV mask. Each material/texture set owns its mask, and a stroke never crosses into a different material.

## Known extension boundaries

- UV transforms, alternate UV sets, UDIM and compressed source textures still require dedicated import mapping.
- CPU ray sampling is intentionally isolated behind the viewport brush path so a GPU UV buffer or BVH acceleration can replace it later.
- Selection edge bands are previewed non-destructively; production-quality morphology/SDF generation belongs to the image-processing stage.
