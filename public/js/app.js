import { Viewer, PLATE } from "./viewer.js";
import { renderScad } from "./scad.js";

const $ = (sel) => document.querySelector(sel);
const TOKEN_KEY = "skhs3d.token";

const EXAMPLES = [
  "내 이름 영문 이니셜이 새겨진 5cm 하트 모양 열쇠고리 (고리 구멍 포함)",
  "지름 7cm, 높이 9cm의 육각형 연필꽂이. 옆면에 벌집 무늬 구멍",
  "스마트폰을 60도 각도로 세울 수 있는 접히지 않는 거치대",
  "'성광'이라는 글자가 돋을새김된 책상용 명패 (10cm x 3cm)",
  "고양이 귀가 달린 작은 소품 트레이",
];

const state = {
  token: localStorage.getItem(TOKEN_KEY),
  me: null,
  config: null,
  designs: [],
  design: null, // 현재 열린 도안
  stl: null, // 마지막으로 렌더링된 STL
  busy: false,
  fixAttempts: 0,
  viewer: null,
  galleryTimer: null,
  attachments: [], // 보낼 참고 이미지 (data URL)
};

// ---------- API ----------

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    logout();
    throw new Error(data.error || "다시 로그인해 주세요.");
  }
  if (!res.ok) throw new Error(data.error || `오류 (${res.status})`);
  return data;
}

// ---------- 로그인 ----------

async function init() {
  state.config = await api("/api/config");
  const select = $("#login-form select[name=club]");
  select.innerHTML =
    `<option value="">동아리를 선택하세요</option>` +
    state.config.clubs.map((c) => `<option>${escapeHtml(c)}</option>`).join("");
  $("#access-code-field").hidden = !state.config.needsAccessCode;

  if (state.token) {
    try {
      const me = await api("/api/me");
      return showApp(me);
    } catch {}
  }
  showLogin();
}

function showLogin() {
  $("#app-view").hidden = true;
  $("#login-view").hidden = false;
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const err = $("#login-error");
  err.hidden = true;
  try {
    const data = await api("/api/login", { method: "POST", body: Object.fromEntries(form) });
    state.token = data.token;
    localStorage.setItem(TOKEN_KEY, data.token);
    showApp(await api("/api/me"));
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

function logout() {
  state.token = null;
  localStorage.removeItem(TOKEN_KEY);
  clearInterval(state.galleryTimer);
  showLogin();
}
$("#logout-btn").addEventListener("click", logout);

// ---------- 메인 화면 ----------

async function showApp(me) {
  state.me = me.student;
  $("#login-view").hidden = true;
  $("#app-view").hidden = false;
  $("#me-label").textContent = `${me.student.club} · ${me.student.studentNo} ${me.student.name}`;
  updateUsage(me.usedToday, me.dailyLimit);
  if (!state.viewer) state.viewer = new Viewer($("#viewer"));
  renderExamples();
  await loadDesigns();
}

function updateUsage(used, limit = state.config.dailyLimit) {
  $("#usage-label").textContent = `오늘 ${used}/${limit}회`;
}

document.querySelectorAll(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    const gallery = tab.dataset.tab === "gallery";
    $("#studio").hidden = gallery;
    $("#gallery").hidden = !gallery;
    clearInterval(state.galleryTimer);
    if (gallery) {
      loadGallery();
      state.galleryTimer = setInterval(loadGallery, 20000);
    }
  }),
);

// ---------- 도안 목록 ----------

async function loadDesigns(selectId) {
  const { designs } = await api("/api/designs");
  state.designs = designs;
  if (!designs.length) {
    const { design } = await api("/api/designs", { method: "POST" });
    state.designs = [design];
  }
  renderDesignSelect();
  await openDesign(selectId || state.design?.id || state.designs[0].id);
}

function renderDesignSelect() {
  $("#design-select").innerHTML = state.designs
    .map((d) => `<option value="${d.id}">${escapeHtml(d.title)}${d.shared ? " 🌐" : ""}</option>`)
    .join("");
  if (state.design) $("#design-select").value = state.design.id;
}

