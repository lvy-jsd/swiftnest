# Swiftnest 应用

[English](README.md) | 简体中文

采用 Apache-2.0 许可证，使用 React 19、严格 TypeScript、Vite 和 Tauri 2。
组件与资源均为原创，Phosphor 图标和 TanStack Virtual 使用 MIT 许可证，不使用 DSH Go 代码。
开发遵循[设计规范](../docs/zh/dev/design-system.md)。

在仓库根目录进入 `nix develop` 后执行：

```sh
pnpm install
pnpm build
pnpm --filter @swiftnest/app build:web
SWIFTNEST_APP_DIST="$PWD/client/dist" node server/dist/cli.js start
```

打开服务器打印的 **App (web)** 链接。服务器在与 API 同源的 `/app/` 提供应用，
通过 `#/pair?url=<编码后的配对链接>` 自动配对，随后清除地址栏里的配对链接和令牌，显示真实聊天列表。
也可以打开 `#/pair`，粘贴服务器打印的 Swiftnest App 配对链接；还支持 `/app/?url=…#/pair`。
选择“新建聊天”，输入消息后发送，或按 Ctrl/Cmd+Enter。生成期间输入框和发送功能仍可用，
后续消息会排队等待下一轮。助手文字在原处逐步增长，最终消息覆盖临时文本；思考状态显示计时，
完成的工具调用折叠为一行，错误直接显示，其他事件使用可展开的通用卡片。记录和列表超过 50 行时虚拟化。

同一 Wi-Fi 的其他设备访问时，用 `SWIFTNEST_HOST=<服务器的具体局域网 IP>` 启动服务器，
在设备上打开对应的 App (web) 链接。明文 HTTP 仅用于可信网络。浏览器应用必须与服务器**同源**，
不能将文件部署到无关的静态站点后直接配对。
`pnpm --filter @swiftnest/app dev` 在 `http://127.0.0.1:1420` 预览界面；真实网页聊天应使用服务器托管的构建版本。
资源采用相对路径，页面导航使用哈希路由。

`src/connection.tsx` 管理唯一的临时 `@swiftnest/api` 客户端。localStorage 只保存服务器根地址
（`swiftnest.serverRoot`），令牌和原生 Cookie 只保存在内存中，网页 Cookie 留在浏览器 Cookie jar。
阶段 0 刷新或断线后需要“重新配对”，不会自动重发消息或重试写入。重新打开聊天时恢复服务器最近的记录；
更早历史分页和交互式审批/问题控件留待后续。

桌面环境由 `isTauriRuntime()` 检测后动态加载 `src/nativeTransport.ts`，网页不会加载 Tauri 模块。
使用官方 HTTP/WebSocket 插件和手动 Cookie。HTTP 设置 `maxRedirections: 0`、启用 `unsafe-headers`，
并传入空 Origin（插件提供的显式关闭 WebView Origin 注入方式）。Rust HTTP 关闭默认特性，避免共享 Cookie jar，
仍验证 TLS 证书。原生 WebSocket 握手携带 API Cookie。服务器的来源与 fetch-site 校验保持原样，
详见[集成说明](../docs/en/dev/dsh-integration.md)。

能力仅授予本地 **main** 窗口，不向远程页面开放 IPC。HTTP 范围仅包含 HTTP(S) 下用户选择的任意主机和端口，
路径限定为 `/connect`、`/api/*`、`/swiftnest/health`；局域网主机无法预先枚举。
官方 WebSocket 插件当前没有 URL 范围配置，因此只授予必要的 `allow-connect`、`allow-send`，
应用根据配对后的根地址派生连接地址。没有添加文件系统、Shell 或导航权限。
上述 HTTP 范围对应服务器根路径部署；桌面若使用带路径前缀的反向代理，需要明确调整能力范围。

桌面开发使用 `pnpm --filter @swiftnest/app tauri dev`，不属于检查命令。Linux 依赖由 Nix 提供，
Windows 需要 Rust/MSVC 与 WebView2。Android 打包和真机性能测试留待后续。
保留中英切换、系统/明暗主题、强调色、减少动态/透明效果和无障碍弹层；600 像素起双栏、1024 像素起桌面侧栏，
支持 Alt+左方向键返回及手机左边缘滑动返回。

检查无需启动或打包 Tauri：

```sh
pnpm build
pnpm test
pnpm --filter @swiftnest/app build:web
cargo check --manifest-path client/src-tauri/Cargo.toml
SWIFTNEST_E2E=1 pnpm vitest run packages/api server
SWIFTNEST_WEB_E2E=1 pnpm vitest run client/test/web.e2e.test.ts
```

可选网页端到端测试会启动隔离的真实内核和假 SSE 模型，在 Chromium 中完成配对、新建聊天、流式接收、排队发送与历史恢复，
最后清理资源。先构建网页；浏览器无法启动时干净跳过，不会自动下载浏览器。
可用 `SWIFTNEST_CHROMIUM=/path/to/chrome` 指定系统浏览器。有非回环 IPv4 地址时，也验证明文局域网页面的 UUID 兼容路径。
单元测试覆盖连接状态、原生适配器、API 事件夹具到聊天记录的转换、路由、翻译、设计尺寸、对比度和动效。
