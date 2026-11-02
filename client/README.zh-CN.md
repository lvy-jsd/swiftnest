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

桌面和 Android 环境由 `isTauriRuntime()` 检测后动态加载 `src/nativeTransport.ts`，网页不会加载 Tauri 模块。
使用官方 HTTP/WebSocket 插件和手动 Cookie。HTTP 设置 `maxRedirections: 0`、启用 `unsafe-headers`，
并传入空 Origin（插件提供的显式关闭 WebView Origin 注入方式）。Rust HTTP 关闭默认特性，避免共享 Cookie jar，
仍验证 TLS 证书。原生 WebSocket 握手携带 API Cookie。服务器的来源与 fetch-site 校验保持原样，
详见[集成说明](../docs/en/dev/dsh-integration.md)。

能力仅授予本地 **main** 窗口，不向远程页面开放 IPC。HTTP 范围仅包含 HTTP(S) 下用户选择的任意主机和端口，
路径限定为 `/connect`、`/api/*`、`/swiftnest/health`；局域网主机无法预先枚举。
官方 WebSocket 插件当前没有 URL 范围配置，因此只授予必要的 `allow-connect`、`allow-send`，
应用根据配对后的根地址派生连接地址。没有添加文件系统、Shell 或导航权限。
上述 HTTP 范围对应服务器根路径部署；原生应用若使用带路径前缀的反向代理，需要明确调整能力范围。

桌面开发使用 `pnpm --filter @swiftnest/app tauri dev`，不属于检查命令。Linux 依赖由 Nix 提供，
Windows 需要 Rust/MSVC 与 WebView2。
保留中英切换、系统/明暗主题、强调色、减少动态/透明效果和无障碍弹层；600 像素起双栏、1024 像素起桌面侧栏，
支持 Alt+左方向键返回及手机左边缘滑动返回。

## Android（arm64 调试 APK）

在仓库根目录执行：

```sh
nix develop .#android
pnpm install --frozen-lockfile
pnpm build
# 工程已初始化并纳入版本管理，仅新增目标时需要：
# pnpm --filter @swiftnest/app tauri android init
pnpm --filter @swiftnest/app tauri icon src-tauri/icons/source.svg
pnpm --filter @swiftnest/app tauri android build --debug --target aarch64 --apk
```

应用 ID 为 `dev.swiftnest.app`，支持 Android 7/API 24 及以上。APK 相对于 `client/` 位于
`src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`。
虽然目录名为 universal，仅选择 `aarch64` 时只包含 `arm64-v8a`。使用本地调试签名，仅用于测试。
构建产物、生成的 JNI/Kotlin 桥接代码、本机 Gradle 配置和 SDK/签名设置已忽略；
Gradle wrapper、构建脚本、清单、Activity 和资源应纳入版本管理。不要重新初始化并覆盖已定制的工程。

Android 开发环境提供 JDK 17、Rust Android targets、SDK/API 36、Build Tools 36.0.0、NDK 27.2，
并通过 `GRADLE_OPTS` 使用 SDK 的
`aapt2`。NixOS 上调用 Tauri/Gradle 时需保留该变量，Gradle 从 Maven 下载的 `aapt2` 无法直接运行。
首次构建会下载 Gradle 和 Maven 依赖。Android shell 通过官方 Node 的 Corepack 包装 `pnpm`，
让 Tauri 构建钩子和 Gradle 任务也使用仓库锁定版本，避免 Nix 独立启动器缺少平台二进制的问题。
如果旧 shell 只有 API 34/35，更新仓库后应重新进入 `nix develop .#android`。
生成模板默认的 API 37 已调整为 API 36，与 Tauri Android 库和仓库开发环境保持一致。

局域网聊天：服务器用 `SWIFTNEST_HOST=<服务器的具体局域网 IP>` 启动，将其输出的
`http://192.168.x.y:<端口>/connect?token=…` 配对链接粘贴到 APK 的“配对服务器”，再选择“新建聊天”并发送。
手机需要在同一可信局域网内访问服务器端口。HTTP 和带认证 Cookie 的 WebSocket 与桌面共用原生传输，
服务器跨源校验保持启用。共用能力配置没有平台限制，同样匹配 Android 的本地 `main` 窗口。

`network_security_config.xml` 为阶段 0 的局域网配对允许明文，包括调试和发布构建。
用户选择的 IP 无法在构建时枚举，Android 域名规则也不能表达私有 IP CIDR，因此需要应用级例外。
已有原生 HTTP 路径范围和仅本地 IPC 的限制仍然生效，TLS 证书校验不变。仅在可信网络使用；
阶段 2 增加加密传输时应移除此例外。

Activity 将系统栏、挖孔和键盘的 insets 应用到整个 WebView，并消费这些 insets，避免 CSS 重复留白，
同时设置 `adjustResize`。网页继续使用 CSS safe area 和 `100dvh`。
Android 系统返回先关闭偏好设置，再从详情/配对返回聊天列表，仅首页退出；键盘显示时先由系统正常收起。
仍需真机检查手势/三键导航、旋转/挖孔、键盘显隐、局域网配对和流式聊天；浏览器视口测试不能验证 Android 输入法。

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

## 此设备（桌面）

**设备 → 此设备** 在 App 进程中运行 `native/perch` Rust 库，不需要 Node。控制与后台运行默认关闭，
初始不共享文件夹。用服务器设备页的配对码连接，核对两端指纹后使用文件与命令能力。
完整流程、私钥存储、托盘行为与平台限制见[控制这台电脑](../docs/zh/guide/control-this-computer.md)。
Android 暂时隐藏此界面。Linux 命令隔离需要 bubblewrap；macOS 使用 sandbox-exec，尚未实机验证。
Windows 文件工具可移植，但命令执行在文件系统沙箱完成前拒绝运行；选定语法为 cmd.exe /D /S /C。
App 会将本机身份和指纹与当前服务器设备列表匹配，使用服务器分配的 slug 作为聊天设备上下文；Android 与网页省略此上下文。
后台模式关闭窗口后隐藏到托盘；退出会取消核心任务。不会安装自启动服务。

Cargo 工作区与锁文件位于仓库根目录，包含桌面 App 和 `native/perch`；旧 mesh crate 保持独立：

```sh
cargo check --workspace
cargo test --workspace
cargo build -p swiftnest-perch --example interop
SWIFTNEST_PERCH_E2E=1 pnpm vitest run native/perch/test
```

互通测试启动真实 TS Nest 与 Rust 子进程，覆盖配对指纹、工具发现、读取、审批后写入、命令取消与超时、
断线重连、进程重启与服务器换钥拒绝。仅使用临时目录。`native/perch/DESIGN.md` 描述 E2b/E2c 的独立加密
二进制流设计；本任务不实现截屏、输入或大文件传输。
