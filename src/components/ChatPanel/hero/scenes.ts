/**
 * 新会话欢迎页的「场景」——点一下把这次对话定到某类产出上。
 *
 * 场景不是装饰（对照 modes.ts 里对假控件的告诫）：选中后**发送时把 `brief` 拼在用户输入
 * 前面发给模型**，让它一上来就走 Aide 里对应的那条能力（文档工具 / aide-app 技能 / 单文件
 * 网页），而不是先反问或自己摸索。用户气泡里只显示一枚场景标签，不显示 brief。
 *
 * 只收 Aide **真有落地能力**的场景；每条 brief 里点名的工具 / 技能必须是内置的。
 * 没有的能力（如生成 .pptx / .xlsx）不许包装成场景。
 */
export interface SceneExample {
  /** 示例条上的短标题 */
  label: string;
  /** 点一下填进输入框的提示词（用户可以接着改） */
  prompt: string;
}

export interface Scene {
  id: string;
  label: string;
  /** 字符图标：与动作胶囊同一通道（display 的 action 块只带字符） */
  icon: string;
  /** 选中后输入框的占位文案 */
  placeholder: string;
  /** 发给模型的场景指引，拼在用户输入前 */
  brief: string;
  examples: SceneExample[];
}

export const SCENES: readonly Scene[] = [
  {
    id: "docs",
    label: "文档处理",
    icon: "▤",
    placeholder: "要处理哪份文档？@ 一下文件，或直接说要写什么",
    brief:
      "这次对话是文档处理。读 .docx 用 mcp__aide-docs__read_docx，读 .pdf 用 mcp__aide-docs__read_pdf，" +
      "产出 Word 文档用 mcp__aide-docs__write_docx（内容用 Markdown 写）。" +
      "产出物存成文件并告诉我路径，不要只把全文贴在对话里；Aide 不能生成 .pdf / .xlsx / .pptx，需要时如实说明并给替代方案。",
    examples: [
      { label: "Markdown 转 Word", prompt: "把这份 Markdown 转成排版好的 Word 文档，带目录：@" },
      { label: "总结 PDF", prompt: "读一下这份 PDF，按章节给我一份要点总结：@" },
      { label: "周报转 Word", prompt: "把下面这些零散的工作记录整理成一份项目周报，存成 Word 文档：\n" },
      { label: "两份文档对比", prompt: "对比这两份文档，列出内容上的差异和各自独有的部分：@" },
    ],
  },
  {
    id: "workbench",
    label: "个人工作台",
    icon: "▦",
    placeholder: "想要一个什么样的工作台？说说你每天要看、要记的东西",
    brief:
      "这次对话是给我做一个个人工作台：一个常驻在 Aide 侧栏里的面板，把我每天要看、要记的东西放在一处，数据要能保存。" +
      "按 aide-app 技能的做法实现成 Aide 侧栏应用。信息不够就先问我一两个关键问题再动手；做完告诉我去哪里启用它。",
    examples: [
      { label: "打工人小账本", prompt: "做一个记账工作台：快速记一笔收支、按月看分类汇总和结余。" },
      { label: "学习目标管理台", prompt: "做一个学习目标工作台：列目标、拆成每周任务、打卡并显示完成进度。" },
      { label: "生活工作台", prompt: "做一个生活工作台：今日待办、习惯打卡、购物清单放在同一页。" },
      { label: "运动打卡", prompt: "做一个运动打卡工作台：记录每次运动的类型和时长，按周显示统计。" },
    ],
  },
  {
    id: "slides",
    label: "幻灯片",
    icon: "▭",
    placeholder: "讲什么主题？给谁看？大概几页？",
    brief:
      "这次对话是做一份幻灯片。产出一个**单文件 HTML** 演示稿（样式和脚本全部内联，不依赖外网资源）：" +
      "一屏一页，方向键 / 空格翻页，显示页码，16:9。先给我大纲确认，再写文件；" +
      "存到当前工作目录并告诉我路径。Aide 不能生成 .pptx，不要假装能。",
    examples: [
      { label: "项目汇报", prompt: "做一份 8 页左右的项目阶段汇报幻灯片，主题是：" },
      { label: "技术分享", prompt: "做一份技术分享幻灯片，面向团队内部，主题是：" },
      { label: "从文档生成", prompt: "根据这份文档的内容做一份幻灯片，每页只放要点：@" },
      { label: "产品介绍", prompt: "做一份产品介绍幻灯片，突出三个核心卖点，产品是：" },
    ],
  },
  {
    id: "app",
    label: "应用",
    icon: "◫",
    placeholder: "想在 Aide 里加个什么工具？",
    brief:
      "这次对话是在 Aide 里做一个小应用（工具、面板或小游戏）。按 aide-app 技能的做法实现成 Aide 侧栏应用；" +
      "先把最小可用的版本做出来，做完告诉我去哪里启用它、之后怎么改。",
    examples: [
      { label: "接口调试工具", prompt: "做一个接口调试工具：填 URL、方法、请求头和请求体，发请求并显示格式化后的响应。" },
      { label: "番茄钟", prompt: "做一个番茄钟：25 分钟专注 / 5 分钟休息，记录今天完成了几个。" },
      { label: "JSON 工具", prompt: "做一个 JSON 小工具：格式化、压缩、校验，出错时指出位置。" },
      { label: "小游戏", prompt: "做一个 2048 小游戏，放在右栏，记录最高分。" },
    ],
  },
];

/** 发给模型的文本：场景指引在前，用户输入在后。用户什么都没写时只发指引（等于「按这个场景开始」）。 */
export function composeScenePrompt(scene: Scene, userText: string): string {
  const text = userText.trim();
  return text ? `${scene.brief}\n\n---\n\n${text}` : scene.brief;
}
