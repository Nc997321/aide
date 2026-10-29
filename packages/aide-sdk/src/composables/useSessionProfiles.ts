import { reactive } from "vue";
import { api } from "../api";
export type SessionProfile = "assistant" | "chat";
const profiles = reactive<Record<string, SessionProfile>>({});
const loading = new Map<string, Promise<void>>();
/** Host 档案的视图缓存；存活会话以 session_init 广播为准。 */
export function useSessionProfiles() {
  return {
    profiles,
    set(sid: string, profile: SessionProfile) { profiles[sid] = profile; },
    async ensure(sid: string) {
      if (!sid || profiles[sid]) return;
      let pending = loading.get(sid);
      if (!pending) {
        pending = api.sessionProfile(sid).then(profile => {
          profiles[sid] ??= profile;
        }).finally(() => loading.delete(sid));
        loading.set(sid, pending);
      }
      await pending;
    },
    migrate(from: string, to: string) {
      if (profiles[from]) profiles[to] = profiles[from];
      if (from !== to) delete profiles[from];
    },
    clearAll() { for (const sid of Object.keys(profiles)) delete profiles[sid]; },
  };
}
