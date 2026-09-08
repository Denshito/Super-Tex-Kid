# Super Tex Kid

An AI-assisted 3D texture editing desktop client for technical-art workflows.

Super Tex Kid is being developed as a portfolio project that explores model-aware texture editing: selecting pixels by painting directly on a 3D surface, isolating material texture sets, previewing PBR channels in real time, and eventually applying local or AI-assisted edits non-destructively.

> Current status: functional prototype. The viewport, material-aware brush, BVH picking, PBR import, multi-pass projection capture, transformable four-channel PBR Decal preview, and non-destructive Base Color/Roughness/Metallic/Normal bake are implemented. OpenRouter-powered GPT Image 2 BaseColor editing is now available as a session-only first integration. Project persistence, undo/redo, multi-Decal layers, and AI editing of non-color channels are not connected yet.

## Target experience

The intended workflow is close to a lightweight Substance 3D Painter companion:

1. Import a textured 3D model.
2. Select a material/texture set from the model surface.
3. Paint a screen-space selection directly on visible geometry.
4. Reuse that selection across Base Color, Roughness, Normal, and Metallic channels.
5. Apply deterministic or AI-assisted edits through a non-destructive effect stack.
6. Inspect the result under adjustable PBR lighting.
7. Export modified texture maps at their original resolution.

The long-term goal is not to replace a full material-authoring suite. It is to provide a focused, artist-friendly client for localized texture correction, variation generation, cleanup, and AI-assisted iteration while preserving material and UV context.

## Implemented progress

### Desktop application and editor shell

- Tauri 2 desktop application with a React and TypeScript frontend.
- Resizable Three.js viewport and a mode-driven contextual workbench with dedicated AI editing space.
- Compact English DCC-style interface with a charcoal palette and restrained dark-blue accents.
- Drag-and-drop and file-picker import for standalone `.glb` files.
- Zustand-based editor state shared between the viewport and property panels.

### 3D viewport and material picking

- Orbit, pan, zoom, PBR lighting, grid, and automatic camera framing.
- UV-aware raycasting against imported geometry.
- Mesh, material slot, material UUID, texture-set ID, and UV readout.
- Multiple materials remain isolated: a brush stroke locks to the material selected on pointer-down.
- `three-mesh-bvh` acceleration for static geometry, with a safe Three.js fallback for skinned or position-morphed meshes.

### Screen-space surface brush

- Substance Painter-style circular brush measured in viewport pixels.
- Continuous stroke interpolation across the visible model surface.
- UV samples are written into a per-material selection mask.
- Adjustable radius, hardness, and inner/outer reference distances.
- Non-destructive red selection overlay and gray outer-reference overlay.
- Frame-batched pointer processing, cached raycast targets, reusable intersection buffers, and deferred full-resolution mask commits.

### PBR material preview

- Three.js `MeshStandardMaterial` metallic/roughness workflow.
- Per-material import for Base Color, Roughness, Normal, and Metallic maps.
- sRGB Base Color handling and linear data-map handling.
- Base Color tint, roughness, metallic, and normal-strength controls.
- Adjustable hemispherical fill light and directional light, including color, intensity, azimuth, and elevation.

### Local non-destructive Base Color editing

- Per-material Texture Set runtime with Base Color, Roughness, Normal, and Metallic channel metadata.
- Immutable Base Color source texture plus a separate working preview texture.
- Selection-masked hue, saturation, brightness, contrast, and effect-strength controls.
- Frame-coalesced preview rendering capped at 1024 pixels on the longest edge.
- Reset to the exact source map and full-source-resolution PNG export.
- Deterministic CPU/Canvas processing with no ComfyUI dependency.

### Projection capture and Decal bake

- Orthographic Capture Actor seeded from the painted selection bounds and average surface normal.
- Separate unlit Base Color, Roughness, material Normal, Metallic, selection-mask, view-space geometry Normal, and linear-depth previews.
- One transformable Decal Actor initialized from all four Capture channels, with independent file replacement, enable state, preview, reset, and export per channel.
- Maya-style `W`, `E`, and `R` shortcuts for Actor translation, rotation, and scale, plus independent Capture Actor, Decal Actor, and Decal Preview visibility.
- Projective Base Color, Roughness, Metallic, and projector-aware RNM Normal preview injected into the target `MeshStandardMaterial`, preserving its PBR lighting, IBL, and tone mapping.
- Preview and bake remain isolated to the captured material slot, with depth occlusion and a fixed grazing-angle fade.
- Transactional GPU UV-space PBR bake at each imported channel's source resolution, followed by one readback and one resettable Working Texture per enabled channel.
- Roughness writes G, Metallic writes B, and Normal uses the same projector-to-tangent RNM composition in preview and bake.
- Provider-neutral, channel-addressed Blob input shared by local files and generated-image results.

### OpenRouter AI BaseColor editing

