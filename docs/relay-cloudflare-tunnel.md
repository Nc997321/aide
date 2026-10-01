# 远程链路与 Cloudflare Tunnel 部署文档

> 2026-10-02 配对联调定稿。本文回答三件事：**为什么以前时好时坏**、**隧道为什么能治本**、**这套东西装在哪怎么运维**。

## 1. 最终架构

```
手机(任意网络: 蜂窝/Wi-Fi/异地)
    │  wss://relay.aideai.store/ws   (TLS, CF Universal SSL 证书 *.aideai.store)
    ▼
Cloudflare 边缘 (anycast: 104.21.4.213 / 172.67.132.129, 免费版落地 LAX)
    │  Cloudflare Tunnel ①②  (既有出站长连接, TCP 7844, http2 协议)
    ▼
本机 cloudflared 服务 ③  (Windows 服务 "Cloudflared", 开机自启)
    │  http://127.0.0.1:8787
    ▼
aide-relay ④  (哑管道中继, 只听回环)
    ▲
    │  wss://relay.aideai.store  (同样经隧道出站注册)
桌面 aide ⑤
```

一图总结：**家里不再有任何入站端口暴露**。手机和桌面都是"往外连"，家宽给什么 IP、前缀怎么轮换、路由器在不在 NAT 后面，全部无关。

## 2. 为什么以前"时好时坏"——三个根因

联调期间逐个实锤的问题，按严重程度排列：

### 2.1 家宽前缀轮换 + 运营商 DNS 无视 TTL（主因）

家宽只有 IPv6 公网地址，且**前缀每小时轮换**。`home.aideai.store` 的 AAAA 记录由 `aide-ddns` 计划任务追着更新，但运营商递归 DNS 把记录缓存**数天**、无视 TTL。实测手机解析到 9 月 29 日时代的死地址（`...54a1:16e0:...`，当天前缀早已轮换）。表现为：**刚更新 DDNS 的几小时能用，之后随机失联**。

华为浏览器用 HTTPDNS 绕过了系统解析，所以"浏览器能开"造成了长期误判——原生 App 走系统解析，拿到的是死地址。

### 2.2 本地 DNS 投毒

`api.cloudflare.com` 被链路级投毒：本地解析返回假 IP（`141.193.154.x`/`182.16.61.x`），假服务器回一张**不含任何域名的 TLS 证书**。表现为 cloudflared 建隧道时报 `x509: certificate is not valid for any names`。

### 2.3 OHOS 平台缺陷（压垮 v6 直连路径）

鸿蒙 netstack 两个实锤缺陷（`sdk/ws-ohos.ets` 文件头有 2026-09-12 的实测记录）：

- 对 IPv6 字面量 URL 生成**无括号 Host 头**（`2409:...:9541:8000`）→ nginx 解析层直接 400；
- 自定义 Host 头覆盖**被 netstack 无视**。

所以 v6 字面量中继地址在鸿蒙上不可用（`sdk/doh.ets` 因此主动禁了 v6 直连、回落域名路径——又撞上 2.1）。

**结论**：v2 时代"能用"是 DNS 缓存恰好新鲜时的运气；三条问题叠加决定旧架构（AAAA + DDNS + 直连家宽）永远不稳定。

## 3. 为什么 Cloudflare Tunnel 治本

| 旧痛点 | 隧道后 |
|---|---|
| 域名指向会过期的家宽地址 | 域名指向 CF 边缘 anycast（**永不过期**，缓存再陈旧也能连上） |
| 依赖 DDNS 追轮换 | 纯出站连接，**家里 IP 无所谓**，CGNAT 都能用 |
| 需要防火墙放行/端口可达 | 零入站暴露 |
| OHOS v6 字面量 Host 400 | 全程域名 + wss，TLS 在 CF 边缘终止，SNI/证书天然正确 |

原理一句话：cloudflared 在本机常驻，**主动**向 CF 边缘（`region1/region2.v2.argotunnel.com:7844`）建立并维持 4 条长连接（本例注册在 LAX）；外界访问 `relay.aideai.store` 时流量先到 CF 边缘，再顺着这些既有连接流回本机。方向反转了——不是"别人连进来"，而是"我伸出去一条管道，别人往管道里灌"。

### 备选方案为什么没选

