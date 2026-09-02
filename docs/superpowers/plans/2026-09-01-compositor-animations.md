# 计划：装饰性动画合成器化 + check:animations 守卫（2026-09-01）

> 新会话执行入口。前置背景与本计划由 2026-09-01「切回长会话卡顿」排查会话产出。

## 背景（为什么做）

2026-09-01 排查「切回运行中的长会话 tab 流光掉帧」定案了两条流式 O(n²) 并已修复
（`fa94c68` 思考块流式窗口化、`d86458a` Bash 输出增量写入；证据链 =
`~/.aide/diagnostics/freeze-1788224842632*.json` 长任务环链 + 滚动诊断环冻结期零事件）。
主线程长任务消灭后，残余的观感破绽是**两个长驻主线程的装饰动画**：主线程一旦有任何
负载它们就掉帧。目标是把它们迁到合成器线程（transform/opacity 与主线程解耦），
并加一道构建期守卫杜绝新的主线程动画混入。

**准则**：能每帧不问主线程的只有 `transform` / `opacity`（`filter` 动画按禁手对待，
blur 等自身昂贵且兼容面不稳）；功能性布局动画（如侧栏列表收拢 max-height）不改。

## 任务 A：输入框彗星环（ChatInputBox.vue:1158-1198）

现状：`@property --aide-input-comet` 角度动画驱动 conic-gradient 旋转 + 2 层 mask
exclude 挖 1px 圆环 + drop-shadow——每帧主线程重算样式 + 重画。

改造：静态渐变纹理 + `transform: rotate` 旋转。
- 模板加独立 wrapper（`position:absolute; inset:0; pointer-events:none; z-index 低于内容`），
  **mask 挖环挂 wrapper（静态）、渐变纹理层是 wrapper 的子伪元素旋转**——mask 不随之旋转；
- 旋转纹理必须是**方块**（对角线 ≥ 矩形对角线）才能在任意旋转角盖住矩形环；用
  `aspect-ratio: 1` + 百分比定位（% 基准见 mask 注释体系）；
- drop-shadow 滤镜留在 wrapper（mask 之后），静态 filter 可合成；
- **WebView2 红线（同文件注释已记）：mask 层数 ≤2，多值组合整条失效**；
- 颜色全部走主题 token；玻璃主题下环内一笔不画（glass 半透明背景安全）。

## 任务 B：「正在思考」文字扫光（ChatPanel.vue:800-835）

现状：`.chat-thinking-text` 五段渐变 + `background-clip: text` + `background-position`
100%→0（主线程每帧重排版重画）。

改造：文字本体恢复素色（--aide-text-muted），渐变光带改为伪元素图层（同渐变、同
2.5s、同循环形状）横向 `translateX` 扫过，用文字形状做 mask（或保留 background-clip
在伪元素上）。`prefers-reduced-motion` 分支等价保留。

## 任务 C：`scripts/check-animations.mjs`（构建期拦截器）

形态对齐既有 `scripts/check-tauri-imports.mjs`：扫描 `src/**/*.{vue,css}` 的 style
块，提取 `transition:`/`animation:`/`@keyframes` 涉及的属性，**白名单
{transform, opacity}**，命中 background-position / width / height / margin / padding /
top / left / color / box-shadow 等即报错；`package.json` 加 `check:animations` 并挂进
构建前置。豁免清单显式落文件头注释（首豁免：侧栏 session-anim 列表收拢——有意布局动画，
2026-09-01 评审结论）。

## 验收

1. 四套主题逐个目检：glass / warm-dark / catppuccin / smoky-pink-glass × 运行态
   （彗星环形状/光晕/玻璃底、扫光速度光带）与改前并排一致（先做改前截图/录屏基线）；
2. devtools Performance 录制：两动画期间 main thread 无逐帧任务（动画帧由合成器出）；
3. `check:animations` 通过；`vue-tsc` + 全量 vitest 通过；
4. WebView2 mask 怪癖回归项：彗星环完整、无光楔糊面（mask 退化症状见 ChatInputBox 注释）。

## 相关记忆与证据

- `~/.aide/diagnostics/freeze-1788224842632*.json`（长任务环链现场）
- 记忆：[[compositor-animations-conversion]]（任务指针）、[[perf-freeze-attribution]]（诊断方法）