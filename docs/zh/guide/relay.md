# 在外访问家中的 Swiftnest

中转是一台由你租用的小云服务器（VPS）。家里的 Swiftnest 主动连接它；你出门后，App 也连接它，它只负责传递加密数据。聊天和审批的内容只在 App 与家中服务器之间解密，中转看不到内容，也不能冒充你已配对的服务器。它仍能看到连接时间、数据量和服务器编号。Swiftnest 没有默认中转；不设置时，家中的局域网使用方式不变。

## 准备

1. 向任意云服务器提供商购买最小的常驻 Linux VPS。建议 1 核、1 GB 内存、10 GB 磁盘；安装时构建需要临时 2 GB 内存或交换空间。无需显卡。选择离家较近、支持公网 IPv4、允许入站 80/443 端口的方案，留意流量额度和自动续费。
2. 系统选 Debian 12/13 或 Ubuntu 24.04/26.04 LTS。家中服务器保持开机、联网；家中路由器不用开放任何端口。
3. 准备一个域名，例如 `relay.example.com`，在域名管理页面添加 A 记录，值是 VPS 的公网 IPv4。若不使用 IPv6，请不要添加 AAAA 记录。在云服务器的防火墙页面允许 TCP 80、443，以及你登录服务器的 SSH 端口。

没有域名时，最简单安全的选择是先通过你信任的私人 VPN 访问家中服务器，或请熟悉电脑的人建立 SSH 隧道到 VPS 的回环监听地址。不要把 `http://公网IP:8787` 填进 App，也不要跳过证书检查。安装器会在缺少域名时停止；普通公网 relay 必须使用 HTTPS。

## 在 VPS 上运行一个命令

用提供商的网页终端以 root 登录，替换下面的域名，再整行粘贴：

```sh
apt-get update && apt-get install -y curl && curl -fsSL https://raw.githubusercontent.com/lvy-jsd/swiftnest/main/packages/relay/install.sh -o /tmp/swiftnest-relay-install.sh && sh /tmp/swiftnest-relay-install.sh relay.example.com
```

该命令适用于已发布 R2 的 `main`；发布前测试时把下载地址和 `SWIFTNEST_RELAY_REF` 都改为包含 R2 的分支或标签。可先下载阅读脚本再执行。脚本会安装 Docker、从源代码构建中转、生成随机密钥，并启动中转与 Caddy。选用容器是为了不要求你安装 Node 或手写系统服务；两者都设置了自动重启。中转仅监听 VPS 自己的回环地址，由 Caddy 提供公网 HTTPS 入口。Caddy 自动向 Let's Encrypt 申请并续期证书，证书保存在独立卷中，中转不保存任何聊天或转发数据，也没有访问日志。[Caddy 的 HTTPS 说明](https://caddyserver.com/docs/automatic-https)

等几分钟，命令最后会显示「中转地址」与「中转密钥」。把两项保存到密码管理器，密钥不要发给其他人。密钥也存在 VPS 的 `/opt/swiftnest-relay/relay.env`，仅 root 可读。先在浏览器打开 `https://relay.example.com/health`：空白页面且没有证书警告就表示已就绪。首次申请证书可能还要等一分钟。

## 在 App 中填写

1. 在家中 Wi-Fi 下打开**已配对的桌面或手机 App**。首次配对必须在家中完成。
2. 打开「偏好设置」，展开「高级：在外访问」。把安装输出的 HTTPS 地址和密钥分别粘贴进去，点击「保存」。
3. 几秒后点击「检查连接」。看到「你的服务器已连接中转」后，让其他已配对 App 在家中重新连接一次。它们会通过加密通道自动学习新地址和密钥，无需重新配对。
4. 手机关闭 Wi-Fi，改用流量，重新打开 App，发送一句话，检查是否收到回复。设置中会显示「此 App 正在使用你的中转」。试一条需要审批的请求并回答它。

桌面/手机 App 将密钥与配对凭据保存在原有的私密文件中，不存入网页存储。网页 App 的密钥只在当前页面内存中保留；公网中转本身不托管网页 App，请使用安装版 App 出门访问。App 每次连接先尝试家中地址，失败后才使用中转；不会自动重发已发送的聊天。回家后重新连接即可优先使用局域网。

实时画面、接管和文件传输暂时仅支持家中 Wi-Fi，App 会显示说明。中转默认每台服务器最多 8 条连接，单帧最多 128 KiB，双方合计每秒 256 KiB / 128 帧，允许短暂 1 MiB 突发；不适合大文件或视频。达到限制时会断开，请稍候重新连接。

