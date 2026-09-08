# Super Tex Kid Engineering Code Walkthrough

> 基于当前 `main` 分支的 `daeeff8` 版本整理。本文用于理解工程架构、算法选型，以及准备作品集展示和技术面试问答。

## 1. 项目定位

Super Tex Kid 是一个基于 Tauri、React 和 Three.js 的桌面纹理编辑原型。它允许用户在 3D 模型表面用屏幕空间笔刷建立材质隔离的选区，将该区域采集成无光照纹理与几何辅助通道，再通过可变换的投影 Actor 将 Decal 实时预览并烘焙回模型原始 UV 空间的 BaseColor。

当前工程覆盖的主要技术方向包括：

- DCC 风格工具交互；
- Three.js 场景、PBR 材质与 Shader 扩展；
- 屏幕空间表面拾取与 BVH 加速；
- UV、多材质槽与 Texture Set 隔离；
- GPU RenderTarget、多通道 Capture 与 UV-space Bake；
- 非破坏式纹理预览、烘焙、重置和导出；
- Tauri WebView 与 Rust 桌面宿主架构。

面试中的一句话介绍可以是：

> Super Tex Kid is a Tauri and Three.js desktop texture-editing prototype. It converts screen-space surface selections into material-isolated capture data, projects editable Decals back onto the model with depth and angle rejection, and bakes the result into the original BaseColor UV atlas through GPU UV-space rasterization.

## 2. 总体架构

```text
App.tsx
│
│  UI controls / file import / inspector
▼
Zustand editorStore
│
│  Serializable settings, summaries and command tokens
▼
Viewport3D.tsx
│
│  React <-> Three.js lifecycle bridge
▼
ThreeViewport
├── Model / material / light management
├── BVH surface picking
├── Screen-space brush
├── SelectionMask
├── SelectionOverlay
├── TextureSetRuntime
├── ProjectionCaptureActor
├── ProjectionCaptureRenderer
├── DecalActor
└── DecalRenderer
        │
        ▼
Three.js / WebGL / GPU RenderTargets

Tauri / Rust
└── Desktop window and future native services
```

最重要的架构边界是：

> React 管界面，Zustand 管可序列化编辑状态，ThreeViewport 管实时 3D 对象和 GPU 资源，Tauri/Rust 管桌面宿主和未来的原生服务。

`THREE.Mesh`、`WebGLRenderTarget`、`CanvasTexture` 等可变对象没有放进 React State 或 Zustand。它们不适合序列化，而且具有需要显式释放的 GPU 生命周期。

React 的 Ref 用于保存不参与 UI 渲染的对象，Effect 用于和 Three.js 这样的外部系统同步：

