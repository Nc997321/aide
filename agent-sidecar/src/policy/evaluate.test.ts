// @vitest-environment node
import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { evaluatePolicy } from "./evaluate.js";
import { pathWithinFolder } from "./matchers.js";

// Load the shared fixture from the Rust side
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(__dirname, "../../../src-tauri/src/policy/fixtures/permission-policy.json");
const cases: any[] = JSON.parse(fsSync.readFileSync(fixturePath, "utf-8"));

describe("shared fixture parity", () => {
  for (const fixture of cases) {
    it(`matches Rust fixture: ${fixture.name}`, async () => {
      const result = await evaluatePolicy(
        { revision: 1, rules: fixture.rules },
        fixture.invocation,
      );
      expect(result.disposition).toBe(fixture.expectedDisposition);
      expect(result.winner?.id ?? null).toBe(fixture.expectedWinner);
    });
  }
});

describe("symlink escape", () => {
  it("must NOT allow symlink escape outside the allowed folder", async () => {
    // Create a temp directory structure:
    //   tmp/
    //     allowed/
    //     outside/
    //       file.txt
    //     allowed/link -> outside/  (symlink)
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "policy-test-"));
    try {
      const allowedDir = path.join(tmpDir, "allowed");
      const outsideDir = path.join(tmpDir, "outside");
      await fs.mkdir(allowedDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(path.join(outsideDir, "file.txt"), "hello");

      // Create symlink: allowed/link -> outside/
      let symlinkCreated = false;
      try {
        // Use junction on Windows if possible, symlink otherwise
        if (process.platform === "win32") {
          // On Windows, directory symlinks require admin or developer mode.
          // Try creating one; if it fails, skip the test.
          await fs.symlink(outsideDir, path.join(allowedDir, "link"), "junction");
        } else {
          await fs.symlink(outsideDir, path.join(allowedDir, "link"), "dir");
        }
        symlinkCreated = true;
      } catch {
        // Symlink creation not supported (e.g., Windows without developer mode)
        // Skip the test gracefully
        return;
      }

      if (!symlinkCreated) return;

      // Rule: allow path folder=allowed
      const rules = [
        {
          id: "a",
          scope: "user" as const,
          order: 0,
          effect: "allow" as const,
          tool: "Read",
          matcher: { kind: "path" as const, field: "file_path" as const, folder: allowedDir },
        },
      ];

      // Invocation: path = allowed/link/file.txt (symlink escape)
      const invocation = {
        tool: "Read",
        input: { file_path: path.join(allowedDir, "link", "file.txt") },
      };

      const result = await evaluatePolicy({ revision: 1, rules }, invocation);
      // The symlink escape must NOT be treated as a folder allow
      expect(result.disposition).toBe("defer");
      expect(result.winner).toBeNull();
    } finally {
      // Cleanup
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("pathWithinFolder", () => {
  it("rejects symlink escape via pathWithinFolder directly", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "policy-test-"));
    try {
      const allowedDir = path.join(tmpDir, "allowed");
      const outsideDir = path.join(tmpDir, "outside");
      await fs.mkdir(allowedDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(path.join(outsideDir, "file.txt"), "hello");

      let symlinkCreated = false;
      try {
        if (process.platform === "win32") {
          await fs.symlink(outsideDir, path.join(allowedDir, "link"), "junction");
        } else {
          await fs.symlink(outsideDir, path.join(allowedDir, "link"), "dir");
        }
        symlinkCreated = true;
      } catch {
        return;
      }

      if (!symlinkCreated) return;

      const target = path.join(allowedDir, "link", "file.txt");
      const result = await pathWithinFolder(target, allowedDir);
      expect(result).toBe(false);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
