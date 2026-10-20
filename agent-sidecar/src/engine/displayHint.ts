// 告诉模型：Aide 的聊天界面能显示图片。
//
// Claude Code 跑在终端里，模型习惯了「出图 = 报一个路径」。Aide 渲染 markdown，
// `![说明](路径)` 里的本地路径会经 Host 读出来直接显示在对话里（桌面见
// src/utils/localImages.ts）——但模型不知道就不会这么写。
//
// 每一轮请求都会重发，保持短（displayHint.test.ts 有长度闸）。

export const CHAT_DISPLAY_HINT = `## Showing images to the user

This chat UI renders Markdown images inline, including local files. When you create or find
an image the user should see (a chart, a screenshot, a generated picture), embed it with
\`![short description](/absolute/path/to/image.png)\` instead of only naming the path.
Use one image per line. Only do this for images the user wants to look at.`;