- [React `useRef`](https://react.dev/reference/react/useRef)
- [React `useEffect`](https://react.dev/reference/react/useEffect)

## 3. 工程目录职责

### 3.1 UI、状态与公共类型

| 文件 | 职责 |
|---|---|
| [`src/main.tsx`](../src/main.tsx) | 创建 React 根节点 |
| [`src/App.tsx`](../src/App.tsx) | 主界面、Inspector、文件导入和工作流按钮 |
| [`src/App.css`](../src/App.css) | DCC 风格界面、折叠面板和控件布局 |
| [`src/types/editor.ts`](../src/types/editor.ts) | UI 与 Runtime 之间的公共数据协议 |
| [`src/state/editorStore.ts`](../src/state/editorStore.ts) | Zustand 编辑器状态、设置、Summary 和命令 Token |

### 3.2 3D 视口与选择

| 文件 | 职责 |
|---|---|
| [`src/features/viewport/Viewport3D.tsx`](../src/features/viewport/Viewport3D.tsx) | React 与 Three.js Runtime 的生命周期桥梁 |
| [`src/features/viewport/ThreeViewport.ts`](../src/features/viewport/ThreeViewport.ts) | 场景、输入、拾取、Actor、材质、灯光和渲染总控 |
| [`src/features/viewport/SelectionOverlay.ts`](../src/features/viewport/SelectionOverlay.ts) | 通过 Shader 注入显示红色/灰色选区覆盖层 |
| [`src/features/mask/SelectionMask.ts`](../src/features/mask/SelectionMask.ts) | 完整分辨率 Mask 与低分辨率交互 Preview |

### 3.3 纹理、Capture 与 Decal

| 文件 | 职责 |
|---|---|
| [`src/features/texture/TextureSetRuntime.ts`](../src/features/texture/TextureSetRuntime.ts) | 原始纹理、Working Texture、本地调整、导出与重置 |
| [`src/features/capture/ProjectionCaptureActor.ts`](../src/features/capture/ProjectionCaptureActor.ts) | 正交投影体、相机、Transform 与 Gizmo Box |
| [`src/features/capture/ProjectionCaptureRenderer.ts`](../src/features/capture/ProjectionCaptureRenderer.ts) | 多通道无光照 Capture、View Normal 和 Depth |
| [`src/features/decal/DecalActor.ts`](../src/features/decal/DecalActor.ts) | 可变换的 Decal Projector 和统一图片输入 |
| [`src/features/decal/DecalRenderer.ts`](../src/features/decal/DecalRenderer.ts) | PBR Decal Preview、遮挡判断与 UV-space Bake |

### 3.4 Tauri/Rust

| 文件 | 职责 |
|---|---|
| [`src-tauri/src/main.rs`](../src-tauri/src/main.rs) | 原生程序入口 |
| [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs) | Tauri Builder、插件和 IPC Command 注册 |
| [`src-tauri/tauri.conf.json`](../src-tauri/tauri.conf.json) | 窗口、开发服务器与构建配置 |
| [`src-tauri/Cargo.toml`](../src-tauri/Cargo.toml) | Rust 包和 Tauri 依赖配置 |

## 4. React、Zustand 与 Three.js 的数据流

### 4.1 Store 到 Runtime

`App.tsx` 只表达用户意图，例如修改灯光、创建 Capture 或执行 Bake。`Viewport3D.tsx` 使用 `useEffect` 监听 Zustand 数据，然后调用 `ThreeViewport` 方法：

```text
User changes UI
→ Zustand state changes
→ Viewport3D useEffect runs
→ ThreeViewport method updates runtime
```

### 4.2 Runtime 到 Store

创建 `ThreeViewport` 时，`Viewport3D.tsx` 传入状态回调：

```text
ThreeViewport runtime event
→ callback emits serializable Summary
→ Zustand updates
→ React inspector rerenders
```

Runtime 返回的是材质名称、UV、Actor 设置、Capture Preview URL 等 Summary，而不是完整的 Three.js 对象。

### 4.3 Command Token

一次性命令使用递增数字：

```ts
createCaptureToken
createDecalToken
bakeDecalToken
channelResetRequest / channelExportRequest
```

按钮每点击一次，对应 Token 加一。这样连续两次相同命令仍然会产生不同状态，`Viewport3D.tsx` 可以可靠检测并执行。

如果只使用 `shouldBake: true`，连续点击时状态可能没有变化，也无法明确区分不同请求。

## 5. ThreeViewport 的职责

[`ThreeViewport.ts`](../src/features/viewport/ThreeViewport.ts) 是当前工程的运行时总控，负责：

- `Scene`、`Camera` 和 `WebGLRenderer`；
- `OrbitControls` 与 `TransformControls`；
- 默认球体和 GLB 模型导入；
- PBR 材质、纹理、环境光和方向光；
- Pointer 输入与工具模式；
- Raycaster、BVH 和选区绘制；
- Capture Actor 与 Decal Actor；
- 每帧更新和资源释放。

Renderer 使用 sRGB 输出和 ACES Filmic Tone Mapping。材质使用 Three.js 的 `MeshStandardMaterial`，因此支持 BaseColor、Normal、Roughness、Metalness、IBL 和直接光照：

- [Three.js `MeshStandardMaterial`](https://threejs.org/docs/#api/en/materials/MeshStandardMaterial)
- [Three.js `TransformControls`](https://threejs.org/docs/#examples/en/controls/TransformControls)

## 6. 模型、多材质槽与 Texture Set 隔离

模型载入后，`rebuildPaintableMeshCache()` 扫描所有 Mesh。进入可绘制集合的对象需要：

- 具有 UV0；
- 使用 `MeshStandardMaterial`；
- 几何体能够进行表面射线检测。

一次命中的身份链是：

```text
Mesh
└── Geometry face / materialIndex
    └── Material slot
        └── MeshStandardMaterial.uuid
            └── TextureSetRuntime
```

拾取交点后，通过 `face.materialIndex` 找到材质槽，再使用 Material UUID 作为 Texture Set ID。

一次笔画开始于材质 A 后，后续采样只接受同一 Material UUID。Capture、Decal Preview 和 Bake 也使用同一 UUID 隔离目标材质。

面试时可以表述为：

> I identify the material slot from the intersected face's material index, then use the material UUID as the Texture Set identity. Selection, capture, projection and baking therefore remain isolated to the same material slot.

## 7. 屏幕空间笔刷算法

### 7.1 为什么不能只发一条射线

鼠标中心的一条射线只能得到一个 UV 点，无法表示具有屏幕半径的圆形笔刷。

当前方案在屏幕空间圆内生成采样点，每个点分别发射射线：

```text
Screen-space brush circle
├── sample ray 1 → mesh UV
├── sample ray 2 → mesh UV
├── sample ray 3 → mesh UV
└── ...
```

Three.js `Raycaster` 返回命中对象、面、材质索引、UV、世界位置和法线：

- [Three.js `Raycaster`](https://threejs.org/docs/#api/en/core/Raycaster)

### 7.2 笔画插值

浏览器的 Pointer Event 频率并不固定。快速移动时，相邻输入位置可能距离很远，因此代码在相邻屏幕位置之间插入笔刷中心。

```text
Previous screen position
→ interpolate screen-space centers
→ raycast every interpolated stamp
→ current screen position
```

不会直接插值 UV，因为屏幕上相邻的点可能落在不同 UV 岛。直接连接 UV 会穿过不属于模型表面的纹理区域。

### 7.3 Hardness

圆形 Stamp 根据采样点到中心的距离计算 Alpha：

```text
distance <= hardness radius
→ full alpha

hardness radius < distance < brush radius
→ linear falloff

distance >= brush radius
→ discard
```

### 7.4 每帧只消费最新输入

Pointer Event 只更新 Pending Position，动画帧再处理最新位置：

```text
Many pointer events
→ keep latest pending position
→ process once in requestAnimationFrame
```

这样可以避免输入事件频率高于渲染频率时产生射线任务积压。

## 8. BVH 拾取加速

普通 Raycaster 可能需要检查大量三角形。BVH 将三角形递归分组到层次包围盒：

```text
Root bounding box
├── Left bounding box
│   ├── triangle group
│   └── triangle group
└── Right bounding box
    ├── triangle group
    └── triangle group
```

如果射线没有碰到某个包围盒，该节点下所有三角形都可以跳过。

项目还启用了：

```ts
raycaster.firstHitOnly = true;
```

笔刷只需要离相机最近的表面，因此不必计算后方全部交点。

当前使用 [`three-mesh-bvh`](https://github.com/gkjohnson/three-mesh-bvh) 替换静态 Mesh 的 Raycast 路径。

### 与光线追踪 BVH 的异同

相同点：

- 都使用层次包围盒；
- 都通过排除不相交节点减少三角形测试；
- 都在叶节点测试真实图元。

不同点：

- 本项目使用 BVH 加速 CPU 交互拾取；
- 光线追踪渲染会为大量像素发出主射线、阴影射线和反射射线；
- 本项目最终画面仍由 WebGL Rasterization 渲染；
- 当前 BVH 不负责最终光照。

BVH 的代价是模型载入时需要构建树。静态共享 Geometry 只构建一次；SkinnedMesh 和带 Position Morph 的 Mesh 当前保留普通路径，避免静态 BVH 与变形顶点不一致。

## 9. SelectionMask 的双分辨率设计

[`SelectionMask.ts`](../src/features/mask/SelectionMask.ts) 管理：

- Full-resolution Source Canvas；
- 最大约 1024 的 Preview Canvas；
- Preview `CanvasTexture`。

交互时只更新较小的 Preview：

```text
Pointer move
→ paint low-resolution preview
→ upload smaller CanvasTexture
```

笔画结束时，将累计样本重放到完整分辨率 Source Canvas：

```text
Pointer up
→ replay collected samples once
→ update authoritative full-resolution mask
```

这样兼顾了实时响应和源纹理像素精度。

UV 到 Canvas 像素的基本转换是：

```ts
x = u * width;
y = (1 - v) * height;
```

`1 - v` 用于处理 Canvas 左上角原点与常见 UV 左下角原点之间的方向差异。

## 10. SelectionOverlay

[`SelectionOverlay.ts`](../src/features/viewport/SelectionOverlay.ts) 使用 `MeshStandardMaterial.onBeforeCompile` 注入选区显示 Shader。

它不会直接修改 BaseColor：

```text
Original PBR shading
→ sample selection mask
→ apply red/gray multiply overlay
→ final screen color
```

因此选区可以隐藏、清除，并且 Capture 时可以临时关闭，不会污染原始纹理。

`onBeforeCompile` 是 Three.js 在内置材质编译前提供的 Shader 扩展点：

- [Three.js `Material`](https://threejs.org/docs/#api/en/materials/Material)

工程会保存并恢复原来的 `onBeforeCompile` 和 `customProgramCacheKey`，避免重复创建 Overlay 或 Decal 后不断叠加 Shader 注入。

## 11. TextureSetRuntime 与非破坏编辑

[`TextureSetRuntime.ts`](../src/features/texture/TextureSetRuntime.ts) 管理一个材质的纹理运行状态：

```text
Immutable Source Texture
        │
        ├── Local adjustment preview
        │
        └── Decal bake
                ▼
         Working Texture
```

原始导入纹理不会被覆盖。

Hue、Saturation、Brightness 和 Contrast 当前使用 Canvas 进行合成。Selection Mask 的红通道转换为混合权重，只在选区中应用处理结果。

Bake 完成后，每个启用的 PBR 通道显示各自的 Working `CanvasTexture`，但仍保留不可变的导入源纹理。因此：

- Reset 按通道恢复原始贴图；
- Export 按通道导出 Working Texture；
- 新 Bake 按通道替换上一次 Working Texture；
- 当前不维护历史栈或图层栈。

## 12. Projection Capture Actor

[`ProjectionCaptureActor.ts`](../src/features/capture/ProjectionCaptureActor.ts) 表示一个正交投影体，包含：

- Position 和 Quaternion；
- Width、Height、Near 和 Far；
- Orthographic Camera；
- Gizmo Box；
- TransformControls 挂载节点。

Actor 局部空间约定是：

```text
Local X  → capture width
Local Y  → capture height
Local -Z → projection direction
```

初次创建时，代码使用选择样本的世界空间包围盒、平均世界法线和中心，自动推导 Actor 的初始位置、大小和方向。

TransformControls 产生的 Scale 会被吸收到 Width、Height、Near 和 Far，然后将根节点 Scale 恢复为 1。这样正交相机和深度范围由明确参数控制，而不是依赖隐藏的父节点缩放。

## 13. Projection Capture Renderer

[`ProjectionCaptureRenderer.ts`](../src/features/capture/ProjectionCaptureRenderer.ts) 执行多通道离屏渲染，输出：

- BaseColor；
- Roughness；
- Material Normal；
- Metallic；
- Selection Mask；
- View Normal；
- Linear Depth。

### 13.1 为什么 Capture 不包含光照

BaseColor 等材质通道使用自定义 Unlit Shader 直接采样纹理，不经过场景灯光、阴影、高光、IBL 或 Tone Mapping。

因此 Capture 得到的是材质数据，不是屏幕截图。

### 13.2 Material Normal 与 View Normal

Material Normal：

- 来自 Normal Map；
- 描述材质微表面方向；
- 通常是切线空间编码。

View Normal：

- 来自模型几何法线；
- 转换到 Capture Camera 空间；
- 不包含灯光和 Normal Map。

它们可以作为未来图像模型的辅助条件，但当前不会根据它们重建或展平几何。

### 13.3 Depth

Geometry RenderTarget 附加 `DepthTexture`。由于 Capture 使用正交相机，硬件深度和相机距离之间是线性关系。Preview 将其反向为近处白、远处黑：

```glsl
linearDepth = 1.0 - hardwareDepth;
```

Decal 遮挡判断使用 GPU DepthTexture，而不是 8-bit Preview：

- [Three.js `DepthTexture`](https://threejs.org/docs/#api/en/textures/DepthTexture)

### 13.4 非目标材质仍然写入深度

Capture 时：

- 目标材质写颜色和深度；
- 非目标材质不写颜色；
- 非目标材质仍写深度。

所以前方其他几何可以遮挡目标材质，但不会出现在目标通道图中。

### 13.5 Capture 的性能边界

一次 Capture 包含多次场景渲染、多张 RenderTarget、GPU Readback、Canvas 转换和 Data URL 生成，因此适合用户触发或节流更新，不适合每帧执行：

- [Three.js `WebGLRenderTarget`](https://threejs.org/docs/#api/en/renderers/WebGLRenderTarget)

## 14. Decal Actor 与图片输入插槽

[`DecalActor.ts`](../src/features/decal/DecalActor.ts) 继承 `ProjectionCaptureActor`。创建时复制 Capture Actor 的：

- Position；
- Rotation；
- Width 和 Height；
- Near 和 Far；
- Target Material UUID。

Decal 默认使用 Capture 的四个 PBR 通道，每个通道都可以通过统一图片输入独立替换：

```ts
interface DecalImageInput {
  channel: MaterialChannel;
  blob: Blob;
  label: string;
  origin: "capture" | "file" | "generated";
}
```

```text
Capture image ─┐
Imported file ─┼→ DecalImageInput → DecalActor
AI result ─────┘
```

未来 OpenAI、ComfyUI 或其他服务只需要返回 Blob，就可以复用现有 Decal 投影和 Bake，不必让算法依赖特定 Provider。

## 15. Decal 实时 PBR Preview

[`DecalRenderer.ts`](../src/features/decal/DecalRenderer.ts) 不使用一个额外的无光照覆盖 Mesh，而是向目标 `MeshStandardMaterial` 注入投影逻辑：

```text
MeshStandardMaterial samples original BaseColor
→ transform fragment world position into Decal local space
→ test projection box
→ test Capture Depth
→ test surface angle
→ sample Decal and optional Capture Mask
→ blend into diffuseColor
→ continue the standard PBR pipeline
```

BaseColor 混入 `diffuseColor`，Roughness/Metallic 混入标准材质因子，Normal 则从 Projector Basis 转换到目标切线空间并通过 RNM 合成；之后 Three.js 继续计算：

- Normal Map；
- Roughness；
- Metallic；
- Environment/IBL；
- Directional Light；
- Shadows；
- Tone Mapping。

所以 Decal Preview 与模型一起接收光照。

### 15.1 投影体积判断

片元世界坐标乘以 Actor 逆矩阵后，转换到投影器局部空间，再检查：

```text
-width / 2 ... width / 2
-height / 2 ... height / 2
-near ... -far
```

### 15.2 角度保护

当前使用：

```glsl
smoothstep(cos(75°), cos(60°), facing)
```

- 小于 60°：完全接受；
- 60° 到 75°：逐渐淡出；
- 大于 75°：拒绝。

这会降低球体轮廓和大折角处的投影拉伸。

### 15.3 深度拒绝

Decal Renderer 从投影相机生成 DepthTexture，然后比较当前片元与投影器看到的最前方深度：

```text
fragment depth > captured front depth + bias
→ fragment is occluded
→ discard
```

因此 Decal 不会穿透到模型背后的表面。

## 16. GPU UV-space Bake

普通模型渲染将 3D 顶点变换到屏幕：

```text
3D position → camera clip space → screen pixel
```

UV-space Bake 则把模型 UV 当作输出位置：

```glsl
vec2 bakeUv = vec2(uv.x, 1.0 - uv.y);
gl_Position = vec4(bakeUv * 2.0 - 1.0, 0.0, 1.0);
```

模型三角形由此被光栅化到 UV Atlas。Vertex Shader 同时继续传递世界位置、世界法线和原始 UV，所以 Fragment Shader 仍可执行与实时 Preview 相同的投影检查。

完整流程是：

```text
Create RenderTarget at BaseColor resolution
→ copy immutable BaseColor into target
→ rasterize target triangles in UV space
→ project world position into Decal Actor
→ calculate box, depth, angle and mask coverage
→ alpha blend Decal BaseColor
→ perform one GPU readback
→ create the Working CanvasTexture
```

### 16.1 为什么跨 UV 岛也能 Bake

算法没有假设 UV 连续。每个三角形独立执行：

```text
World-space triangle
→ evaluate Decal projection
→ write result into that triangle's UV location
```

一个投影区域跨越多个 UV 岛时，各三角形会分别写进对应的岛。

### 16.2 重叠 UV 的限制

如果两个不同表面共享同一 UV 区域，它们会竞争同一纹素，当前无法保证唯一结果。

这需要用户重做 UV、拆分 Texture Set、使用 UDIM，或由未来的 UV 诊断功能检测并警告。

## 17. 颜色空间

当前的基本约定是：

| 数据 | Color Space |
|---|---|
| BaseColor / Decal Color | sRGB |
| Roughness | NoColorSpace |
| Metallic | NoColorSpace |
| Normal | NoColorSpace |
| Mask | NoColorSpace |
| Depth | NoColorSpace |

BaseColor 的正确处理语义是：

```text
sRGB texture
→ decode to linear
→ blend and light
→ encode to display sRGB
```

Roughness、Metallic、Mask 和 Depth 是数值数据，不应该进行 sRGB 解码。

如果 Preview 和 Bake 使用不同颜色空间，可能出现 Bake 变暗、颜色不一致或数据纹理数值被扭曲：

- [Three.js Color Management](https://threejs.org/manual/en/color-management.html)

## 18. GPU 资源生命周期

JavaScript 对象失去引用后，WebGL 资源不一定立即释放。模型替换和 Viewport 销毁时，需要显式清理：

- Geometry；
- BVH Bounds Tree；
- Material；
- Texture；
- RenderTarget 和 DepthTexture；
- PMREM Texture；
- Controls；
- DOM Event Listener。

面试时可以表述为：

> WebGL resources have a separate GPU-side lifetime, so the viewport explicitly disposes geometries, materials, textures, render targets, BVHs, controls and event listeners when models are replaced or the React component unmounts.

## 19. Rust/Tauri 当前边界

当前纹理与渲染算法全部运行在 Tauri WebView 的 TypeScript/Three.js 层。Rust 目前负责：

- 创建桌面窗口；
- 加载 Vite 前端；
- 启动 Tauri 事件循环；
- 注册 Opener 插件；
- 保留一个示范 JavaScript-to-Rust IPC 的 `greet` Command。

因此不能把当前项目描述成“纹理算法由 Rust 实现”。更准确的表述是：

> The current graphics pipeline runs in the TypeScript and Three.js frontend hosted by Tauri. Rust currently provides the desktop shell and remains the intended boundary for trusted filesystem access, project persistence, API secrets and local process management.

- [Tauri Architecture](https://v2.tauri.app/concept/architecture/)
- [Tauri Capabilities](https://v2.tauri.app/security/capabilities/)

## 20. 技术与库的分工

| 技术 | 类型 | 项目中的职责 |
|---|---|---|
| TypeScript | 编程语言 | UI 和渲染运行时代码 |
| Rust | 编程语言 | Tauri 原生端 |
| React | UI 库 | Inspector、文件输入和生命周期 |
| Zustand | 状态库 | 编辑器设置、Summary 和 Command Token |
| Three.js | 3D 图形库 | Scene、Mesh、Camera、PBR、Shader、RenderTarget、Raycaster |
| three-mesh-bvh | Three.js 扩展 | 加速静态 Mesh 射线相交 |
| Vite | 构建工具 | 开发服务器和生产构建 |
| Tauri | 桌面框架 | WebView 窗口、Rust Backend 和应用打包 |
| Cargo | Rust 构建与包管理工具 | 编译 Rust/Tauri |
| Zod | 数据验证库 | 已声明依赖，但当前核心纹理路径尚未使用 |
| HTML Canvas | 浏览器原生 API | Mask、CPU 纹理合成和 PNG 导出 |
| WebGL/GLSL | GPU API/Shader 语言 | Capture、Depth、PBR Preview 和 UV Bake |

- [Zustand Documentation](https://zustand.docs.pmnd.rs/getting-started/introduction)

## 21. 算法选型与取舍

| 问题 | 当前选型 | 优点 | 代价与升级方向 |
|---|---|---|---|
| 模型表面笔刷 | 屏幕圆形多射线 | 符合 Substance Painter 使用习惯 | 大笔刷射线多，可升级 GPU UV/ID Buffer |
| 射线性能 | CPU BVH | 成熟、稳定、效果明显 | 增加模型载入构建时间 |
| Selection Mask | Canvas 双分辨率 | 容易调试且保留源分辨率 | 不适合每帧完整更新 4K Mask |
| Selection Preview | Shader 注入 | 不修改原始贴图 | 依赖 Three.js Shader Chunk |
| Capture | 正交 RenderTarget | 数据确定，可输出多个通道 | GPU Readback 较重 |
| Decal Preview | MeshStandardMaterial 注入 | 继承完整 PBR 光照 | Shader Hook 链接需要谨慎 |
| Bake | GPU UV-space Rasterization | 支持跨 UV 岛，速度较高 | 依赖 UV0，重叠 UV 不唯一 |
| 编辑历史 | 单 Working Texture | 简单可靠 | 尚无 Layer 与 Undo 系统 |
| AI 接口 | Provider-neutral Blob | 可以切换图片来源 | 尚未连接真实 API |

## 22. 常见面试问题

### 为什么不用 Three.js `DecalGeometry`？

`DecalGeometry` 适合生成实时贴合表面的额外几何，但本项目最终需要把结果写回原始 BaseColor。因此使用 Projector Actor 和 Shader：Preview 阶段不生成永久几何，Bake 阶段在 UV 空间输出标准纹理。

### BVH 是 GPU 加速吗？

不是。当前 BVH 加速 CPU Raycaster。最终画面仍使用 WebGL Rasterization。

### 为什么不直接在 UV 上画圆？

屏幕空间圆投影到曲面后通常不是 UV 空间圆，而且可能跨 UV 岛。因此先在屏幕空间采样，再逐点射线获取真实 UV。

### Depth 和 Normal 是否用于重建曲面？

当前不重建。Mesh 仍是几何真值，Depth 和 View Normal 只用于模型参考条件、遮挡判断、角度保护和未来失真分析。

### 为什么 Preview 和 Bake 是两条渲染路径？

Preview 需要实时显示并参与 PBR，因此注入 `MeshStandardMaterial`。Bake 需要写入 UV Atlas，因此使用独立 UV-space Shader。两条路径共享投影盒、深度、角度和 Mask 规则。

### 为什么 Zustand 不存 Actor？

Actor 包含 Camera、Matrix、Texture 和 GPU 生命周期，不能可靠序列化。Zustand 只保存 Summary 和用户设置，真实 Actor 由 `ThreeViewport` 持有。

### 如何支持多材质模型？

通过交点面的 `materialIndex` 定位材质槽，再用 Material UUID 锁定 Texture Set。Selection、Capture、Preview 和 Bake 都限制在相同 UUID。

### 当前最大的交互性能瓶颈是什么？

大笔刷仍会产生较多 CPU 射线。BVH 已降低每条射线的三角形测试成本，但后续可以通过 GPU UV/Material ID Picking Buffer 将大量 CPU Raycast 替换成 GPU 投影或像素读取。

## 23. 当前功能边界

当前支持：

- 静态 GLB Mesh；
- UV0；
- `MeshStandardMaterial`；
- 多材质槽隔离；
- 单个活动 Capture Actor；
- 单个活动 Decal Actor；
- BaseColor、Roughness、Metallic 和 OpenGL Normal Bake；
- Capture、File 和 Generated 三类 Decal 图片输入。

当前不支持：

- SkinnedMesh Bake；
- Position Morph Bake；
- UDIM；
- 无 UV 模型；
- 重叠 UV 唯一性处理；
- 多 Decal 图层；
- Normal、Roughness、Metallic Decal Bake；
- Undo/Redo 历史；
- 工程持久化；
- ComfyUI 或远程图像 API；
- 自动重做 UV；
- 根据 Depth/Normal 自动展平曲面。

在作品集和面试中主动说明这些边界，可以表现出对“功能原型”和“生产级工具”的区别有清晰认识。

## 24. 推荐阅读顺序

1. 阅读 [`src/types/editor.ts`](../src/types/editor.ts)，认识状态、Actor、结果和设置类型。
2. 阅读 [`src/state/editorStore.ts`](../src/state/editorStore.ts)，理解普通状态和 Command Token。
3. 阅读 [`src/features/viewport/Viewport3D.tsx`](../src/features/viewport/Viewport3D.tsx)，理解 React 如何创建和驱动 ThreeViewport。
4. 阅读 [`src/features/viewport/ThreeViewport.ts`](../src/features/viewport/ThreeViewport.ts) 的构造、模型加载与 `animate()`。
5. 结合 [`SelectionMask.ts`](../src/features/mask/SelectionMask.ts)，追踪一次 Pointer Down、Move、Up。
6. 阅读 [`ProjectionCaptureActor.ts`](../src/features/capture/ProjectionCaptureActor.ts) 和 [`ProjectionCaptureRenderer.ts`](../src/features/capture/ProjectionCaptureRenderer.ts)，理解投影空间与多 Pass Capture。
7. 最后阅读 [`DecalRenderer.ts`](../src/features/decal/DecalRenderer.ts)，理解实时投影和 UV-space Bake。

完成后，尝试不看代码回答：

1. 一个屏幕采样点如何变成模型 UV？
2. 一个选区如何生成 Capture Actor？
3. 一个 Decal 片元为什么会被接受、淡出或拒绝？
4. 一个 3D 投影如何最终写进 2D BaseColor UV Atlas？

如果能独立画出这四条数据流，就已经能够在面试中解释当前工程的主体架构与算法。