- **A. 手机加密 DNS**（`dns.alidns.com` DoH）：治标。绕开运营商缓存，但前缀轮换后仍有 ≤10 分钟自愈窗口，且只修手机端。
- **C. VPS 自建中继**（`docs/superpowers/specs/2026-08-16-remote-gateway-design.md` 原案，中继部署公网 VPS）：架构上最直接，但没有现成 VPS，放弃。

## 4. 当前配置清单

| 项 | 值 |
|---|---|
| 公网入口 | `wss://relay.aideai.store/ws` |
| DNS 记录 | `relay.aideai.store` CNAME → `<tunnel-uuid>.cfargotunnel.com`（CF 代理开启） |
| 隧道配置 | `C:\Users\<user>\.cloudflared\config.yml`（ingress: relay.aideai.store → http://127.0.0.1:8787，兜底 404） |
| 隧道凭据 | `C:\Users\<user>\.cloudflared\<tunnel-uuid>.json`（保密，删掉即吊销） |
| Windows 服务 | `Cloudflared`（Automatic / LocalSystem） |
| 服务 ImagePath | 注册表 `HKLM\SYSTEM\CurrentControlSet\Services\Cloudflared`，值为 `C:\PROGRA~2\cloudflared\cloudflared.exe tunnel --config C:\Users\<user>\.cloudflared\config.yml run aide-relay` |
| hosts 钉死 ① | `104.19.192.29 api.cloudflare.com`（治 DNS 投毒） |
| hosts 钉死 ② | `104.21.4.213 relay.aideai.store`（治路由器负缓存，见 §6.3） |
| 中继 | aide-relay，`127.0.0.1:8787`（ aide.exe 注册 + 手机接入都经隧道进来） |
| 保持不变 | `home.aideai.store:8000`（nginx PWA + DDNS 任务）与本次改造无关，照旧 |

应用侧：PC 远程设置的中继地址 = `wss://relay.aideai.store`（一个设置同时决定 aide.exe 注册路径和二维码内容）；手机已用该地址重新配对。

## 5. 部署实录（含三个坑）

### 5.1 标准流程

```
winget install Cloudflare.cloudflared
cloudflared tunnel login                    # 浏览器授权 aideai.store zone → cert.pem
cloudflared tunnel create aide-relay        # → <uuid>.json 凭据
# 写 config.yml（见 §4）
cloudflared tunnel route dns aide-relay relay.aideai.store   # 建 CNAME
cloudflared service install                 # 装 Windows 服务（见 5.3 的坑）
```

### 5.2 坑一：api.cloudflare.com 被 DNS 投毒

**症状**：`tunnel create` 报 `x509: certificate is not valid for any names`；`Resolve-DnsName api.cloudflare.com` 返回 `141.193.x/182.16.x` 假 IP。

**诊断**：浏览器（走 Clash 系统代理）正常、curl 直连卡死 → 疑点收窄到 DNS；DoH 查真值对比实锤。cloudflared 是 Go 程序，只认环境变量代理、不吃系统代理，代理变量救不了它。

**修法**：hosts 钉真 IP（`104.19.192.29 api.cloudflare.com`）+ `ipconfig /flushdns`。CF 的 104.19.x/104.21.x 段按 SNI 路由，钉错邻近 IP 都能工作，极稳。

### 5.3 坑二：`service install` 裸装 → 服务跑了个寂寞

**症状**：服务 Running，但公网访问 530（CF 边缘找不到隧道）；事件日志显示服务命令行是光秃秃的 exe。