$("#design-select").addEventListener("change", (e) => {
  if (state.busy) return (e.target.value = state.design.id);
  openDesign(e.target.value);
});

$("#new-design-btn").addEventListener("click", async () => {
  if (state.busy) return;
  const { design } = await api("/api/designs", { method: "POST" });
  state.design = null;
  await loadDesigns(design.id);
  $("#chat-input").focus();
});

$("#delete-design-btn").addEventListener("click", async () => {
  if (state.busy || !state.design) return;
  if (!confirm(`'${state.design.title}' 도안을 삭제할까요? 되돌릴 수 없어요.`)) return;
  await api(`/api/designs/${state.design.id}`, { method: "DELETE" });
  state.design = null;
  await loadDesigns();
});

async function openDesign(id) {
  const { design } = await api(`/api/designs/${id}`);
  state.design = design;
  state.stl = null;
  state.fixAttempts = 0;
  $("#design-select").value = id;
  $("#title-input").value = design.title;
  $("#share-toggle").checked = design.shared;
  $("#code-editor").value = design.code || "";
  $("#download-btn").disabled = true;
  $("#size-info").hidden = true;
  setStatus("");
  state.viewer.clear();
  renderChat();
  if (design.code) {
    await buildModel(design.code, { autoFix: false, saveThumb: !design.thumbnail });
  } else {
    showOverlay("왼쪽에 만들고 싶은 물건을 설명하면<br />여기에 3D 모델이 나타나요.");
  }
}

$("#title-input").addEventListener("change", async (e) => {
  const title = e.target.value.trim() || "새 도안";
  e.target.value = title;
  await saveDesign({ title });
});

$("#share-toggle").addEventListener("change", async (e) => {
  if (e.target.checked && !state.stl) {
    e.target.checked = false;
    return alert("먼저 3D 모델을 만든 다음 공유할 수 있어요.");
  }
  await saveDesign({ shared: e.target.checked });
  addSystemNote(e.target.checked ? "동아리 갤러리에 공유했어요. 🌐" : "공유를 취소했어요.");
});

async function saveDesign(patch) {
  if (!state.design) return;
  await api(`/api/designs/${state.design.id}`, { method: "PATCH", body: patch });
  Object.assign(state.design, patch);
  const item = state.designs.find((d) => d.id === state.design.id);
  if (item) Object.assign(item, patch);
  renderDesignSelect();
}

// ---------- 대화 ----------

function renderExamples() {
  $("#examples").innerHTML = EXAMPLES.map((t) => `<button type="button" class="example">${escapeHtml(t)}</button>`).join("");
  $("#examples").querySelectorAll(".example").forEach((btn) =>
    btn.addEventListener("click", () => {
      $("#chat-input").value = btn.textContent;
      $("#chat-input").focus();
    }),
  );
}

function renderChat() {
  const log = $("#chat-log");
  log.innerHTML = "";
  const chat = state.design.chat || [];
  $("#examples").hidden = chat.length > 0;
  if (!chat.length) {
    log.innerHTML = `<div class="empty-chat">
      <h3>무엇을 만들어 볼까요?</h3>
      <p>크기(cm), 모양, 용도, 새길 글자 등을 자세히 쓸수록 원하는 결과가 나와요.<br/>
      결과를 보고 "더 두껍게", "구멍을 하나 더" 처럼 계속 고쳐 달라고 할 수 있어요.</p></div>`;
    return;
  }
  for (const m of chat) {
    if (m.role === "user") addUserBubble(m.text, m.kind, m.images);
    else addAiBubble().setFinal(m.text);
  }
  scrollChat();
}

function addUserBubble(text, kind, images = []) {
  const el = document.createElement("div");
  el.className = `msg user${kind === "fix" ? " fix" : ""}`;
  if (images?.length) el.appendChild(imageStrip(images));
  el.append(kind === "fix" ? "🔧 렌더링 오류를 AI에게 자동으로 알려 고치는 중이에요." : text);
  $("#chat-log").appendChild(el);
  scrollChat();
}

