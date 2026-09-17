/**
 * 铜线图标字形库（面板图标系统 · 方案甲「墨线」）。
 *
 * 每个条目是 viewBox 0 0 16 16 的内嵌 SVG 片段（path / circle / rect），由
 * `components/Icon.vue` 包成完整 <svg> 统一渲染。纯数据层，不依赖 Vue。
 *
 * 寓意：不用 emoji 默认，每个字形扣它的语义——
 *   general   滑块      通用设置=调参（不用齿轮）
 *   model     神经网    模型=分层的网络（不用大脑 emoji）
 *   extension 拼图块    扩展互相咬合拼入主程序
 *   market    购物袋    市场=取货
 *   agent     节点图    中心节点派发子节点=agent 派生子任务
 *   skill     闪电      技能=一种能力/招式
 *   instruction 文档    指令=写下的条文
 *   hook      鱼钩      字面即 hook，把回调钩住
 *   mcp       插头      接入外部工具服务=插上即连
 *   task-pending / task-run / task-done   任务三态
 *   bracket   方括号    SubagentCallBlock 节点同形，跨表面呼应子代理来源
 *   close / back / reset / warning / cursor 内联控件
 *
 * 渲染约定：所有 stroke 由 Icon.vue 统一设为铜色 var(--aide-accent)；
 *   .f 子元素填充铜色（实心部件）；.k 子元素填充底色（在铜块上刻反色细节）。
 */
