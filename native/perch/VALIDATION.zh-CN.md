# 原生设备端验证

[English](VALIDATION.md)

本文为原生设备端验收说明。原英文记录包含早期 E2 实测的逐条输出和历史环境，不能替代当前构建结果。
最新结果以本次执行记录和 F1 总结为准。

## 自动检查

```sh
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
pnpm build
pnpm test
SWIFTNEST_E2E=1 pnpm vitest run native/perch/test packages/api server
SWIFTNEST_WEB_E2E=1 SWIFTNEST_CHROMIUM=/path/to/chrome pnpm vitest run client/test
```

native/locale 检查中英文目录键和占位符一致。原生单元测试覆盖计数器、篡改、重放、帧大小、
截图坐标映射、接管/交还的输入屏障、实时流完整性、传输绑定、持久化审批、损坏块和续传。
capabilities 集成测试检查文件和 shell 的实际边界。interop 使用 Rust 设备与 TS Nest 验证协议互通。

## 桌面手动验收

1. 在“设备 → 此设备”选择普通共享文件夹，保持默认关闭控制和实时画面。
2. 在服务器生成配对码，设备输入配对码；分别核对两端指纹并确认，核对在线状态和稳定 slug。
3. 验证共享目录内读取，写入先等待所有者审批；拒绝后文件不变。
4. 访问密钥、浏览器数据、未共享目录或通过符号链接越界，应被拒绝。
5. 开启后台运行，关闭窗口后通过托盘恢复；退出应断开，不留下子进程。
6. 禁用与 unpair 即使存在未保存的无效编辑也必须可以执行。撤销后不能自动重新加入。

## 画面和输入

X11、wlroots、portal、Windows 需要分别验证，某个平台通过不表示其他平台也通过。
portal 必须由所有者选显示器并授予指针、键盘权限；无授权或缺少 PipeWire/GStreamer 支持时明确失败。
Windows 的安全桌面、UAC 桌面和更高完整性窗口不保证可控制。

截图后检查 displayId、captureId、原生尺寸和缩放坐标；改变显示器几何信息后，旧坐标应被拒绝。
实时画面需先在本机启用，托盘与通知应显示共享状态；所有者接管后智能体输入停止，交还后恢复。
测试轻点、右键长按、拖动、滚动、文本和组合键；关闭查看端、本机停止、断网和租约过期均应释放连接。
真实画面验收还需要显式设置 SWIFTNEST_SCREEN_E2E=1，并提供实际桌面环境；不能由模拟画面测试替代。

## 传输和移动端

检验直连、中继、暂停、继续、取消、重试；比较最终文件哈希。
来源变更、身份变化、目标已存在、临时 symlink、损坏块和不合法续传位置必须失败。
Android 与 Web 不应出现“控制这台电脑”等不可用桌面选项。

## 中文与英文

新安装默认中文；设置切换英文后重载保留；服务器保存后其他已连接设备跟随。
显式设置测试 locale，不依赖操作系统语言。390px 中文截图覆盖长文案和按钮换行，
英文用于验证可选语言。检查托盘、系统通知、原生选择窗口和 message/hint 是否使用同一选择。
