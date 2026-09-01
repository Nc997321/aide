import type { Chime, HeroCopy } from "./heroCopy";

/** 欢迎页视图契约：文案 + 环境信息，事件上抛（select-workspace 由组件各自声明）。 */
export interface HeroViewProps {
  readonly chime: Chime;
  readonly copy: HeroCopy;
  /** 当前归属工作区根路径（WorkspacePicker 的勾选高亮依据） */
  readonly workspacePath: string;
  /** 当前选中模型名（无选择时显示「默认模型」） */
  readonly modelName: string;
}
