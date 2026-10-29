/** 模式是能力配置；日常与纯聊天仍归属 Host 的日常工作区。 */
export const CHAT_MODES: string[] = ['chat', 'daily', 'project'];
export function chatModeLabel(mode: string): string {
  if (mode === 'chat') return '纯聊天';
  return mode === 'project' ? '工程' : '日常';
}
export function chatModeHeadline(mode: string): string {
  if (mode === 'chat') return '留一点空间，\n聊点什么。';
  return mode === 'project' ? '下一步，\n想推进什么？' : '今天有什么，\n想一起处理？';
}
export function chatModeDescription(mode: string): string {
  if (mode === 'chat') return '问答、写作，或把一个想法聊清楚。\n支持图片和文档，不调用工具。';
  return mode === 'project' ? '进入项目，读代码、排查问题、实现想法。' : '查资料、整理文档，处理手边的小事。\n需要时可以使用工具。';
}
export function chatModeSuggestions(mode: string): string[] {
  if (mode === 'chat') return ['帮我把这段话说得更自然', '一起想清楚一个问题'];
  return mode === 'project' ? ['先了解这个项目的结构', '帮我排查一个问题'] : ['整理一份本周待办', '帮我了解一个新话题'];
}
