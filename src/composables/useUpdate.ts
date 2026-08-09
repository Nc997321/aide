import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { isMac, isWindows } from "../utils/platform";

// ── Module-level state ──

const updateAvailable = ref(false);
const latestVersion = ref("");
const downloadUrl = ref("");
const checking = ref(false);
const checked = ref(false);

// ── Types ──

interface GiteeRelease {
    tag_name: string;
    name: string;
    html_url: string;
    assets: Array<{ name: string; browser_download_url: string }>;
}

// ── Helpers ──

function parseSemver(v: string): number[] {
    return v.replace(/^v/, "").split(".").map(Number);
}

function isNewer(latest: string, current: string): boolean {
    const a = parseSemver(latest);
    const b = parseSemver(current);
    for (let i = 0; i < 3; i++) {
        if ((a[i] || 0) > (b[i] || 0)) return true;
        if ((a[i] || 0) < (b[i] || 0)) return false;
    }
    return false;
}

function parseRepoFromRemote(remoteUrl: string): string | null {
    const m = remoteUrl.match(/gitee\.com[/:]([^/]+)\/([^/\s.]+?)(?:\.git)?$/);
    return m ? `${m[1]}/${m[2]}` : null;
}

// ── Actions ──

async function checkUpdate(currentVersion: string): Promise<void> {
    if (checking.value) return;
    checking.value = true;

    try {
        const remoteUrl = await invoke<string | null>("git_remote_url");
        if (!remoteUrl) {
            checked.value = true;
            return;
        }

        const repo = parseRepoFromRemote(remoteUrl);
        if (!repo) {
            checked.value = true;
            return;
        }

        const res = await fetch(
            `https://gitee.com/api/v5/repos/${repo}/releases/latest`,
        );
        if (!res.ok) {
            checked.value = true;
            return; // No releases or private repo
        }

        const release: GiteeRelease = await res.json();

        if (isNewer(release.tag_name, currentVersion)) {
            latestVersion.value = release.tag_name;
            const asset = release.assets.find((a) => {
                if (isMac()) return a.name.endsWith(".dmg") || a.name.endsWith(".pkg");
                if (isWindows()) return a.name.endsWith(".exe") || a.name.endsWith(".msi");
                return false;
            });
            downloadUrl.value = asset?.browser_download_url ?? release.html_url;
            updateAvailable.value = true;
        }
    } catch {
        // Network error — silently ignore
    } finally {
        checking.value = false;
        checked.value = true;
    }
}

function dismissUpdate() {
    updateAvailable.value = false;
}

// ── Export ──

export function useUpdate() {
    return {
        updateAvailable,
        latestVersion,
        downloadUrl,
        checking,
        checked,
        checkUpdate,
        dismissUpdate,
    };
}
