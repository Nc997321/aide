import { StateField, StateEffect, type Extension } from "@codemirror/state";
import {
  EditorView,
  ViewPlugin,
  Decoration,
  type DecorationSet,
} from "@codemirror/view";

// ── State layer: effect + field ──

const setHoverWord = StateEffect.define<{
  from: number;
  to: number;
} | null>();

const hoverMark = Decoration.mark({ class: "cm-ctrl-hover" });

const hoverField = StateField.define<DecorationSet>({
  create: () => Decoration.none,

  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setHoverWord)) {
        return e.value
          ? Decoration.set([hoverMark.range(e.value.from, e.value.to)])
          : Decoration.none;
      }
    }
    return tr.docChanged ? Decoration.none : deco;
  },

  provide: (f) => EditorView.decorations.from(f),
});

// ── Event layer: ViewPlugin ──

class CtrlHoverTracker {
  private ctrlHeld = false;
  private mousePos: { x: number; y: number } | null = null;
  private activeRange: { from: number; to: number } | null = null;

  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private readonly onKeyUp: (e: KeyboardEvent) => void;
  private readonly onWindowBlur: () => void;
  private readonly onMouseMove: (e: MouseEvent) => void;
  private readonly onMouseLeave: () => void;

  constructor(private view: EditorView) {
    this.onKeyDown = (e) => {
      if (e.key === "Control" && !this.ctrlHeld) {
        this.ctrlHeld = true;
        console.warn(`[hover] ctrl down`);
        this.sync();
      }
    };
    this.onKeyUp = (e) => {
      if (e.key === "Control") {
        this.ctrlHeld = false;
        console.warn(`[hover] ctrl up`);
        this.clear();
      }
    };
    this.onWindowBlur = () => {
      this.ctrlHeld = false;
      this.clear();
    };
    this.onMouseMove = (e) => {
      this.mousePos = { x: e.clientX, y: e.clientY };
      if (this.ctrlHeld) this.sync();
    };
    this.onMouseLeave = () => {
      this.mousePos = null;
      this.clear();
    };

    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onWindowBlur);
    view.dom.addEventListener("mousemove", this.onMouseMove);
    view.dom.addEventListener("mouseleave", this.onMouseLeave);
  }

  private sync() {
    if (!this.ctrlHeld || !this.mousePos) {
      this.clear();
      return;
    }
    const pos = this.view.posAtCoords(this.mousePos);
    if (pos === null) {
      this.clear();
      return;
    }
    const word = this.view.state.wordAt(pos);
    if (!word) {
      this.clear();
      return;
    }
    if (
      this.activeRange &&
      this.activeRange.from === word.from &&
      this.activeRange.to === word.to
    ) {
      return;
    }
    this.activeRange = { from: word.from, to: word.to };
    console.warn(`[hover] ctrl sync word="${this.view.state.doc.sliceString(word.from, word.to)}" pos=${pos}`);
    this.view.dispatch({ effects: setHoverWord.of(this.activeRange) });
  }

  private clear() {
    if (this.activeRange) {
      console.warn(`[hover] ctrl clear`);
      this.activeRange = null;
      this.view.dispatch({ effects: setHoverWord.of(null) });
    }
  }

  destroy() {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onWindowBlur);
    this.view.dom.removeEventListener("mousemove", this.onMouseMove);
    this.view.dom.removeEventListener("mouseleave", this.onMouseLeave);
  }
}

const hoverPlugin = ViewPlugin.fromClass(CtrlHoverTracker);

// ── Theme layer ──

const hoverTheme = EditorView.baseTheme({
  ".cm-ctrl-hover": {
    textDecoration: "underline",
    textUnderlineOffset: "3px",
    cursor: "pointer",
  },
});

// ── Public API ──

export function ctrlHoverHighlight(): Extension {
  return [hoverField, hoverPlugin, hoverTheme];
}
