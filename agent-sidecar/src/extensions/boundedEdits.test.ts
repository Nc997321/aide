import { describe, expect, it } from "vitest";
import { boundFormatter } from "./boundedEdits.js";

describe("formatter write footprint", () => {
  it("the recorded module-root invocation cannot recursively format siblings", () => {
    expect(boundFormatter("cd src-tauri && rustfmt --edition 2021 crates/aide-core/src/lib.rs crates/aide-core/src/commands/mod.rs"))
      .toBe("cd src-tauri && rustfmt --config skip_children=true --edition 2021 crates/aide-core/src/lib.rs crates/aide-core/src/commands/mod.rs");
  });
  it("does not rewrite read-only checks, explicit config or unrelated commands", () => {
    for (const command of ["rustfmt --check src/lib.rs", "rustfmt --config skip_children=true src/lib.rs",
      "rustfmt --config skip_children=false src/lib.rs", "echo 'rustfmt src/lib.rs'", "cargo test", "echo $(rustfmt src/lib.rs)"]) {
      expect(boundFormatter(command)).toBeUndefined();
    }
  });
});
