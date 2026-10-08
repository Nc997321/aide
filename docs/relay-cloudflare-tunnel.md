# 远程链路与 Cloudflare Tunnel 部署文档（已迁往知识库）

> **2026-10-05：本文停更。** 唯一权威版在知识库 **「Aide 构建与运维」→《远程链路与 Cloudflare Tunnel 部署文档》**。
> 需要改（架构/运维/故障速查）请改知识库那份，别在这里续写。

**为什么迁走**：这份文档带机器细节（隧道凭据路径、Windows/WSL 单元名、提权脚本、DDNS 任务），
而运维实录（DDNS、cloudflared、ZeroTier、构建套件）本来就统一住在知识库「Aide 构建与运维」。
仓库这份还曾在提交里带上真实隧道 UUID（本文件已清出，历史提交里仍有记录；发布镜像按
`scripts/publish-github.sh` 的清洗规则处理，新增敏感类型时同步 `~/.config/aide-publish/forbidden.txt`）。

**不需要知识库也能用的最小信息**：

- 公网入口：中继地址**由用户自己填**（2026-10-05 起没有出厂默认）——入口是侧栏「连接移动端」卡片，
  命令 `link_set_relay_url`，值存 Host 密钥库 `link/relayUrl`。本机填的是 `wss://relay.aideai.store/ws`；
  `AIDE_RELAY_URL` 只是 dev/测试种子。旧设置里的 `settings.remote.relayUrl` 不生效。
- 协议本体与帧契约：`docs/aide-link-protocol.md`；Host 侧网关：`crates/aide-link/`、`aide-core/src/link/`；
  哑管道中继实现：`relay-server/`。
- 运维细节（WSL 单元、日志路径、切换/回滚脚本、健康检查、故障速查）：见知识库那份。
