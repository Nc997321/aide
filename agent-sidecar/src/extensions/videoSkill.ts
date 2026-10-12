import { builtinSkillPath, ensureBuiltinSkill, type SkillEnv } from "./builtinSkill.js";

/**
 * aide-video skill 自动落地（内建，免用户配置）：教 agent 用 Remotion 在用户工作区里做视频。
 *
 * Aide 本体**不打包** Remotion——依赖、浏览器内核都由 agent 在用户的工作区里现装。本 skill 只
 * 负责让它知道：先查环境、工程怎么搭、画面怎么写（一切由帧号推导）、怎么截帧自查、怎么出片，
 * 以及哪些事做不了要如实说。做法来自 Aide 自己那支介绍片的工程。
 */

const SKILL_NAME = "aide-video";

export function videoSkillPath(env: SkillEnv): string {
  return builtinSkillPath(env, SKILL_NAME);
}

export const VIDEO_SKILL_CONTENT = `---
name: aide-video
description: Use when the user asks to make, produce or edit a video — explainer, promo, motion graphics, animated chart, or a subtitled cut of screen recordings (e.g. "做一个产品介绍视频", "把录屏剪成带字幕的演示").
---

# 用 Remotion 做视频

Remotion = 用 React 写画面，再逐帧渲染成 mp4。它做的是**动效、解说片、数据动画、带字幕的素材剪辑**。

先把能做和不能做的说清楚，别让用户误会：

- 不能凭一句话生成实拍画面或人物（那是视频生成模型的事）。画面只能来自你写的图形和文字、用户给的图片 / 录屏 / 音频。
- 没有配音。要旁白就请用户提供音频文件；配乐同理。
- Remotion 不是通常意义的开源：个人和很小的团队免费，较大的公司商用要买授权。第一次用时提醒用户一句，条款以 remotion.dev 当前说明为准。

## 第一步：查环境（缺了就停）

\`\`\`bash
node -v   # 需要 18 或更高
npm -v
\`\`\`

任一条失败：**不要想办法绕过**，告诉用户先装 Node.js LTS（nodejs.org），装好再继续。

同时提前告诉用户：第一次要下载依赖和一个渲染用的浏览器内核（几百 MB，一次性），渲染比实时慢，几十秒的片子可能要几分钟。

## 第二步：先定稿，再动手

动手前给用户一份分镜表并等他确认：每个镜头的内容、时长、字幕文案，以及画幅（默认 1920×1080、30fps）和总时长。
确认后再写代码——渲染慢，返工很贵。

## 工程放哪、长什么样

放在**当前工作区**下一个新文件夹里（名字取片子的名字，如 \`intro-video/\`），不要写到用户家目录或 Aide 的配置目录。

\`\`\`bash
mkdir intro-video && cd intro-video
npm init -y
npm install remotion @remotion/cli react react-dom
npm install -D typescript @types/react
\`\`\`

\`\`\`
intro-video/
  package.json
  remotion.config.ts
  tsconfig.json          # "jsx": "react-jsx", "strict": true, "skipLibCheck": true
  public/                # 素材：图片、录屏、音频。只有这里的文件能被片子引用
  src/
    index.ts             # registerRoot(Root)
    Root.tsx             # <Composition>：id、尺寸、帧率、总帧数
    timeline.ts          # 镜头、时长、字幕——全片的唯一数据源
    scenes/              # 每个镜头一个组件
  out/                   # 成片与截帧
\`\`\`

\`\`\`ts
// src/index.ts
import { registerRoot } from "remotion";
import { Root } from "./Root";
registerRoot(Root);
\`\`\`

\`\`\`tsx
// src/Root.tsx
import { Composition } from "remotion";
import { Main } from "./Main";
import { FPS, TOTAL_SECONDS } from "./timeline";

export const Root: React.FC = () => (
  <Composition id="Main" component={Main} width={1920} height={1080}
    fps={FPS} durationInFrames={Math.round(TOTAL_SECONDS * FPS)} />
);
\`\`\`

\`\`\`ts
// remotion.config.ts
import { Config } from "@remotion/cli/config";
Config.setOverwriteOutput(true);
Config.setVideoImageFormat("png"); // 画面里有小字 / 录屏时用，中间帧不再糊一次
\`\`\`

**把镜头、时长、字幕都写进 \`timeline.ts\` 一个文件**，组件只读它。用户说「第二段短一点」「这句字幕改一下」时只改这一处，
总时长由它算出来，不要在组件里散落帧数。

## 写画面：一切由帧号推导

Remotion 逐帧截图，每一帧都是独立渲染的。所以：

- 动画只能由 \`useCurrentFrame()\` 算出来，配 \`interpolate\`（记得 \`extrapolateLeft/Right: "clamp"\`）和 \`spring\`。
- **不要用** CSS \`transition\` / \`animation\`、\`setTimeout\`、\`requestAnimationFrame\`、\`Date.now()\`、\`Math.random()\`
  ——预览里看着在动，渲染出来是错的或每帧不一样。要随机数用 \`random(seed)\`。
- 用 \`<Sequence from={帧} durationInFrames={帧}>\` 排镜头；\`Sequence\` 里面的 \`useCurrentFrame()\` 从 0 重新计。
- 铺满画面用 \`<AbsoluteFill>\`。

\`\`\`tsx
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export const Title: React.FC<{ text: string }> = ({ text }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const rise = spring({ frame, fps, config: { damping: 200 } });
  const opacity = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", background: "#0b0d12" }}>
      <h1 style={{ color: "#fff", fontSize: 96, opacity, transform: \`translateY(\${(1 - rise) * 40}px)\` }}>{text}</h1>
    </AbsoluteFill>
  );
};
\`\`\`

## 素材

- 把用户给的文件**复制**进 \`public/\`（不要建链接），用 \`staticFile("名字.mp4")\` 引用。路径一律正斜杠。
- 图片用 \`<Img>\`，录屏 / 视频用 \`<OffthreadVideo>\`（\`startFrom\` / \`endAt\` 按帧裁剪），音频用 \`<Audio>\`。
  不要用原生 \`<img>\` / \`<video>\`——渲染不会等它们加载完。
- 不要引用外网的图片、字体、脚本：渲染时可能没网或加载超时。中文字体用系统自带的，\`fontFamily\` 里写上回退
  （如 \`"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif\`）。
- 接入一段录屏前先自己看一遍它的内容和时长，再决定剪哪一段，不要凭文件名猜。

## 自查：截帧看，不要凭感觉

每写完一个镜头，截几帧（开头、动画中段、结尾）自己看：

\`\`\`bash
npx remotion still Main out/check-090.png --frame=90
\`\`\`

然后用 Read 打开这张 PNG。重点看：文字有没有溢出或被遮住、字幕有没有压在关键内容上、中文有没有变成方块。
**没截帧看过就不要说「做好了」。**

想让用户边做边看：在后台启动预览（它会一直运行，别在前台等它退出），

\`\`\`bash
npx remotion studio
\`\`\`

把它打印的本地地址（默认 http://localhost:3000）告诉用户，可以在 Aide 的内嵌浏览器里打开拖时间轴。做完记得把它停掉。

## 出片

先出一版小而快的草稿给用户看，确认后再出正式版：

\`\`\`bash
npx remotion render Main out/draft.mp4 --crf=28 --x264-preset=veryfast   # 草稿
npx remotion render Main out/final.mp4                                    # 正式
npx remotion render Main out/part.mp4 --frames=0-149                      # 只渲染一段
\`\`\`

要 4K 加 \`--scale=2\`（工程仍按 1920×1080 写）。渲染是耗时命令，耐心等它跑完，不要中途判定失败。

做完告诉用户：成片的完整路径、时长和分辨率，以及之后想改哪里可以直接说（改 \`timeline.ts\` 后重新渲染）。

## 常见错误

- 预览里动画正常、成片里不动或闪 → 用了 CSS 动画 / 定时器，改成由帧号推导。
- 成片比预期短 / 被截断 → \`durationInFrames\` 没跟着 \`timeline.ts\` 更新。
- 画面里素材是空的 → 文件不在 \`public/\`，或没用 \`staticFile()\`。
- 渲染卡在下载或超时 → 引用了外网资源；首次下载浏览器内核失败时，把原始报错告诉用户（多半是网络），不要反复重试。
- 改了镜头时长但配乐 / 旁白没对上 → 音频时长是固定的，告诉用户而不是悄悄截断。
`;

/** 幂等落地，失败静默（见 builtinSkill.ts）。 */
export function ensureVideoSkill(env: SkillEnv): void {
  ensureBuiltinSkill(env, SKILL_NAME, VIDEO_SKILL_CONTENT);
}
