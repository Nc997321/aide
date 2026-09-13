// 写目标空间决策（纯函数，零依赖、零 IO）。
//
// 为什么单独一个文件：知识库是共享资源，写错空间别人能看到。这条判定是唯一的
// 「敢不敢替用户拿主意」的地方，必须能被单测钉死（设计 spec §4.2）。

export interface KbSpaceBrief {
  id: string;
  name: string;
}

export type SpaceDecision = { kind: "ok"; id: string } | { kind: "ask"; text: string };

/**
 * 目标空间解析：
 * - 显式传入（非空串）→ 直接用（存在性与权限交给服务端判 403/404）。
 * - 省略 → 可见空间**唯一**才自动选；0 个 / 多个都返回让模型问用户的文本。
 */
export function decideSpace(requested: string | undefined, spaces: KbSpaceBrief[]): SpaceDecision {
  if (requested) return { kind: "ok", id: requested };

  const [only] = spaces;
  if (spaces.length === 1 && only) return { kind: "ok", id: only.id };

  if (spaces.length === 0) {
    return {
      kind: "ask",
      text:
        "No spaceId was given, and the signed-in user can see no knowledge base spaces. " +
        "Ask the user to check their space membership in the 知识库 panel.",
    };
  }

  const list = spaces.map((s) => `- ${s.name} — id ${s.id}`).join("\n");
  return {
    kind: "ask",
    text:
      `No spaceId was given, and ${spaces.length} spaces are visible:\n${list}\n` +
      "Ask the user which space to write to, then call this tool again with that spaceId.",
  };
}
