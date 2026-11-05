(() => {
  "use strict";

  const MAX_FRAME_EDGE = 1280;
  const MAX_FRAME_BASE64_BYTES = 6 * 1024 * 1024;
  const ALLOWED_THEME_KEYS = new Set([
    "--aide-bg-deep", "--aide-bg-base", "--aide-bg-raised", "--aide-surface-default",
    "--aide-surface-hover", "--aide-text-primary", "--aide-text-secondary", "--aide-text-muted",
    "--aide-accent", "--aide-accent-subtle", "--aide-success", "--aide-warning", "--aide-danger",
    "--aide-border", "--aide-border-strong"
  ]);

  const ui = {
    title: get("media-title"), details: get("media-details"), pickerWrap: get("file-picker-wrap"),
    picker: get("file-picker"), video: get("video-player"), audio: get("audio-player"),
    placeholder: get("media-placeholder"), timeInput: get("time-input"), ratePicker: get("rate-picker"),
    currentTime: get("current-time"), duration: get("duration-time"), rangeStart: get("range-start"),
    rangeEnd: get("range-end"), setStart: get("set-start-button"), setEnd: get("set-end-button"),
    clearRange: get("clear-range-button"), loop: get("loop-toggle"), point: get("reference-point-button"),
    range: get("reference-range-button"), capture: get("capture-button"), feedback: get("feedback"),
    retry: get("retry-button"), save: get("save-button"), external: get("external-button"),
    seek: get("seek-button")
  };
  let meta = null;
  let rangeStart = null;
  let rangeEnd = null;
  let mediaKind = "";
  let selecting = false;

  function get(id) {
    const element = document.getElementById(id);
    if (!element) throw new Error(`播放器页面缺少控件：${id}`);
    return element;
  }

  function on(target, eventName, handler) {
    target.addEventListener(eventName, (domEvent) => {
      try { handler(domEvent); } catch (error) { showError(humanize(error)); }
    });
  }

  function runTask(task) {
    task.catch((error) => showError(humanize(error)));
  }

  function showError(message) {
    ui.feedback.textContent = message;
    ui.feedback.dataset.state = "error";
    ui.retry.hidden = false;
  }

  function showSuccess(message) {
    ui.feedback.textContent = message;
    ui.feedback.dataset.state = "success";
  }

  function showInfo(message) {
    ui.feedback.textContent = message;
    delete ui.feedback.dataset.state;
  }

  function humanize(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/SecurityError|tainted|cross-origin|CORS/i.test(message)) return "浏览器无法读取视频帧，可能是媒体源的 CORS 限制。请重试或用系统程序打开。";
    if (/Failed to fetch|NetworkError|Load failed/i.test(message)) return "媒体服务暂时无法连接。检查 Aide 是否仍在运行，然后点“重试”。";
    return message || "操作没有完成，请点“重试”后再试一次。";
  }

  function friendlyCode(code, status) {
    const messages = {
      source_missing: "源文件已不存在或已移动。请点“重试”刷新媒体信息。",
      source_changed: "媒体源已变化。请点“重试”载入最新版本。",
      host_disconnected: "媒体服务已断开。检查 Aide 是否仍在运行，然后点“重试”。",
      unsupported: "浏览器无法解码此媒体格式。可尝试“用系统程序打开”。",
      screenshot_unavailable: "无法读取视频帧。检查媒体是否已播放到可解码画面后重试。",
      revision_conflict: "媒体版本已切换，此次引用已取消。请确认当前版本后重新引用。"
    };
    if (messages[code]) return messages[code];
    if (status === 404 || status === 410) return messages.source_missing;
    if (status === 409) return messages.revision_conflict;
    return "请求没有完成。检查媒体服务后点“重试”，或稍后再试。";
  }

  async function readResponse(response) {
    let body;
    try { body = await response.json(); } catch (error) {
      if (response.ok) throw new Error("媒体服务返回了无法读取的信息，请点“重试”。");
      throw new Error(friendlyCode("", response.status));
    }
    if (!body || typeof body !== "object") throw new Error("媒体服务返回了无法读取的信息，请点“重试”。");
    if (!response.ok) {
      const fallback = friendlyCode(body.code, response.status);
      throw new Error(typeof body.error === "string" && body.error ? body.error : fallback);
    }
    return body;
  }

  async function requestMeta() {
    const url = new URL("./meta", location.href);
    const response = await fetch(url, { method: "GET", cache: "no-store", credentials: "same-origin" });
    return validateMeta(await readResponse(response));
  }

  async function postAction(payload) {
    const url = new URL("./action", location.href);
    const response = await fetch(url, {
      method: "POST", cache: "no-store", credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
    });
    return readResponse(response);
  }

  function validateMeta(value) {
    if (!value || !Array.isArray(value.files) || !value.active || typeof value.streamUrl !== "string") {
      throw new Error("媒体服务返回的信息不完整。请点“重试”重新读取。");
    }
    if (typeof value.active.id !== "string" || typeof value.active.revision !== "string") {
      throw new Error("媒体源版本信息缺失。请点“重试”重新读取。");
    }
    return value;
  }

  function applyTheme(theme) {
    if (!theme || typeof theme !== "object") return;
    for (const [key, value] of Object.entries(theme)) {
      if (ALLOWED_THEME_KEYS.has(key) && typeof value === "string" && value.length < 160) {
        document.documentElement.style.setProperty(key, value);
      }
    }
  }

  function formatTime(milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return "00:00.000";
    const total = Math.floor(milliseconds);
    const millis = String(total % 1000).padStart(3, "0");
    const seconds = Math.floor(total / 1000) % 60;
    const minutes = Math.floor(total / 60000) % 60;
    const hours = Math.floor(total / 3600000);
    const clock = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${millis}`;
    return hours ? `${String(hours).padStart(2, "0")}:${clock}` : clock;
  }

  function activeMedia() {
    return mediaKind === "video" ? ui.video : ui.audio;
  }

  function updateControlState() {
    const ready = Boolean(meta && mediaKind && !selecting);
    const hasDuration = ready && Number.isFinite(activeMedia().duration);
    ui.timeInput.disabled = !ready;
    ui.seek.disabled = !ready;
    ui.ratePicker.disabled = !ready;
    ui.setStart.disabled = !hasDuration;
    ui.setEnd.disabled = !hasDuration;
    ui.clearRange.disabled = rangeStart === null && rangeEnd === null;
    ui.loop.disabled = rangeStart === null || rangeEnd === null || rangeEnd <= rangeStart;
    ui.point.disabled = !ready;
    ui.range.disabled = !ready || rangeStart === null || rangeEnd === null || rangeEnd <= rangeStart;
    ui.capture.disabled = !ready || mediaKind !== "video";
    ui.save.disabled = !meta || selecting;
    ui.external.disabled = !meta || !meta.canOpenExternal || selecting;
  }

  function setPlaceholder(message, isError) {
    ui.placeholder.hidden = false;
    ui.placeholder.textContent = message;
    ui.placeholder.dataset.state = isError ? "error" : "info";
  }

  function renderFiles() {
    const files = meta.files;
    ui.picker.replaceChildren();
    for (const file of files) {
      if (!file || typeof file.id !== "string") continue;
      const option = document.createElement("option");
      option.value = file.id;
      option.textContent = file.title || file.name || "未命名媒体";
      ui.picker.append(option);
    }
    ui.pickerWrap.hidden = files.length < 2;
    ui.picker.value = meta.active.id;
  }

  function resetPlayers() {
    for (const player of [ui.video, ui.audio]) {
      player.pause();
      player.onerror = null;
      player.onloadedmetadata = null;
      player.ontimeupdate = null;
      player.oncanplay = null;
      player.removeAttribute("src");
      player.load();
    }
  }

  function configureSource() {
    resetPlayers();
    const active = meta.active;
    const mime = typeof active.mime === "string" ? active.mime.toLowerCase() : "";
    mediaKind = mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "";
    ui.title.textContent = active.title || active.name || "媒体预览";
    ui.details.textContent = describeFile(active);
    ui.video.hidden = mediaKind !== "video";
    ui.audio.hidden = mediaKind !== "audio";
    if (!mediaKind) {
      setPlaceholder("浏览器无法识别该媒体类型。可尝试用系统程序打开。", true);
      ui.retry.hidden = false;
      updateControlState();
      return;
    }
    const source = new URL(meta.streamUrl, location.href);
    if (source.origin !== location.origin || !/^https?:$/.test(source.protocol)) throw new Error("媒体服务提供了无效的本机播放地址，请重新打开。");
    const player = activeMedia();
    player.pause();
    player.onerror = () => handleMediaError(player);
    player.onloadedmetadata = () => metadataReady(player);
    player.ontimeupdate = () => updatePlayback(player);
    player.oncanplay = () => {
      ui.placeholder.hidden = true;
      updateControlState();
    };
    player.src = source.href;
    player.load();
    setPlaceholder("正在读取媒体流…", false);
    updateControlState();
  }

  function describeFile(active) {
    const details = [];
    if (active.mime) details.push(active.mime);
    if (Number.isFinite(active.size)) details.push(formatBytes(active.size));
    return details.join(" · ") || "原始媒体文件";
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function updateDuration(player) {
    ui.duration.textContent = Number.isFinite(player.duration) ? formatTime(player.duration * 1000) : "--:--.---";
    updateControlState();
  }

  function metadataReady(player) {
    updateDuration(player);
    player.playbackRate = Number(ui.ratePicker.value);
    const selection = meta && meta.initialSelection;
    if (!selection) return;
    const start = selection.kind === "point" ? selection.atMs / 1000 : selection.startMs / 1000;
    if (!Number.isFinite(start) || start < 0 || start > player.duration) {
      showError("引用时间超出当前媒体时长，未自动跳转。");
      return;
    }
    player.currentTime = start;
    if (selection.kind === "range" && selection.endMs / 1000 <= player.duration) {
      rangeStart = start;
      rangeEnd = selection.endMs / 1000;
      renderRange();
    }
    meta.initialSelection = null;
  }

  function updatePlayback(player) {
    ui.currentTime.textContent = formatTime(player.currentTime * 1000);
    if (ui.loop.checked && rangeStart !== null && rangeEnd !== null && player.currentTime >= rangeEnd) {
      player.currentTime = rangeStart;
    }
  }

  function handleMediaError(player) {
    const code = player.error ? player.error.code : 0;
    const messages = {
      1: "播放已中止。确认媒体源仍可用，再点“重试”。",
      2: "媒体流连接中断。检查 Aide 是否仍在运行，再点“重试”。",
      3: "浏览器无法解码此媒体编码。可尝试用系统程序打开。",
      4: "浏览器不支持此媒体格式。可尝试用系统程序打开。"
    };
    const message = messages[code] || "媒体源无法读取或已不存在。请点“重试”刷新媒体信息。";
    setPlaceholder(message, true);
    showError(message);
    updateControlState();
  }

  function renderRange() {
    ui.rangeStart.textContent = rangeStart === null ? "未设置" : formatTime(rangeStart * 1000);
    ui.rangeEnd.textContent = rangeEnd === null ? "未设置" : formatTime(rangeEnd * 1000);
    updateControlState();
  }

  async function loadMeta() {
    ui.retry.hidden = true;
    showInfo("正在加载媒体信息…");
    const fresh = await requestMeta();
    meta = fresh;
    applyTheme(fresh.theme);
    renderFiles();
    configureSource();
    ui.external.hidden = !fresh.canOpenExternal;
    showInfo("媒体信息已读取，正在加载播放数据。引用只会加入原会话草稿。");
  }

  async function retrySource() {
    if (!meta) { await loadMeta(); return; }
    if (selecting) return;
    selecting = true;
    updateControlState();
    ui.retry.hidden = true;
    try {
      meta = validateMeta(await postAction({ action: "select", fileId: meta.active.id }));
      rangeStart = null;
      rangeEnd = null;
      ui.loop.checked = false;
      renderFiles();
      renderRange();
      configureSource();
      showInfo("已重新打开当前文件；原草稿中的旧版引用保持不变。");
    } finally {
      selecting = false;
      updateControlState();
    }
  }

  async function chooseFile(fileId) {
    if (!meta || selecting || fileId === meta.active.id) return;
    selecting = true;
    updateControlState();
    ui.picker.disabled = true;
    showInfo("正在切换媒体版本…");
    try {
      const response = await postAction({ action: "select", fileId });
      const fresh = validateMeta(response);
      meta = fresh;
      rangeStart = null;
      rangeEnd = null;
      ui.loop.checked = false;
      applyTheme(fresh.theme);
      renderFiles();
      renderRange();
      configureSource();
      ui.external.hidden = !fresh.canOpenExternal;
      showInfo("已切换到所选媒体版本。");
    } finally {
      selecting = false;
      ui.picker.disabled = false;
      if (meta) ui.picker.value = meta.active.id;
      updateControlState();
    }
  }

  function mediaTime() {
    return activeMedia().currentTime;
  }

  function parseTime(value) {
    const input = value.trim();
    if (!input) throw new Error("输入要跳转的时间，例如 01:23.500。");
    const parts = input.split(":");
    if (parts.length > 3 || parts.some((part) => !/^\d+(?:\.\d+)?$/.test(part))) {
      throw new Error("时间格式无效。请使用秒数、分:秒或时:分:秒，例如 01:23.500。");
    }
    const seconds = parts.reduce((total, part) => total * 60 + Number(part), 0);
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error("请输入有效的非负时间。");
    return seconds;
  }

  function jumpToInput() {
    const target = parseTime(ui.timeInput.value);
    const player = activeMedia();
    if (Number.isFinite(player.duration) && target > player.duration) throw new Error("输入时间超过了媒体总时长。");
    player.currentTime = target;
    showInfo(`已跳转到 ${formatTime(target * 1000)}。`);
  }

  function setRangePoint(which) {
    const now = mediaTime();
    if (which === "start" && rangeEnd !== null && now >= rangeEnd) throw new Error("A 起点必须早于已设置的 B 终点。");
    if (which === "end" && rangeStart !== null && now <= rangeStart) throw new Error("B 终点必须晚于已设置的 A 起点。");
    if (which === "start") rangeStart = now;
    else rangeEnd = now;
    renderRange();
    showInfo(`${which === "start" ? "A 起点" : "B 终点"}已设为 ${formatTime(now * 1000)}。`);
  }

  function currentRevision() {
    if (!meta || typeof meta.active.revision !== "string") throw new Error("媒体版本信息不可用。请点“重试”。");
    return meta.active.revision;
  }

  async function reference(selection, frame) {
    const revision = currentRevision();
    const payload = { action: "reference", revision, selection };
    if (frame) payload.frame = frame;
    const result = await postAction(payload);
    if (result.ok !== true) throw new Error("引用没有完成。请确认媒体服务正常后重试。");
    if (!meta || meta.active.revision !== revision) throw new Error(friendlyCode("revision_conflict", 409));
    showSuccess("已加入原会话草稿，尚未发送。");
  }

  async function captureAndReference() {
    const revision = currentRevision();
    const source = meta.streamUrl;
    ui.video.pause();
    const capture = await captureVideoFrame(ui.video);
    if (!meta || meta.active.revision !== revision || meta.streamUrl !== source) throw new Error(friendlyCode("revision_conflict", 409));
    await reference({ kind: "point", atMs: capture.atMs }, capture.frame);
  }

  async function captureVideoFrame(video) {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) {
      throw new Error("视频还没有可截图的解码画面。播放片刻后暂停，再重试截图。");
    }
    await waitForSeek(video);
    await waitForFrame(video);
    if (video.seeking) throw new Error("视频仍在定位，这次未截取画面，请定位完成后重试。");
    const atMs = Math.round(video.currentTime * 1000);
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, MAX_FRAME_EDGE / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法创建截图画布。请重试或用系统程序打开。");
    try { context.drawImage(video, 0, 0, canvas.width, canvas.height); } catch (error) {
      throw new Error("无法读取视频帧。媒体可能受 CORS 限制，请重试或用系统程序打开。");
    }
    const data = await encodeFrame(canvas);
    return { atMs, frame: { data, mediaType: "image/png" } };
  }

  async function encodeFrame(original) {
    let canvas = original;
    for (let attempt = 0; attempt < 3; attempt++) {
      const blob = await canvasBlob(canvas);
      if (Math.ceil(blob.size / 3) * 4 <= MAX_FRAME_BASE64_BYTES) return blobBase64(blob);
      const smaller = document.createElement("canvas");
      smaller.width = Math.max(1, Math.floor(canvas.width * 0.75));
      smaller.height = Math.max(1, Math.floor(canvas.height * 0.75));
      const context = smaller.getContext("2d");
      if (!context) throw new Error("浏览器无法缩小截图，请换一帧重试。");
      context.drawImage(canvas, 0, 0, smaller.width, smaller.height);
      canvas = smaller;
    }
    throw new Error("本帧截图仍超过大小限制，请换一帧重试。");
  }

  function waitForSeek(video) {
    if (!video.seeking) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = () => { cleanup(); resolve(); };
      const changed = () => { cleanup(); reject(new Error("媒体源已变化，截图已取消。")); };
      const timer = window.setTimeout(() => { cleanup(); reject(new Error("视频定位超时，未截取画面，请稍后重试。")); }, 8000);
      const cleanup = () => {
        window.clearTimeout(timer);
        video.removeEventListener("seeked", finish);
        video.removeEventListener("emptied", changed);
      };
      video.addEventListener("seeked", finish, { once: true });
      video.addEventListener("emptied", changed, { once: true });
    });
  }

  function waitForFrame(video) {
    if (typeof video.requestVideoFrameCallback !== "function") return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve();
      };
      const timer = window.setTimeout(finish, 350);
      video.requestVideoFrameCallback(finish);
    });
  }

  function canvasBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("截图编码失败。请重试或用系统程序打开。"));
      }, "image/png");
    });
  }

  function blobBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("无法读取截图数据。请重试。"));
      reader.onload = () => {
        if (typeof reader.result !== "string") {
          reject(new Error("截图数据格式无效。请重试。"));
          return;
        }
        resolve(reader.result.slice(reader.result.indexOf(",") + 1));
      };
      reader.readAsDataURL(blob);
    });
  }

  async function invokeSimpleAction(action, successText) {
    const result = await postAction({ action });
    if (result.ok !== true) throw new Error("操作没有完成。确认媒体服务正常后重试。");
    showSuccess(result.message || successText);
  }

  function bindEvents() {
    on(ui.retry, "click", () => runTask(retrySource()));
    on(ui.picker, "change", () => runTask(chooseFile(ui.picker.value)));
    on(ui.seek, "click", jumpToInput);
    on(ui.timeInput, "keydown", (domEvent) => {
      if (domEvent.key === "Enter") { domEvent.preventDefault(); jumpToInput(); }
    });
    on(ui.ratePicker, "change", () => { if (mediaKind) activeMedia().playbackRate = Number(ui.ratePicker.value); });
    on(ui.setStart, "click", () => setRangePoint("start"));
    on(ui.setEnd, "click", () => setRangePoint("end"));
    on(ui.clearRange, "click", clearRange);
    on(ui.loop, "change", () => showInfo(ui.loop.checked ? "片段循环已开启。" : "片段循环已关闭。"));
    on(ui.point, "click", () => runTask(reference({ kind: "point", atMs: Math.round(mediaTime() * 1000) })));
    on(ui.range, "click", () => runTask(reference({ kind: "range", startMs: Math.round(rangeStart * 1000), endMs: Math.round(rangeEnd * 1000) })));
    on(ui.capture, "click", () => runTask(captureAndReference()));
    on(ui.save, "click", () => runTask(invokeSimpleAction("save", "已保存到本机。")));
    on(ui.external, "click", () => runTask(invokeSimpleAction("open_external", "已交给系统程序打开。")));
  }

  function clearRange() {
    rangeStart = null;
    rangeEnd = null;
    ui.loop.checked = false;
    renderRange();
    showInfo("片段范围已清除。");
  }

  function start() {
    bindEvents();
    ui.retry.hidden = false;
    ui.external.hidden = true;
    updateControlState();
    runTask(loadMeta());
  }

  window.addEventListener("unhandledrejection", (event) => {
    event.preventDefault();
    showError(humanize(event.reason));
  });
  window.addEventListener("error", (event) => showError(event.message || "播放器页面发生错误，请点“重试”。"));
  start();
})();
