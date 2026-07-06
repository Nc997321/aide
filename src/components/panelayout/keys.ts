import type { InjectionKey, Ref } from "vue";

/** App.vue 的工作区路径注入给递归组件树（PaneLayout provide → PaneGroup inject）。 */
export const WORKSPACE_PATH_KEY: InjectionKey<Ref<string>> = Symbol("aide:workspacePath");
