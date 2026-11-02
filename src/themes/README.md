# 控件状态样式

主题是颜色和效果的唯一来源；控件在自己的状态规则中引用以下 token，不追加页面级覆盖。

- 输入框 `:focus` / 输入容器 `:focus-within`：`--aide-focus-border`；不叠加彩色外圈或光晕，可保留原有内阴影。
- 普通标签、导航、树节点、下拉选项选中：`--aide-control-selected-bg` / `--aide-control-selected-text` / `--aide-control-selected-border`。
- 键盘 `:focus-visible`：`--aide-focus-ring`（硬边中性环），或中性色 outline；鼠标选中与键盘焦点分开表达。全局规则为按钮、链接等提供低优先级的 outline 兜底。
- 品牌主操作可使用 `accentGradient`，容器层次使用普通阴影，不添加彩色光晕。输入框运行时保留贴合边框的流光，但不添加外扩光晕；运行、错误、警告、权限和业务标记按语义使用图标、文字与状态色。
- 新主题必须提供完整的状态 token。首次渲染的 CSS 兜底与 warm-dark 保持一致。