function addSystemNote(text, cls = "system") {
  const el = document.createElement("div");
  el.className = `msg ${cls}`;
  el.textContent = text;
  $("#chat-log").appendChild(el);
  scrollChat();
}

function addAiBubble() {
  const el = document.createElement("div");
  el.className = "msg ai";
  const thinking = document.createElement("details");
  thinking.className = "thinking";
  thinking.hidden = true;
  thinking.innerHTML = `<summary>💭 AI의 생각 과정</summary><div></div>`;
  const body = document.createElement("div");
  el.append(thinking, body);
  $("#chat-log").appendChild(el);
  let text = "";
  return {
    status(msg) {
      body.innerHTML = `<p class="muted typing">${escapeHtml(msg)}</p>`;
    },
    thinking(delta) {
      thinking.hidden = false;
      thinking.querySelector("div").textContent += delta;
    },
    append(delta) {
      text += delta;
      body.innerHTML = renderMarkdown(text, { streaming: true });
      scrollChat();
    },
    setFinal(full) {
      body.innerHTML = renderMarkdown(full);
    },
    remove() {
      el.remove();
    },
  };
}

function scrollChat() {
  const log = $("#chat-log");
  log.scrollTop = log.scrollHeight;
}

$("#chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("#chat-input").value.trim();
  const images = state.attachments;
  if ((!text && !images.length) || state.busy) return;
  $("#chat-input").value = "";
  state.attachments = [];
  renderAttachments();
  state.fixAttempts = 0;
  sendMessage(text || "첨부한 이미지를 참고해서 3D 프린트용 도안을 만들어 줘.", "user", images);
});

// ---------- 참고 이미지 첨부 ----------

const MAX_IMAGES = 3;
const MAX_EDGE = 1568; // Claude가 이미지를 가장 효율적으로 보는 긴 변 크기

// 사진을 줄이고 JPEG로 바꿔서 용량을 줄인다. (투명 배경은 흰색으로)
async function shrinkImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.85);
}

async function addAttachments(files) {
  const images = [...files].filter((f) => f.type.startsWith("image/"));
  if (!images.length) return;
  const room = MAX_IMAGES - state.attachments.length;
  if (images.length > room) addSystemNote(`참고 이미지는 한 번에 ${MAX_IMAGES}장까지 넣을 수 있어요.`, "error");
  for (const file of images.slice(0, Math.max(0, room))) {
    try {
      state.attachments.push(await shrinkImage(file));
    } catch {
      addSystemNote(`'${file.name}' 이미지를 읽지 못했어요. (HEIC 사진이라면 JPG로 바꿔서 넣어 주세요)`, "error");
    }
  }
  renderAttachments();
}

function renderAttachments() {
  const list = $("#attach-list");
  list.hidden = !state.attachments.length;
  list.innerHTML = state.attachments
    .map((url, i) => `<div class="attach-item"><img src="${url}" alt="" /><button type="button" data-i="${i}" title="빼기">✕</button></div>`)
    .join("");
  list.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      state.attachments.splice(Number(b.dataset.i), 1);
      renderAttachments();
    }),
  );
}

function imageStrip(images) {
  const wrap = document.createElement("div");
  wrap.className = "msg-images";
  for (const url of images) {
    const img = document.createElement("img");
    img.src = url;
    img.alt = "참고 이미지";
    img.addEventListener("click", () => img.classList.toggle("zoom"));
    wrap.appendChild(img);
  }
  return wrap;
}

$("#image-input").addEventListener("change", async (e) => {
  await addAttachments(e.target.files);
  e.target.value = "";
});

$("#chat-input").addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.some((f) => f.type.startsWith("image/"))) {
    e.preventDefault();
    addAttachments(files);
  }
});

