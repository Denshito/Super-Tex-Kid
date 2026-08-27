# Super Tex Kid

An AI-assisted 3D texture editing desktop client for technical-art workflows.

Super Tex Kid is being developed as a portfolio project that explores model-aware texture editing: selecting pixels by painting directly on a 3D surface, isolating material texture sets, previewing PBR channels in real time, and eventually applying local or AI-assisted edits non-destructively.

> Current status: functional prototype. The 3D viewport, material-aware surface brush, selection-mask preview, BVH raycast acceleration, PBR texture import, and lighting controls are working. Texture processing, project persistence, undo/redo, and AI execution are planned but not implemented yet.

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
- Resizable Three.js viewport and scrollable inspector UI.
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

## Development strategy

The project is built in vertical slices. Each milestone must produce a usable artist-facing interaction before more complex AI or image-processing systems are added.

The current architecture separates responsibilities as follows:

- **React** owns editor layout, controls, file requests, and lifecycle.
- **Zustand** stores serializable cross-panel editor state.
- **Three.js** owns rendering, PBR materials, model loading, UV picking, and viewport interaction.
- **SelectionMask** stores an authoritative texture-resolution mask plus a smaller real-time preview.
- **SelectionOverlay** injects selection visualization into the standard PBR shader without modifying source textures.
- **Tauri/Rust** provides the desktop runtime and is reserved for project I/O, native integration, and future processing/job orchestration.

This division keeps the current prototype simple while leaving clear replacement points for GPU mask projection, render-target image processing, persistent projects, and AI backends.

See [docs/architecture.md](docs/architecture.md) for the current directory and runtime structure.

## Roadmap

### Next milestone: non-destructive texture editing

- Introduce explicit Project, Texture Set, Channel Asset, and Effect Stack data models.
- Preserve original textures separately from working textures.
- Add a 2D texture/UV inspection view.
- Apply Base Color hue, saturation, brightness, and contrast adjustments through the selection mask.
- Add feathered mask blending, before/after comparison, reset, and PNG export.
- Add undo/redo for strokes and effect parameters.

### Later milestones

- GPU UV-space brush projection and render-target image processing.
- HDRI/image-based lighting for more representative metallic reflections.
- Project save/load and portable asset references.
- OBJ and FBX import with explicit material/texture dependency handling.
- AI job abstraction for inpainting, cleanup, variation, and channel-aware texture generation.
- Patch compositing that reuses the same selection-mask and effect-stack pipeline.
- Background processing, progress reporting, cancellation, and reproducible job metadata.

## Current limitations

- Only self-contained `.glb` model import is supported.
- Imported texture maps live in memory and are not saved as a project yet.
- Normal maps currently expect the OpenGL `+Y` convention.
- The environment control is hemispherical fill lighting, not HDRI/IBL.
- Existing masks are not automatically resampled when a different-resolution texture is imported after painting.
- High-resolution source masks are committed at stroke end; exceptionally long strokes may still cause a short pointer-up pause.
- The AI processing layer is not connected yet.

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