中转和家中的加密通道还默认限制每个 IP 最多 8 条尚未完成认证的连接、每分钟 60 次连接尝试。安装脚本让中转只信任来自 `127.0.0.1` 的 Caddy 所提供的真实客户端 IP；客户端自行填写转发头不能冒充别人的 IP。若更换代理，将 `SWIFTNEST_RELAY_TRUST_PROXY` 设为紧邻中转的代理 IP，并让它在 `X-Forwarded-For` 的末尾添加或直接填写真实客户端 IP。不设置时默认不信任代理。

## 可选：给家中的网页版加 HTTPS 入口

按前面通常的方式安装，可以跳过本节：VPS 安装脚本已经处理了中转的 TLS。本节只适用于已经使用「反向代理」的所有者，也就是让 Caddy 等程序接收 HTTPS，再把请求交给 Swiftnest。使用中转不需要给家中路由器开放端口。

例如，Caddy 和 Swiftnest 运行在同一台家中电脑上时，可以使用：

```text
assistant.example.com {
  reverse_proxy 127.0.0.1:3077
}
```

在**家中 Swiftnest 进程**的环境中设置下面两项，再按平时的启动方式重启它：

```sh
export SWIFTNEST_TRUSTED_PROXY_IP=127.0.0.1
export SWIFTNEST_TRUSTED_PROXY_ORIGIN=https://assistant.example.com
```

替换为你实际使用的完整 HTTPS 来源地址（非 443 端口也要写上，不带结尾斜杠或路径）。IP 必须是 Swiftnest 实际看到的代理 IP，也可能是 `::1`，或另一台电脑的明确内网 IP。代理到 Swiftnest 之间应使用私人网络。Caddy 会保留 Host/Origin、支持 WebSocket，并提供客户端 IP；其他代理也需要这样设置，不要通过改写 Origin 来隐藏来自其他网站的请求。[Caddy 的转发头与流式连接说明](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)

打开重启后打印的新版**网页版 App 链接**；它会使用这个 HTTPS 地址，并保留服务器公钥。配对一次、新建聊天，然后刷新页面：应保持原聊天，无需再次配对。代理 IP 或来源地址缺失、填错时会返回 403；同时去掉这两个设置，即可关闭代理信任。任意客户端发来的转发 Host 或协议头都不能自动开启这项信任。

浏览器把原有签名会话保存在 `HttpOnly; SameSite=Strict` Cookie 中（HTTPS 下另加 `Secure`），网页脚本读不到它。每次刷新，仅换取一张有效 30 秒、只能使用一次的票据，用来打开已固定公钥的加密通道。所有者凭据不会返回给 JavaScript，也不写入 local/session storage；本地存储仅保留公开的服务器公钥和地址等信息。清除 Cookie 或会话过期后，需要重新配对。

## 常见问题

| 现象                     | 处理                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| 地址打不开或证书警告     | 确认域名 A 记录、80/443 端口和时间正确；删除错误的 AAAA 记录。不要继续访问有证书警告的地址。        |
| 一直「尚未连接」         | 确认家中服务器开机、能访问外网；重新粘贴地址和密钥，留意空格。                                      |
| 家里能用，在外不行       | 出门前让这台 App 在家重新连接一次以学习地址。使用安装版 App，并检查云服务器是否欠费、流量是否耗尽。 |
| 画面或传输提示需要 Wi-Fi | 当前版本的正常限制，回家后重新连接。                                                                |
| 短时间连接很多次后断开   | 达到连接或速率限制，关闭多余 App，稍候再连。                                                        |
| 密钥泄漏                 | 在 VPS 更换 `relay.env` 中密钥并重建中转容器，再回家在 App 中保存新密钥，让其他 App 重新连接学习。  |

VPS 上查看 TLS 故障：`sudo docker logs --tail 30 swiftnest-relay-tls`。中转本身关闭日志。重启：`sudo docker restart swiftnest-relay swiftnest-relay-tls`。停止远程访问：先在 App 高级设置选择「关闭在外访问」，再执行 `sudo docker stop swiftnest-relay swiftnest-relay-tls`；局域网仍能使用。更新前保留 `relay.env` 和证书卷，从新的已审核版本重新构建镜像，再以安装脚本中的相同参数重建中转容器；不要删除证书卷。

## 可选：服务器配置

熟悉配置文件的所有者也可以设置以下内容并重启 Swiftnest。`relay` 整项省略即关闭；App 保存的 `<home>/relay.json` 优先于这项配置（包括显式关闭）。密钥不要提交到 Git。

```yaml
relay:
  address: https://relay.example.com/
  secret: 安装器显示的密钥
```

也支持 `SWIFTNEST_RELAY_ADDRESS`、`SWIFTNEST_RELAY_SECRET`。这是你家服务器的设置，不是 VPS 中转的环境文件。VPS 中转仅复用已有的 `ws`（MIT 许可）依赖来转发 WebSocket，不增加新的第三方 npm 库。