The AI Edit workbench now includes **Assistant** and **Image Edit** pages. In AI Settings, connect a separate DeepSeek official key under **Prompt Assistant**. Discuss the current BaseColor and Mask (plus optional reference/geometry guides), review the editable English prompt, and choose **Apply to Image Edit**. Only **Generate** sends a paid image-generation request to OpenRouter; Bake remains manual. DeepSeek chat itself is billed by its provider.

The assistant uses `deepseek-v4-flash-vision-exp` with the bundled `skills/stk-decal-prompt/SKILL.md`. Keys and transcripts are session-only. It retains 20 successful chat rounds and sends the latest 10 plus current images, resized to at most 1024px for chat only. Stale replies are labeled and do not auto-apply to a changed Decal. The connection check validates the account, not vision model availability; first chat verifies vision access. No live API validation is bundled with the automated test suite.

- Session-only OpenRouter key validation and storage in Rust process memory; keys are never persisted by STK.
- GPT Image 2 receives the current BaseColor and Capture Mask, plus one optional material reference and optional ViewNormal/Depth guides.
- English engineering constraints request flat albedo without lighting, reflections, highlights, shadows, or guide colors.
- Up to eight generated revisions plus the original Capture remain selectable during the active Decal session.
- A successful result automatically replaces only the live BaseColor Decal source and reopens Preview; Bake remains an explicit artist action.
- Input format, size, prompt length, timeout, response size, and common OpenRouter billing/rate/server errors are validated in the Rust boundary.

## Development strategy

The project is built in vertical slices. Each milestone must produce a usable artist-facing interaction before more complex AI or image-processing systems are added.

The current architecture separates responsibilities as follows:

- **React** owns editor layout, controls, file requests, and lifecycle.
- **Zustand** stores serializable cross-panel editor state.
- **Three.js** owns rendering, PBR materials, model loading, UV picking, and viewport interaction.
- **SelectionMask** stores an authoritative texture-resolution mask plus a smaller real-time preview.
- **SelectionOverlay** injects selection visualization into the standard PBR shader without modifying source textures.
- **Tauri/Rust** provides the desktop runtime and owns the session-only OpenRouter credential and trusted image request boundary.

This division keeps the current prototype simple while leaving clear replacement points for GPU mask projection, render-target image processing, persistent projects, and AI backends.

See [docs/architecture.md](docs/architecture.md) for the current directory and runtime structure.

## Roadmap

### Next milestone: AI Decal validation and editing workflow

- Validate projection orientation, depth occlusion, multi-material isolation, and UV-island bake behavior on representative GLB assets.
- Add bake-loss diagnostics for grazing angles, overlapping UVs, and insufficient texel density.
- Promote the runtime Texture Set into serializable Project, Channel Asset, and Effect Stack models.
- Add a 2D texture/UV inspection view.
- Add explicit feather controls and before/after comparison.
- Add undo/redo for strokes and effect parameters.
- Save and reload project manifests with portable asset references.
- Validate Prompt behavior and cost/latency with representative material references before adding provider abstraction.

### Later milestones

- GPU UV-space brush projection and multi-Decal layer compositing.
- User-imported HDRI lighting and environment rotation controls.
- Project save/load and portable asset references.
- OBJ and FBX import with explicit material/texture dependency handling.
- AI job abstraction for inpainting, cleanup, variation, and channel-aware texture generation.
- Patch compositing that reuses the same selection-mask and effect-stack pipeline.
- Background processing, progress reporting, cancellation, and reproducible job metadata.

## Current limitations

- Only self-contained `.glb` model import is supported.
- Imported texture maps and local effect settings live in memory and are not saved as a project yet.
- Normal maps currently expect the OpenGL `+Y` convention.
- Studio IBL is built in; importing or rotating a custom HDRI is not supported yet.
- Existing masks are not automatically resampled when a different-resolution texture is imported after painting.
- High-resolution source masks are committed at stroke end; exceptionally long strokes may still cause a short pointer-up pause.
- AI editing currently affects BaseColor only, requires an online OpenRouter account, and keeps no history after the process closes.
- Decal bake supports one active static-mesh Decal with UV0; every enabled channel requires an existing target map with a known resolution.
- Skinned meshes, position morphs, UDIMs, overlapping-UV diagnostics, DirectX normal conversion, and multi-Decal layering are outside the current bake path.

## Technology stack

- Tauri 2 and Rust
- React 19
- TypeScript
- Three.js
- three-mesh-bvh
- Zustand
- Vite

## Requirements

The current development target is Windows. Install:

- Node.js
- Rust through Rustup
- Microsoft Visual C++ Build Tools
- Microsoft Edge WebView2 Runtime

## Development

Install the locked JavaScript dependencies:

```powershell
npm ci
```

Run the desktop development build:

```powershell
npm run tauri dev
```

Run frontend and Rust checks:

```powershell
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

## Repository policy

Generated dependencies and build output are intentionally excluded from Git:

- `node_modules/`
- `dist/`
- `src-tauri/target/`
- generated Tauri schema files

Clone the repository and regenerate them with `npm ci`, Cargo, and the Tauri development command.

## License

No open-source license has been selected yet. All rights are reserved until a license file is added.
