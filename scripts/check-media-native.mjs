// Build first: cargo build --manifest-path src-tauri/Cargo.toml --example media_probe
// Uses an isolated GUI/profile and CPU-encoded generated fixtures; never restarts Aide or invokes a model.
import { createFixture, saveEvidence, cleanFixture } from "./check-media-native/fixture.mjs";
import { launch, stop } from "./check-media-native/driver.mjs";
import { exercise } from "./check-media-native/scenario.mjs";

async function main() {
  const fixture = await createFixture();
  let runtime;
  try {
    runtime = await launch(fixture);
    const result = await exercise(runtime, fixture);
    await saveEvidence(fixture, result);
    console.log(JSON.stringify({ ok: true, evidence: fixture.evidence, ...result }, null, 2));
  } finally {
    try { if (runtime) await stop(runtime); }
    finally { await cleanFixture(fixture); }
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; });