const chatForm = $("#chat-form");
chatForm.addEventListener("dragover", (e) => {
  if (![...e.dataTransfer.types].includes("Files")) return;
  e.preventDefault();
  chatForm.classList.add("dragover");
});
chatForm.addEventListener("dragleave", () => chatForm.classList.remove("dragover"));
chatForm.addEventListener("drop", (e) => {
  e.preventDefault();
  chatForm.classList.remove("dragover");
  addAttachments(e.dataTransfer.files);
});

$("#chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("#chat-form").requestSubmit();
  }
});

function setBusy(busy) {
  state.busy = busy;
  $("#send-btn").disabled = busy;
  $("#rerender-btn").disabled = busy;
  $("#new-design-btn").disabled = busy;
  $("#send-btn").textContent = busy ? "생성 중…" : "보내기";
}

async function sendMessage(text, kind, images = []) {
  if (!state.design.chat.length) $("#chat-log").innerHTML = "";
  $("#examples").hidden = true;
  addUserBubble(text, kind, images);
  const bubble = addAiBubble();
  bubble.status("요청을 보내는 중…");
  setBusy(true);

  const designId = state.design.id;
  const editorCode = $("#code-editor").value;
  let done = null;
  try {
    const res = await fetch(`/api/designs/${designId}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${state.token}` },
      body: JSON.stringify({ message: text, kind, currentCode: editorCode, images }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `오류 (${res.status})`);
    }
    for await (const { event, data } of readSse(res)) {
      if (event === "status") bubble.status(data.message);
      else if (event === "thinking_start") bubble.status("구상하는 중…");
      else if (event === "thinking") bubble.thinking(data.text);
      else if (event === "text") bubble.append(data.text);
      else if (event === "error") throw new Error(data.message);
      else if (event === "done") done = data;
    }
    if (!done) throw new Error("응답이 중간에 끊겼어요. 다시 시도해 주세요.");
  } catch (err) {
    bubble.remove();
    addSystemNote(err.message, "error");
    // 실패하면 첨부했던 이미지를 다시 넣어 두어 바로 재시도할 수 있게 한다.
    if (images.length && !state.attachments.length) {
      state.attachments = images;
      renderAttachments();
    }
    setBusy(false);
    return;
  }

  bubble.setFinal(done.text);
  state.design.chat.push({ role: "user", kind, text, images }, { role: "assistant", text: done.text });
  updateUsage(done.usedToday);
  if (done.title !== state.design.title) {
    state.design.title = done.title;
    $("#title-input").value = done.title;
    const item = state.designs.find((d) => d.id === designId);
    if (item) item.title = done.title;
    renderDesignSelect();
  }
  if (done.truncated) addSystemNote("답변이 너무 길어서 중간에 잘렸어요. '코드를 더 간단하게 다시 써 줘'라고 요청해 보세요.", "error");
  setBusy(false);

  if (done.code && state.design?.id === designId) {
    state.design.code = done.code;
    $("#code-editor").value = done.code;
    await buildModel(done.code, { autoFix: true, saveThumb: true });
  }
}

async function* readSse(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      let data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (data) yield { event, data: JSON.parse(data) };
    }
  }
}

// ---------- 3D 모델 만들기 ----------

function showOverlay(html, busy = false) {
  const o = $("#viewer-overlay");
  o.hidden = !html;
  o.classList.toggle("busy", busy);
  o.innerHTML = html ? `<p>${html}</p>` : "";
}

function setStatus(text, cls = "") {
  const el = $("#render-status");
  el.textContent = text;
  el.className = `render-status ${cls}`;
}

