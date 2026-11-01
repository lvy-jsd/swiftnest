# Swiftnest 应用

[English](README.md) | 简体中文

本应用采用 Apache-2.0 许可证，使用 React 19、严格模式 TypeScript、Vite 和 Tauri 2。
组件和图形资源均为原创，Phosphor 图标及 TanStack Virtual 使用 MIT 许可证。
开发请遵循[设计规范](../docs/zh/dev/design-system.md)。

在仓库根目录执行命令。Nix 开发环境提供 Node 24+、pnpm、Rust 及 Linux 桌面依赖。

```bash
nix develop
pnpm install
pnpm --filter @swiftnest/app dev
```

打开 `http://127.0.0.1:1420`。构建纯网页版本：

```bash
pnpm --filter @swiftnest/app build:web
```

将 `client/dist/` 部署到静态网站服务器即可。相对资源路径与哈希路由支持子路径和聊天深链接，
无需服务器重写规则。网页运行不依赖 Tauri API；`src/runtime.ts` 通过
`window.__TAURI_INTERNALS__` 检测原生环境。

桌面开发（Linux 和 Windows）：

```bash
nix develop
pnpm --filter @swiftnest/app tauri dev
```

CLI 会自动启动 Vite。Windows 开发需要 Windows Rust/MSVC 工具链及 Tauri 的 WebView2 依赖；
Nix 开发环境提供 Linux 依赖。目前未安装原生插件。Android 初始化留待后续进行，
现有 Rust 库入口及 Vite 主机配置可用于后续移动端开发。

运行检查：

```bash
pnpm build
pnpm test
pnpm --filter @swiftnest/app test
pnpm --filter @swiftnest/app build:web
cd client/src-tauri
cargo check
```

根目录 `pnpm build` 通过 TypeScript 项目引用检查客户端，`build:web` 还会打包网页。
测试覆盖精确的设计尺寸、五种预设在明暗主题下所有文本与背景组合的对比度、自定义色相、
减少动态效果、颜色转换、双语渲染及路由。

点击头像按钮可设置语言、跟随系统或强制明暗主题、五种强调色或自定义色相、减少动态效果和减少透明效果。
应用也会遵循系统无障碍偏好；不支持模糊时，玻璃表面自动使用不透明背景。
偏好设置和示例消息仅保存在内存中。600 像素起显示双栏布局（包括横屏手机），
1024 像素起使用桌面侧栏。Alt+左方向键返回聊天列表，Ctrl/Cmd+Enter 发送消息；手机还支持从左边缘滑动返回。
聊天记录和列表布局超过 50 行时启用虚拟化。弹层限制焦点范围，并支持 Escape 关闭。

示例消息仅在本地显示。`src/App.tsx` 的 TODO 标注了未来 `@swiftnest/api` 的接入位置。
流式响应、立即发送或排队、审批、工具及文件卡片需要后端接入，目前不会模拟这些行为。
真机性能测试和 Android 初始化留待后续完成。