export const GLYPHS: Record<string, string> = {
  // ── 设置导航 ──
  general: '<path d="M2.5 5h11M2.5 11h11"/><circle cx="10" cy="5" r="1.7" class="f"/><circle cx="6" cy="11" r="1.7" class="f"/>',
  model: '<path d="M3.5 8L8 4.5M3.5 8L8 11.5M8 4.5L12.5 8M8 11.5L12.5 8"/><circle cx="3.5" cy="8" r="1.5" class="f"/><circle cx="8" cy="4.5" r="1.5" class="f"/><circle cx="8" cy="11.5" r="1.5" class="f"/><circle cx="12.5" cy="8" r="1.5" class="f"/>',
  extension: '<path d="M2 2H14V6a2 2 0 0 1 0 4V14H2V10a2 2 0 0 1 0 -4Z"/>',
  market: '<path d="M3.5 6h9l-1 8h-7z"/><path d="M5.5 6V4.5a2.5 2.5 0 0 1 5 0V6"/>',
  /** 信息圈：关于页（圆圈内刻 i，与 warning 同族的点线结构） */
  info: '<circle cx="8" cy="8" r="5.5"/><path d="M8 7.4V11.2"/><circle cx="8" cy="5.1" r="0.55" class="f"/>',
  // ── 扩展分类 ──
  agent: '<path d="M8 8L3.8 4.5M8 8L3.8 11.5M8 8L12.5 8"/><circle cx="8" cy="8" r="1.8" class="f"/><circle cx="3.8" cy="4.5" r="1.3" class="f"/><circle cx="3.8" cy="11.5" r="1.3" class="f"/><circle cx="12.5" cy="8" r="1.3" class="f"/>',
  skill: '<path d="M9 2L4 9h3.5L7 14l5-7H8.5Z" class="f"/>',
  instruction: '<path d="M3 2H8.5L12 5.5V14H3Z"/><path d="M8.5 2V5.5H12"/><path d="M5 8H9.5M5 10H9.5M5 12H7.5"/>',
  hook: '<path d="M8 3.5V10a3 3 0 0 1 -3.3 -3.3"/><path d="M4.7 6.7L3 5.2"/><circle cx="8" cy="3" r="1.2"/>',
  mcp: '<path d="M6 3.5H10V8H6Z"/><path d="M6.6 8V12.6M9.4 8V12.6"/>',
  // ── 任务三态 ──
  "task-pending": '<rect x="3" y="3" width="10" height="10" rx="2.5"/>',
  "task-run": '<circle cx="8" cy="8" r="3" class="f"/>',
  "task-done": '<rect x="3" y="3" width="10" height="10" rx="2.5" class="f"/><path d="M5.4 8.2L7 9.8L10.6 5.8" class="k"/>',
  // ── 子代理来源徽章：与 SubagentCallBlock 方括号节点同形 ──
  bracket: '<path d="M6 2H3.5V14H6"/>',
  // ── 内联控件 ──
  close: '<path d="M4 4L12 12M12 4L4 12"/>',
  back: '<path d="M13 8H4M4 8L7 5M4 8L7 11"/>',
  /** 循环箭头：观测台「刷新」按钮。半弧 + 端点 V 形箭头，双向组成回环观感 */
  refresh:
    '<path d="M3.5 8a4.5 4.5 0 0 1 8.8 -1.4"/>' +
    '<path d="M10.7 4.7l1.6 2 -2.1 .9"/>' +
    '<path d="M12.5 8a4.5 4.5 0 0 1 -8.8 1.4"/>' +
    '<path d="M5.3 11.3l-1.6 -2 2.1 -.9"/>',
  /** 向下箭头：回到底部 */
  "arrow-down": '<path d="M8 3v10M8 13l-4.5-4.5M8 13l4.5-4.5"/>',
  reset: '<path d="M4 8A4 4 0 1 1 4 4"/><path d="M2.6 5.4L4 4L5.4 5.4"/>',
  warning: '<path d="M8 2.5L14 13H2Z"/><path d="M8 6.2V9.6"/><circle cx="8" cy="11.4" r="0.55" class="f"/>',
  cursor: '<path d="M3.5 3L3.5 12.5L6 10L8 14L9.4 13.5L7.4 9.5L11 9.5Z" class="f"/>',
  // ── provider 字形选择器（供应商"头像"用）──
  /** 芯片：模型供应商=后端，IC 芯片 + 四脚（默认） */
  provider: '<path d="M5 5h6v6h-6z"/><path d="M8 5V3M8 11v2M5 8H3M11 8h2"/>',
  /** 立方体：一个打包好的模型 */
  cube: '<path d="M8 3L12.5 5.5L8 8L3.5 5.5Z"/><path d="M3.5 5.5V10.5M12.5 5.5V10.5M8 8V13M3.5 10.5L8 13L12.5 10.5"/>',
  /** 地球：网络/API 端点 */
  globe: '<circle cx="8" cy="8" r="5"/><path d="M8 3a2.5 5 0 0 0 0 10a2.5 5 0 0 0 0-10Z"/><path d="M3.2 8h9.6"/>',
  /** 钥匙：API key / 接入凭证 */
  key: '<circle cx="4.5" cy="8" r="2.3"/><path d="M6.8 8H13"/><path d="M10 8v2M12.5 8v2"/>',
  /** 服务器：堆叠的服务器单元 + 指示灯 */
  server: '<rect x="3" y="3.5" width="10" height="3.5" rx="1"/><rect x="3" y="9" width="10" height="3.5" rx="1"/><circle cx="11" cy="5.25" r="0.7" class="f"/><circle cx="11" cy="10.75" r="0.7" class="f"/>',
  /** 火花：AI 能力（区别于技能的闪电） */
  spark: '<path d="M8 2L9 6.8L14 8L9 9.2L8 14L7 9.2L2 8L7 6.8Z" class="f"/>',
  /** 头脑：记忆观测台（左右两半球 + 四条脑沟）。24 网格的 lucide brain 等比缩到 16 网格 */
  brain:
    '<path d="M8 3.3a2 2 0 1 0-4 .1 2.7 2.7 0 0 0-1.68 3.85 2.7 2.7 0 0 0 .37 4.39A2.7 2.7 0 1 0 8 12Z"/>' +
    '<path d="M8 3.3a2 2 0 1 1 4 .1 2.7 2.7 0 0 1 1.68 3.85 2.7 2.7 0 0 1-.37 4.39A2.7 2.7 0 1 1 8 12Z"/>' +
    '<path d="M10 8.7a3 3 0 0 0-.94 1.85"/><path d="M6 8.7a3 3 0 0 1-.94 1.85"/>' +
    '<path d="M12 6.1a3 3 0 0 1 0 3.83"/><path d="M4 6.1a3 3 0 0 0 0 3.83"/>',
  // ── 搜索结果类型 ──
  /** 会话：聊天气泡 */
  session: '<path d="M3.5 3.5h9a1 1 0 0 1 1 1v5a1 1 0 0 1 -1 1H6l-2 2v-2H3.5a1 1 0 0 1 -1-1V4.5a1 1 0 0 1 1-1z"/>',
  /** 文件：带折角的页面 */
  file: '<path d="M4 2.5h5l3 3v8h-8z"/><path d="M9 2.5v3h3"/>',
  /** 收藏夹目录：文件夹（带页签的直角轮廓，与 file / link 同族） */
  folder: '<path d="M2.5 12.5V4.3h4l1.3 1.7h5.7v6.5z"/>',
  /** 链接：跳转到定义（精确结构匹配） */
  link: '<rect x="2.5" y="5" width="7" height="4.5" rx="2.25"/><rect x="6.5" y="6.5" width="7" height="4.5" rx="2.25"/>',
  /** 搜索：放大镜（语义匹配） */
  search: '<circle cx="6.5" cy="6.5" r="3.8"/><path d="M9.2 9.2L13 13"/>',
  // ── marketplace 空态 ──
  /** 包裹：marketplace 空态（无可用插件） */
  package: '<path d="M8 2.5L13 5v6L8 13.5L3 11V5z"/><path d="M3 5l5 2.5 5-2.5M8 7.5v6"/>',
  /** 咖啡杯：JDK / Java（双关——Java 即咖啡） */
  java: '<path d="M4.5 6H11l-0.5 7a1 1 0 0 1-1 0.9H6a1 1 0 0 1-1-0.9Z"/><path d="M11 7.5h1.3a1.4 1.4 0 0 1 0 2.8H11"/><path d="M6.4 4.2c-.5-.5-.5-1.2 0-1.9M8.4 4.2c-.5-.5-.5-1.2 0-1.9"/>',
};

/** provider 图标选择器可选的字形（供应商"头像"候选集） */
export const PROVIDER_GLYPHS = ["provider", "cube", "globe", "key", "server", "spark"] as const;

/** 字形是否存在（未知 name 渲染为空，不报错——便于扩展分类等数据驱动的 key 容错） */
export function hasGlyph(name: string): boolean {
  return name in GLYPHS;
}