**原因**：`cloudflared service install` 不带参数时，LocalSystem 服务到 `C:\Windows\System32\config\systemprofile\.cloudflared\` 找配置——那里没有 config.yml，隧道根本没跑。

**修法**：注册表直接写 ImagePath 带全参数（见 §4）。经验：
- `sc.exe config` 的 binPath 引号拼接在 PowerShell 里极易翻车，用 `Set-ItemProperty` 写注册表 ImagePath 更稳；
- exe 路径用 8.3 短名 `C:\PROGRA~2\` 整条命令行零空格零引号，彻底绕开转义问题。

### 5.4 坑三：路由器 DNS 负缓存

**症状**：记录已创建、DoH/阿里 DNS 都能解析，但本机 `nslookup` 仍 NXDOMAIN → aide.exe 报 `os error 11001 不知道这样的主机`。

**原因**：DNS 服务器是路由器（`cmcc.wifi` / `fe80::1`）。我在 CNAME 创建**之前**查询过一次 `relay.aideai.store`，这次 NXDOMAIN 被路由器/上游缓存且**无视 TTL 不释放**。

**修法**：PC 再钉一条 hosts（`104.21.4.213 relay.aideai.store`）。手机蜂窝不受影响（运营商 DNS 没有这条负缓存）；家里 Wi-Fi 下手机要等路由器缓存自己释放，急用可重启路由器。

### 5.5 PowerShell 两个教训（复现时别再踩）

- `Start-Process -ArgumentList` 拼含内嵌引号的参数会拆碎命令——提权脚本一律 `-EncodedCommand`（base64）；
- .NET 方法调用（`[System.Net.Dns]::GetHostAddresses()`）不能加 `-ErrorAction`，它不是 cmdlet，整条命令会解析失败；用 try/catch。

## 6. 运维手册

### 6.1 健康检查（一条命令判断全链路）

```powershell
curl.exe -s -i -N --max-time 6 -H "Connection: Upgrade" -H "Upgrade: websocket" `
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" -H "Sec-WebSocket-Version: 13" `
  https://relay.aideai.store/ws
# 首行 HTTP/1.1 101 Switching Protocols = 隧道+中继全通
# 530 = 隧道断（看服务） / 400 = 到达了但升级失败（不该出现）
```

### 6.2 服务启停与日志

```powershell
Get-Service Cloudflared                 # 状态
Restart-Service Cloudflared             # 重启（改完 config.yml 后执行）
Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=(Get-Date).AddHours(-1)} |
  Where-Object { $_.Message -match 'cloudflared|tunnel' } | Select-Object -First 20 TimeCreated, Message
```

### 6.3 已知限制

- **延迟**：CF 免费版对大陆流量落地海外边缘（实测 LAX），手机↔桌面每帧约 +150~300ms。聊天/事件流可接受；未来要低延迟可再评估 VPS 方案（§3-C）。
- **CF 空闲超时 ~100s**：连接无流量 100 秒会被边缘切断。协议已免疫——手机腿 20s keepalive、桌面腿中继 30s Ping（`relay-server/src/handler.rs`），全部低于切断线。这也是 protocol 层设计 keepalive 的原因之一。
- **hosts 两条钉死记录**（§4）：CF 边缘按 SNI 路由，IP 极稳，但若哪天 `tunnel create/route dns` 又报证书错误或 aide.exe 报 11001，先用 DoH 查真值更新这两条。
- **家里 Wi-Fi 的手机**：受 §5.4 负缓存影响，路由器缓存释放前解析不到新域名（PC 已被 hosts 兜住）。蜂窝不受影响。
- **凭据安全**：`<uuid>.json` 是隧道身份，泄露=别人能把你的域名流量引到他机器上。别进 git。

### 6.4 常见变更

| 变更 | 操作 |
|---|---|
| 换/加公网主机名 | config.yml 的 ingress 加条目 → `cloudflared tunnel route dns aide-relay <新域名>` → 重启服务 |
| 中继换端口 | 改 config.yml ingress 的 `service:` → 重启服务（aide-relay 自身监听地址另改） |
| 吊销隧道 | CF Dashboard 删隧道，或删除 `<uuid>.json` 后重启服务 |
| 升级 cloudflared | `winget upgrade Cloudflare.cloudflared` → `Restart-Service Cloudflared` |

## 7. 故障速查

| 症状 | 定位 | 见 |
|---|---|---|
| aide.exe `os error 11001` | PC 解析失败 → hosts 是否有 `104.21.4.213 relay.aideai.store` | §5.4 |
| 公网访问 530 | 隧道没连上 → `Get-Service Cloudflared` + 事件日志；确认 ImagePath 带参数 | §5.3 |
| `tunnel create` x509 报错 | api.cloudflare.com 投毒 → hosts 钉 IP | §5.2 |
| 手机蜂窝连不上但 PC 正常 | 用阿里 DoH 核对解析真值；核对 QR 里的 relay 是否 `wss://relay.aideai.store` | §6.1 |
| 能配对但很快掉线 | keepalive 链路（手机 20s / 桌面 30s Ping）被中间设备拦截，抓 hilog + 事件日志 | §6.3 |
