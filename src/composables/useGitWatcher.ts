import { ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useGit } from "./useGit";
import { useWindowFocus } from "./useWindowFocus";

const POLL_INTERVAL = 3000;

let started = false;
let timer: ReturnType<typeof setInterval> | null = null;
const lastFingerprint = ref("");

export function useGitWatcher() {
  if (started) return;
  started = true;

  const { loadAll, loadStatus, loadBranches, loadUnpushed } = useGit();
  const { isFocused } = useWindowFocus();

  async function checkFingerprint() {
    try {
      const fp = await invoke<string>("git_fingerprint");
      if (lastFingerprint.value && fp !== lastFingerprint.value) {
        await loadAll();
      }
      lastFingerprint.value = fp;
    } catch (_) {}
  }

  watch(isFocused, async (focused, wasFocused) => {
    if (focused && wasFocused === false) {
      await checkFingerprint();
    }
  });

  timer = setInterval(checkFingerprint, POLL_INTERVAL);

  checkFingerprint();
}
