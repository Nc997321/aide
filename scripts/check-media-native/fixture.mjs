import { mkdtemp, open, stat, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

function execute(command, args) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let errors = "";
    child.stderr.on("data", (chunk) => { errors = (errors + chunk).slice(-6000); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? accept() : reject(new Error(`fixture encoder exited ${code}: ${errors}`)));
  });
}

async function video(path, color) {
  await execute(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "error", "-nostdin", "-f", "lavfi", "-i", `color=c=${color}:s=96x160:r=24`,
    "-t", "3", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path]);
}

async function padWithFreeAtom(path) {
  const position = (await stat(path)).size;
  const length = 24 * 1024 * 1024;
  const header = Buffer.alloc(8);
  header.writeUInt32BE(length);
  header.write("free", 4, "ascii");
  const file = await open(path, "r+");
  try { await file.write(header, 0, header.length, position); await file.truncate(position + length); }
  finally { await file.close(); }
}

export async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "aide-media-native-"));
  const evidence = await mkdtemp(join(tmpdir(), "aide-media-evidence-"));
  const files = [join(root, "scene-v1.mp4"), join(root, "dialogue.wav"), join(root, "scene-v2.mp4")];
  try {
    await video(files[0], "red");
    await video(files[2], "blue");
    await execute(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "error", "-nostdin", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "3", "-c:a", "pcm_s16le", files[1]]);
    await padWithFreeAtom(files[0]);
    await mkdir(join(root, "profile"));
    return { root, evidence, files, executable: resolve("src-tauri/target/debug/examples", process.platform === "win32" ? "media_probe.exe" : "media_probe") };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

export async function freePort() {
  const server = createServer();
  await new Promise((accept, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", accept); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unable to allocate local debugging port");
  await new Promise((accept, reject) => server.close((error) => error ? reject(error) : accept()));
  return address.port;
}

export async function saveEvidence(fixture, result) {
  await writeFile(join(fixture.evidence, "result.json"), JSON.stringify(result, null, 2));
}

export async function cleanFixture(fixture) {
  await rm(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
