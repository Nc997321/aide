import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connect, delay, waitFor } from "./driver.mjs";

async function click(client, id) {
  const point = await client.evaluate(`(() => { const e=document.getElementById(${JSON.stringify(id)});if(!e||e.disabled)throw new Error('control unavailable');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await client.call("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
  await client.call("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
}

async function seek(player, seconds) {
  await player.evaluate(`document.getElementById('time-input').value=${JSON.stringify(seconds.toFixed(3))}`);
  await click(player, "seek-button");
  await waitFor(() => player.evaluate(`(() => {const v=document.getElementById('video-player');return !v.seeking && Math.abs(v.currentTime-${seconds})<0.1;})()`), "decoded seek");
}

async function mediaSnapshot(player) {
  return player.evaluate(`(() => {const v=document.getElementById('video-player'),a=document.getElementById('audio-player');const e=v.hidden?a:v;return {kind:v.hidden?'audio':'video',paused:e.paused,time:e.currentTime,duration:e.duration,ready:e.readyState,width:v.videoWidth,height:v.videoHeight,error:document.getElementById('feedback').textContent};})()`);
}

async function rootSnapshot(root) {
  return root.evaluate(`(() => {const s=window.__mediaProbe.state;return {ready:s.ready,error:s.error,refs:s.refs.length,frames:s.frames,view:s.view,last:s.refs[s.refs.length-1]};})()`);
}

async function verifyHttp(url) {
  const metaUrl = new URL("./meta", url);
  const meta = await (await fetch(metaUrl)).json();
  const stream = new URL(meta.streamUrl, url);
  assert.ok(meta.active.size > 20_000_000);
  const range = await fetch(stream, { headers: { Range: "bytes=-4" } });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 4);
  const head = await fetch(stream, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get("content-length")), meta.active.size);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const invalid = await fetch(stream, { headers: { Range: `bytes=${meta.active.size}-` } });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get("content-range"), `bytes */${meta.active.size}`);
  const foreign = await fetch(metaUrl, { headers: { Origin: "null" } });
  assert.notEqual(foreign.status, 200);
  assert.equal(foreign.headers.get("access-control-allow-origin"), null);
  return { size: meta.active.size, range: 206, head: 200, invalidRange: 416, foreignOriginDenied: true };
}

async function verifyPointAndFrame(root, player) {
  await seek(player, 1.25);
  await click(player, "reference-point-button");
  await waitFor(async () => (await rootSnapshot(root)).refs === 1, "point added to original draft");
  const point = await rootSnapshot(root);
  assert.equal(point.last.selection.kind, "point");
  assert.ok(Math.abs(point.last.selection.atMs - 1250) < 100);
  await click(player, "capture-button");
  await waitFor(async () => (await rootSnapshot(root)).frames === 1, "real decoded video frame feedback");
  return { point: true, frame: true };
}

async function verifyRange(root, player) {
  await seek(player, 0.5);
  await click(player, "set-start-button");
  await seek(player, 1.0);
  await click(player, "set-end-button");
  await click(player, "loop-toggle");
  await player.evaluate("document.getElementById('video-player').currentTime=0.5;document.getElementById('video-player').play()");
  await delay(1250);
  const playback = await mediaSnapshot(player);
  assert.ok(!playback.paused && playback.time >= 0.49 && playback.time < 1.25, "range loop should return to the selected segment");
  await player.evaluate("document.getElementById('video-player').pause()");
  await click(player, "reference-range-button");
  await waitFor(async () => (await rootSnapshot(root)).last?.selection.kind === "range", "range feedback");
  const ref = (await rootSnapshot(root)).last;
  assert.equal(ref.selection.startMs, 500);
  assert.equal(ref.selection.endMs, 1000);
  return { loop: true, rangeReference: true };
}

async function verifySwitchDoesNothing(root, player) {
  await player.evaluate("document.getElementById('video-player').play()");
  const before = await mediaSnapshot(player);
  await root.evaluate("window.__mediaProbe.invoke('browser_set_displayed',{id:window.__mediaProbe.state.view,displayed:false})");
  await delay(500);
  const parked = await mediaSnapshot(player);
  assert.equal(parked.paused, false, "parking must not introduce pause behavior");
  assert.ok(parked.time > before.time, "playback should retain normal browser behavior while parked");
  await root.evaluate("window.__mediaProbe.invoke('browser_set_displayed',{id:window.__mediaProbe.state.view,displayed:true})");
  await player.evaluate("document.getElementById('video-player').pause()");
  return true;
}

async function choose(player, id) {
  await player.evaluate(`(() => {const e=document.getElementById('file-picker');e.value=${JSON.stringify(id)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(() => player.evaluate(`(() => {const e=document.getElementById('file-picker');return !e.disabled&&e.value===${JSON.stringify(id)};})()`), "file switch");
}

async function verifyAudioAndVersions(root, player) {
  await choose(player, "1");
  await waitFor(async () => { const value = await mediaSnapshot(player); return value.kind === "audio" && value.ready >= 2; }, "WAV decode");
  assert.equal(await player.evaluate("document.getElementById('capture-button').disabled"), true);
  await player.evaluate("document.getElementById('audio-player').play()");
  await delay(250);
  await player.evaluate("document.getElementById('audio-player').pause()");
  await click(player, "reference-point-button");
  await waitFor(async () => (await rootSnapshot(root)).last?.source.path.endsWith("dialogue.wav"), "audio source feedback");
  await choose(player, "2");
  await waitFor(async () => { const value = await mediaSnapshot(player); return value.kind === "video" && value.ready >= 2; }, "second video version");
  const color = await player.evaluate(`(() => {const c=document.createElement('canvas');c.width=1;c.height=1;const x=c.getContext('2d');x.drawImage(document.getElementById('video-player'),0,0,1,1);return [...x.getImageData(0,0,1,1).data];})()`);
  assert.ok(color[2] > color[0], "second explicit version should show the blue frame rather than the red original");
  return { wav: true, explicitVersionSelection: true };
}

async function verifyClose(root, url) {
  const before = await rootSnapshot(root);
  await root.evaluate("document.getElementById('close').click()");
  await waitFor(async () => (await fetch(new URL("./meta", url))).status === 410, "closed token revoked");
  const after = await rootSnapshot(root);
  assert.equal(after.refs, before.refs, "closing media must preserve already accepted draft feedback");
  assert.deepEqual(await root.evaluate("window.__mediaProbe.invoke('browser_views_list')"), []);
  return { revoked: true, draftPreserved: true };
}

export async function exercise(runtime, fixture) {
  const root = await connect(runtime, (target) => target.type === "page" && target.url.includes("aide-media-probe"));
  await waitFor(async () => { const value = await rootSnapshot(root); if (value.error) throw new Error(value.error); return value.ready; }, "probe event bridge");
  // The isolated host can be behind the user's active window. Dispatch its
  // launcher control in the document; player controls still use pointer input.
  await root.evaluate("document.getElementById('open').click()");
  try {
    await waitFor(async () => { const value = await rootSnapshot(root); if (value.error) throw new Error(value.error); return value.view; }, "media command and view creation");
  } catch (error) {
    const state = await root.evaluate("JSON.stringify(window.__mediaProbe.state)").catch(() => "unavailable");
    throw new Error(`${error.message}; probe state=${state}; process=${runtime.output}`);
  }
  const player = await connect(runtime, (target) => target.type === "page" && /\/media\/[a-f0-9]+\/player$/.test(target.url));
  await waitFor(async () => (await mediaSnapshot(player)).ready >= 2, "H.264 video decode");
  const decoded = await mediaSnapshot(player);
  assert.ok(decoded.width === 96 && decoded.height === 160 && decoded.duration > 2.9);
  const url = await player.evaluate("location.href");
  const result = { decoded: { width: decoded.width, height: decoded.height, duration: decoded.duration }, http: await verifyHttp(url) };
  result.tabSwitchUnmodified = await verifySwitchDoesNothing(root, player);
  result.references = await verifyPointAndFrame(root, player);
  result.range = await verifyRange(root, player);
  result.sources = await verifyAudioAndVersions(root, player);
  const screenshot = await player.call("Page.captureScreenshot", { format: "png" });
  const screenshotPath = join(fixture.evidence, "player.png");
  await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
  result.close = await verifyClose(root, url);
  result.screenshot = screenshotPath;
  return result;
}
