import type { Chime, HeroCopy } from "./heroCopy";
import type { ChatMode } from "../modes";

/** 欢迎页视图契约：文案 + 环境信息，事件上抛（select-workspace 由组件各自声明）。 */
export interface HeroViewProps {
  readonly chime: Chime;
  readonly copy: HeroCopy;
  /** 日常 / 工程：分叉文案、归属行、placeholder（placeholder 在输入盒侧） */
  readonly mode: ChatMode;
  /** 当前归属工作区根路径（WorkspacePicker 的勾选高亮依据；日常不显示它） */
  readonly workspacePath: string;
  /** 当前选中模型名（无选择时显示「默认模型」） */
  readonly modelName: string;
  /** 「接着上次」：最近一场日常对话（标题 + 多久前）；没有就不显示那一行 */
  readonly resume: HeroResume | null;
}

export interface HeroResume {
  readonly sessionId: string;
  readonly title: string;
  readonly ago: string;
}
