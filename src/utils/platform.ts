/**
 * Windows platform detection for xterm.js ConPTY integration.
 *
 * xterm.js needs `windowsPty` set correctly when running on Windows with
 * ConPTY (the native PTY backend used by portable_pty). Without it, xterm.js
 * uses a fallback heuristic ("lines are assumed wrapped if the last char is
 * not whitespace") that interacts poorly with tab characters, causing
 * wrapping misalignment — especially when lines have leading tabs.
 *
 * On Windows 11 build >= 21376, ConPTY outputs native text wrapping
 * sequences and xterm.js can enable reflow. We detect the build number via
 * the async `navigator.userAgentData` API (Chromium/WebView2).
 *
 * Call `initPlatform()` once at app startup, then use `windowsPtyConfig()`
 * when constructing xterm Terminal instances.
 */

let _windowsBuildNumber: number | undefined;
let _initialized = false;

/** Call once at app startup to detect Windows platform details. */
export async function initPlatform(): Promise<void> {
  if (_initialized) return;
  _initialized = true;

  if (!isWindows()) return;

  try {
    // Modern Chromium API — available in WebView2
    const ua = navigator as unknown as Record<string, unknown>;
    if (typeof (ua.userAgentData as any)?.getHighEntropyValues === "function") {
      const values = await (ua.userAgentData as any).getHighEntropyValues([
        "platformVersion",
      ]);
      const pv: string | undefined = values?.platformVersion;
      if (pv) {
        // platformVersion is like "10.0.26200.0"
        const m = pv.match(/^\d+\.\d+\.(\d+)/);
        if (m) {
          _windowsBuildNumber = parseInt(m[1], 10);
          return;
        }
      }
    }
  } catch {
    // Fall through — build number stays undefined.
    // Without it, reflow remains disabled but the scrollback fix from
    // `backend: 'conpty'` still applies. This is safe: we won't
    // incorrectly enable reflow on pre-21376 builds.
  }

  // Fallback: parse the NT version from userAgent. Doesn't give us the
  // exact build, but NT 10.0 means build >= 10240 (Win10 initial).
  // We leave buildNumber undefined rather than guessing, to avoid
  // incorrectly enabling reflow on pre-21376 Win10 systems.
}

/** True when running on Windows (including WebView2). */
export function isWindows(): boolean {
  return navigator.platform.toLowerCase().includes("win");
}

/** True when running on macOS. */
export function isMac(): boolean {
  return navigator.platform.toLowerCase().includes("mac");
}

/** The detected Windows build number, or undefined if unknown. */
export function getWindowsBuildNumber(): number | undefined {
  return _windowsBuildNumber;
}

/**
 * Returns the `windowsPty` option for xterm.js Terminal construction,
 * or `undefined` on non-Windows platforms.
 *
 * Usage:
 *   const term = new Terminal({
 *     ...otherOptions,
 *     ...(windowsPtyConfig() ? { windowsPty: windowsPtyConfig() } : {}),
 *   });
 */
export function windowsPtyConfig():
  | { backend: "conpty"; buildNumber?: number }
  | undefined {
  if (!isWindows()) return undefined;
  const cfg: { backend: "conpty"; buildNumber?: number } = {
    backend: "conpty",
  };
  if (_windowsBuildNumber !== undefined) {
    cfg.buildNumber = _windowsBuildNumber;
  }
  return cfg;
}
