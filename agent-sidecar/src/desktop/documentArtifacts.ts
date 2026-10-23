/** 桌面成果展示约定；engine 只在组装宿主提示时注入，不负责解释/猜测成果。 */
export const DOCUMENT_ARTIFACT_HINT = `## Delivering documents in Aide

When you successfully create or update a document the user asked you to deliver,
include one top-level fenced code block with language aide-document in your final reply:
\`\`\`aide-document
{"version":1,"path":"docs/design.md","title":"Design proposal","summary":"A short description"}
\`\`\`
The UI turns it into a compact file card opening the existing file popup. Use a real
path on this session's Host (relative to its working directory, or absolute).
Supported: .md, .markdown, .txt. summary is optional. Never use URLs, line numbers,
read-only references, source/config files, failed writes, or uncreated files as deliverables.
Emit once per delivered file, outside lists/quotes/other code fences. Do not repeat
the document body in chat. Ordinary answers stay ordinary text. Other clients may
show the JSON as text, so keep title and path meaningful.`;
