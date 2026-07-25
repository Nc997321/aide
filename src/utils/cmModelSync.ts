import { Annotation, type Transaction } from "@codemirror/state";

/**
 * 「父层 v-model 同步进编辑器」的事务注解。
 *
 * 背景（假 dirty 根因）：CodeMirror 文档内部一律用 \n 行尾——父层把磁盘原文
 * （Windows CRLF）同步进编辑器时，dispatch 的全文替换会被归一化；若 updateListener
 * 再把归一化后的 doc.toString() 经 v-model 回流，editContent(LF) 就偏离磁盘
 * 基线 content(CRLF)，用户一个字没改也亮 dirty（就地跳转导航首次激活了这条
 * 「同一编辑器实例 + modelValue 外部变化」路径）。
 *
 * 父层同步的 dispatch 一律带此注解；updateListener 用 isUserEdit 判定，程序性
 * 替换不回流——程序性替换文档本来就不是用户编辑。
 */
export const parentSyncAnnotation = Annotation.define<boolean>();

/** 该批事务是否用户真实编辑（无父层同步注解）——true 才允许回流 v-model */
export function isUserEdit(transactions: readonly Transaction[]): boolean {
  return !transactions.some((tr) => tr.annotation(parentSyncAnnotation));
}
