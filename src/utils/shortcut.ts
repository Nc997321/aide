export interface ShortcutDef {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

/**
 * Parse a shortcut string like "Ctrl+Shift+P" or "Ctrl+P" into a ShortcutDef.
 */
export function parseShortcut(s: string): ShortcutDef {
  const parts = s.toLowerCase().split("+").map(p => p.trim());
  const def: ShortcutDef = { key: "", ctrl: false, shift: false, alt: false, meta: false };
  for (const p of parts) {
    if (p === "ctrl" || p === "control") def.ctrl = true;
    else if (p === "shift") def.shift = true;
    else if (p === "alt") def.alt = true;
    else if (p === "meta" || p === "cmd" || p === "win") def.meta = true;
    else def.key = p;
  }
  return def;
}

/**
 * Check if a KeyboardEvent matches a shortcut string like "Ctrl+P".
 */
export function matchShortcut(e: KeyboardEvent, shortcut: string): boolean {
  const def = parseShortcut(shortcut);
  const key = e.key.toLowerCase();
  const defKey = def.key.toLowerCase();
  const keyMatch =
    key === defKey ||
    (defKey === "space" && key === " ") ||
    (defKey === "`" && (key === "`" || key === "dead"));
  return (
    keyMatch &&
    e.ctrlKey === def.ctrl &&
    e.shiftKey === def.shift &&
    e.altKey === def.alt &&
    e.metaKey === def.meta
  );
}

/**
 * Detect conflicts between shortcut definitions.
 * Returns pairs of action names that share the same shortcut string.
 */
export function detectConflicts(
  bindings: Record<string, string>,
): Array<[string, string]> {
  const conflicts: Array<[string, string]> = [];
  const entries = Object.entries(bindings);
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (entries[i][1] === entries[j][1]) {
        conflicts.push([entries[i][0], entries[j][0]]);
      }
    }
  }
  return conflicts;
}

/**
 * Format a KeyboardEvent into a human-readable shortcut string like "Ctrl+P".
 * Useful for the "record shortcut" UI in settings.
 */
export function formatShortcut(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  if (e.metaKey) parts.push("Meta");
  let key = e.key;
  if (key === " ") {
    key = "Space";
  } else if (key.length === 1) {
    key = key.toUpperCase();
  } else {
    // Capitalize first letter for named keys (Enter, Escape, Backspace, etc.)
    key = key.charAt(0).toUpperCase() + key.slice(1);
  }
  parts.push(key);
  return parts.join("+");
}