async function buildModel(code, { autoFix, saveThumb }) {
  const designId = state.design.id;
  showOverlay("3D 모델을 만드는 중…", true);
  setStatus("렌더링 중…");
  $("#download-btn").disabled = true;
  $("#rerender-btn").disabled = true;
  const result = await renderScad(code);
  $("#rerender-btn").disabled = state.busy;
  if (state.design?.id !== designId) return; // 그새 다른 도안으로 바꿈

  if (!result.ok) {
    state.stl = null;
    state.viewer.clear();
    $("#size-info").hidden = true;
    showOverlay("모델을 만들지 못했어요 😥");
    setStatus("렌더링 실패", "bad");
    if (autoFix && state.fixAttempts < 2) {
      state.fixAttempts++;
      const msg = `방금 코드를 OpenSCAD로 렌더링했더니 오류가 났어. 원인을 찾아서 고친 전체 코드를 다시 줘.\n\n오류 내용:\n${result.error.slice(0, 2000)}`;
      return sendMessage(msg, "fix");
    }
    addSystemNote(`렌더링 오류: ${result.error.slice(0, 300)}`, "error");
    return;
  }

  state.stl = result.stl;
  showOverlay("");
  const info = state.viewer.showStl(result.stl);
  showSizeInfo($("#size-info"), info);
  setStatus(`완성! (${(result.ms / 1000).toFixed(1)}초)`, "ok");
  $("#download-btn").disabled = false;

  if (saveThumb) {
    // 화면이 한 번 그려진 다음 미리보기 이미지를 찍는다.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const thumbnail = state.viewer.snapshot();
    await api(`/api/designs/${designId}`, { method: "PATCH", body: { thumbnail, code } }).catch(() => {});
  }
}

function showSizeInfo(el, info) {
  const fmt = (n) => n.toFixed(1);
  const max = Math.max(info.x, info.y, info.z);
  let fit;
  if (max > PLATE) fit = `<span class="bad">⚠ 출력판(256mm)보다 커요!</span>`;
  else if (max > 120) fit = `<span class="warn">출력 가능 · 크기가 커서 오래 걸릴 수 있어요</span>`;
  else fit = `<span class="ok">✓ P2S / X2D 출력 가능</span>`;
  let base = "";
  if (info.minZ < -0.05) base = `<br/><span class="warn">바닥이 z=0 아래로 내려가 있어요</span>`;
  else if (info.minZ > 0.5) base = `<br/><span class="warn">모델이 바닥에서 떠 있어요</span>`;
  el.innerHTML = `크기: <b>${fmt(info.x)} × ${fmt(info.y)} × ${fmt(info.z)} mm</b><br/>${fit}${base}`;
  el.hidden = false;
}

$("#code-toggle-btn").addEventListener("click", () => {
  $("#code-panel").hidden = !$("#code-panel").hidden;
});

$("#rerender-btn").addEventListener("click", async () => {
  const code = $("#code-editor").value;
  if (!code.trim() || state.busy) return;
  state.design.code = code;
  await buildModel(code, { autoFix: false, saveThumb: true });
});

$("#download-btn").addEventListener("click", () => {
  if (!state.stl) return;
  downloadStl(state.stl, `${state.me.studentNo}_${state.me.name}_${state.design.title}`);
});

