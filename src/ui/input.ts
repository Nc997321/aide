/** AInput 暴露的原生操作边界；业务组件不依赖内部模板结构。 */
export interface AInputHandle {
  element: HTMLInputElement | null;
  focus(options?: FocusOptions): void;
  blur(): void;
  select(): void;
}
