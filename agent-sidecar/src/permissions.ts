import { randomUUID } from "node:crypto";
import type { ChatEvent } from "./types.js";

export class PermissionManager {
  private pending = new Map<string, (approved: boolean) => void>();

  makeCallback(emit: (e: ChatEvent) => void) {
    return async (
      toolName: string,
      input: unknown,
      opts?: { signal?: AbortSignal },
    ) => {
      const id = randomUUID();
      emit({ type: "permission_request", id, name: toolName, input });
      const approved = await new Promise<boolean>((resolve) => {
        this.pending.set(id, resolve);
        // 中断（interrupt）会 abort signal：视为拒绝并通知前端关掉对话框
        opts?.signal?.addEventListener(
          "abort",
          () => {
            if (this.pending.delete(id)) {
              emit({ type: "permission_cancelled", id });
              resolve(false);
            }
          },
          { once: true },
        );
      });
      return approved
        ? { behavior: "allow" as const, updatedInput: input as Record<string, unknown> }
        : { behavior: "deny" as const, message: "用户拒绝" };
    };
  }

  resolve(id: string, approved: boolean) {
    const resolve = this.pending.get(id);
    if (resolve) {
      this.pending.delete(id);
      resolve(approved);
    }
  }
}