function downloadStl(stl, name) {
  const blob = new Blob([stl], { type: "model/stl" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${name.replace(/[\\/:*?"<>|]/g, "_")}.stl`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- 동아리 갤러리 ----------

async function loadGallery() {
  try {
    const { club, designs } = await api("/api/club/designs");
    $("#gallery-title").textContent = `${club} 갤러리`;
    const grid = $("#gallery-grid");
    if (!designs.length) {
      grid.innerHTML = `<div class="gallery-empty">아직 공유된 작품이 없어요. 작업실에서 '동아리에 공유'를 켜 보세요!</div>`;
      return;
    }
    grid.innerHTML = designs
      .map(
        (d) => `<button class="card${d.owner?.studentNo === state.me.studentNo ? " mine" : ""}" data-id="${d.id}">
          ${d.thumbnail ? `<img src="${d.thumbnail}" alt="" loading="lazy" />` : `<div class="no-thumb">미리보기 없음</div>`}
          <div class="card-body"><strong>${escapeHtml(d.title)}</strong>
          <span>${escapeHtml(d.owner?.name || "")} · ${timeAgo(d.updatedAt)}</span></div>
        </button>`,
      )
      .join("");
    grid.querySelectorAll(".card").forEach((c) => c.addEventListener("click", () => openDetail(c.dataset.id)));
  } catch (err) {
    $("#gallery-grid").innerHTML = `<div class="gallery-empty">${escapeHtml(err.message)}</div>`;
  }
}

let detailViewer = null;
let detailStl = null;

async function openDetail(id) {
  const dialog = $("#detail-dialog");
  dialog.showModal();
  detailStl = null;
  $("#detail-download").disabled = true;
  $("#detail-size").hidden = true;
  const status = $("#detail-status");
  status.hidden = false;
  status.className = "viewer-overlay busy";
  status.innerHTML = "<p>불러오는 중…</p>";
  if (!detailViewer) detailViewer = new Viewer($("#detail-viewer"));
  detailViewer.clear();

  const { design } = await api(`/api/designs/${id}`);
  $("#detail-title").textContent = design.title;
  $("#detail-owner").textContent = `${design.owner.name} (${design.owner.studentNo}) · ${timeAgo(design.updatedAt)}`;
  const prompts = design.chat.filter((m) => m.role === "user" && m.kind !== "fix");
  $("#detail-prompts").innerHTML = prompts.length ? "" : `<li class="muted">코드를 직접 작성했어요.</li>`;
  for (const m of prompts) {
    const li = document.createElement("li");
    if (m.images?.length) li.appendChild(imageStrip(m.images));
    li.append(m.text);
    $("#detail-prompts").appendChild(li);
  }

  if (!design.code) {
    status.className = "viewer-overlay";
    status.innerHTML = "<p>아직 모델이 없어요.</p>";
    return;
  }
  status.innerHTML = "<p>3D 모델을 만드는 중…</p>";
  const result = await renderScad(design.code);
  if (!dialog.open) return;
  if (!result.ok) {
    status.className = "viewer-overlay";
    status.innerHTML = "<p>모델을 불러오지 못했어요.</p>";
    return;
  }
  status.hidden = true;
  detailStl = { stl: result.stl, name: `${design.owner.studentNo}_${design.owner.name}_${design.title}` };
  showSizeInfo($("#detail-size"), detailViewer.showStl(result.stl, { color: 0xf08a5d }));
  $("#detail-download").disabled = false;
}

$("#detail-close").addEventListener("click", () => $("#detail-dialog").close());
$("#detail-dialog").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close();
});
$("#detail-download").addEventListener("click", () => detailStl && downloadStl(detailStl.stl, detailStl.name));

// ---------- 유틸 ----------

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// AI 답변용 간단한 마크다운 변환. 코드 블록은 채팅창에서 숨기고 칩으로 표시한다.
function renderMarkdown(text, { streaming = false } = {}) {
  let src = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code) => `\u0000CODE${code.split("\n").length}\u0000`);
  // 아직 닫히지 않은 코드 블록 (스트리밍 중)
  src = src.replace(/```[^\n]*\n?([\s\S]*)$/, (_, code) => `\u0000OPEN${code.split("\n").length}\u0000`);

  const lines = escapeHtml(src).split("\n");
  let html = "";
  let inList = false;
  for (const raw of lines) {
    let line = raw
      .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\u0000CODE(\d+)\u0000/g, `<span class="code-chip">📦 OpenSCAD 코드 $1줄 → 오른쪽 3D 화면에 적용</span>`)
      .replace(/\u0000OPEN(\d+)\u0000/g, `<span class="code-chip typing">⌨️ 코드 작성 중… $1줄</span>`);
    const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
    if (li) {
      if (!inList) html += "<ul>";
      inList = true;
      html += `<li>${li[1]}</li>`;
      continue;
    }
    if (inList) {
      html += "</ul>";
      inList = false;
    }
    const h = line.match(/^#{1,4}\s+(.*)$/);
    if (h) html += `<h4>${h[1]}</h4>`;
    else if (line.trim()) html += `<p>${line}</p>`;
  }
  if (inList) html += "</ul>";
  if (streaming && !/OPEN/.test(src)) html += `<span class="typing"></span>`;
  return html;
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "방금 전";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return new Date(ts).toLocaleDateString("ko-KR");
}

init();
