export type MessageRole = "user" | "assistant";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolCallBlock {
  type: "tool_call";
  id: string;
  name: string;
  input: unknown;
  result?: string;
  isError?: boolean;
  isPending: boolean;
}

export interface ImageBlock {
  type: "image";
  data: string;      // base64
  mediaType: string; // "image/png" | ...
}

export type ContentBlock = TextBlock | ToolCallBlock | ImageBlock;

export interface ChatMessage {
  id: string;
  role: MessageRole;
  blocks: ContentBlock[];
  timestamp: number;
}

export interface PermissionRequest {
  id: string;
  name: string;
  input: unknown;
}
