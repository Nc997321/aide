# 会话接续

桌面侧栏会话右键 →「接续到新会话…」→ 填写可选的下一阶段目标 → 生成并编辑摘要 → 创建新会话。

交接摘要生成使用点击时当前选定的供应商、新会话默认模型和档位，与普通空白新会话的选择规则同源。源会话只提供文字上下文和工作区，不提供供应商身份。文字快照含用户/助手正文和工具输入输出，不含思考、图片和子代理内部过程。固定读取文件初始长度，末尾未完成行不参与解析，中间损坏行报错；最后一个可解析回合须有助手文字答复。桌面在生成中/等审批时阻止发起。源会话不会被 resume、压缩或改写。

长记录按 32000 个 Unicode 字符分段，逐段合并摘要，最多 10 分钟；任一段失败都不创建新会话。当前原始转录上限为 8 MiB，超限明确报错。生成摘要会产生模型调用费用。摘要结果最多 12000 字符，创建前可编辑。

摘要与不可变文字快照存于 Host 的 `~/.aide/handoffs/`。新会话首条消息携带摘要、来源和快照路径；模型可以使用现有文件读取/搜索工具按需查阅快照，仍走正常权限机制。新会话沿用源工作区；供应商、模型、档位取创建时的新会话配置（预览期间再切换供应商也生效），不恢复旧草稿中的身份。权限恢复为 default，不继承临时审批、附加目录、知识库圈选或运行任务。首轮仅确认交接并等待用户新指示。

Host 命令（均为现有命令表中的 async 命令）：

| 命令 | 参数 | 结果 |
| --- | --- | --- |
| `prepare_session_handoff` | `{sourceId, focus, target}` | 交接草稿（id、sourceId、sourceTitle、summary、focus、wsPath、wsKey、createdAt） |
| `continue_session_handoff` | `{handoffId, summary, target}` | `session_continued` 事件的同形回执 |
| `session_handoff` | `{sessionId}` | 已持久化的交接草稿或 null |

`target = {provider, model, effort}`，由桌面从当前新会话配置快照生成。摘要生成与新会话启动各自快照，源会话即使已关闭或旧供应商已删除也不影响交接。指定的目标供应商被删除时如实报错，不静默回落。

新会话以 `handoff_*` 临时路由启动，等 `session_init` 确认真实 ID 后写元数据；档案 `handoffId` 指向该会话自己的摘要版本，与子会话的 `parentId` 无关。创建成功后经 Host 总线广播 `chat-event`：

```ts
{ type: "session_continued", session_id: string /* 来源会话 */,
  childId: string, title: string, wsPath: string, wsKey: string }
```

各桌面客户端由事件更新名称、工作区缓存及侧栏；命令返回值仅用于发起端打开标签。来源关系可由 `session_handoff` 回种，重启后仍可打开旧会话；删掉旧会话也不会丢失已保存的摘要与快照。已成功消费的草稿重复提交返回相同新会话。

这三个命令暂未加入 Aide Link 手机暴露目录，手机 UI 不在本次实现范围内。未来接入需单独审查远程暴露面。此变更没有新增 Link 帧。
