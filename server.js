// 성광여고 AI 동아리 3D 프린트 도안 생성 서비스 - 서버
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./lib/env.js";
import { Store } from "./lib/store.js";
import { SupabaseStore } from "./lib/supabase-store.js";
import { SYSTEM_PROMPT } from "./lib/prompt.js";

loadEnv();

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const EFFORT = process.env.CLAUDE_EFFORT || "medium";
const ACCESS_CODE = process.env.ACCESS_CODE || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const DAILY_LIMIT = Number(process.env.DAILY_MESSAGE_LIMIT || 40);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 8);
const CLUBS = (process.env.CLUBS || "AI 동아리 1,AI 동아리 2,AI 동아리 3")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn("⚠️  ANTHROPIC_API_KEY 가 설정되지 않았습니다. .env 파일을 확인하세요.");
}

const client = new Anthropic({ maxRetries: 4 });

// SUPABASE_URL 이 있으면 Supabase, 없으면 로컬 JSON 파일에 저장한다.
const store = process.env.SUPABASE_URL
  ? new SupabaseStore(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : new Store(path.join(here, "data", "db.json"));

const app = express();
app.use(express.json({ limit: "12mb" }));
app.use(express.static(path.join(here, "public")));
app.use("/vendor/three", express.static(path.join(here, "node_modules", "three")));
app.use(
  "/vendor/openscad",
  express.static(path.join(here, "node_modules", "openscad-wasm-prebuilt", "dist"), {
    maxAge: "7d",
  }),
);

// ---------- 공통 ----------

const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });

async function auth(req, res, next) {
  const token = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const student = token ? await store.findStudentByToken(token) : null;
  if (!student) return res.status(401).json({ error: "다시 로그인해 주세요." });
  req.student = student;
  next();
}

function publicStudent(s) {
  return { id: s.id, name: s.name, studentNo: s.studentNo, club: s.club };
}

function usedToday(s) {
  return s.usage?.date === today() ? s.usage.count : 0;
}

function designSummary(d) {
  return {
    id: d.id,
    title: d.title,
    shared: d.shared,
    thumbnail: d.thumbnail || null,
    hasCode: Boolean(d.code),
    updatedAt: d.updatedAt,
    createdAt: d.createdAt,
    owner: d.owner,
  };
}

const busyDesigns = new Set();

// 동시에 너무 많은 요청이 API로 몰리지 않도록 하는 간단한 대기열
let running = 0;
const waiting = [];
function acquireSlot() {
  if (running < MAX_CONCURRENT) {
    running++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}
function releaseSlot() {
  const next = waiting.shift();
  if (next) next();
  else running--;
}

// ---------- 로그인 ----------

app.get("/api/config", (req, res) => {
  res.json({ clubs: CLUBS, needsAccessCode: Boolean(ACCESS_CODE), dailyLimit: DAILY_LIMIT });
});

app.post("/api/login", async (req, res) => {
  const name = String(req.body.name || "").trim();
  const studentNo = String(req.body.studentNo || "").trim();
  const club = String(req.body.club || "").trim();
  const code = String(req.body.accessCode || "").trim();

  if (ACCESS_CODE && code !== ACCESS_CODE) return res.status(403).json({ error: "입장 코드가 올바르지 않습니다." });
  if (!name || name.length > 20) return res.status(400).json({ error: "이름을 입력해 주세요." });
  if (!/^\d{4,6}$/.test(studentNo)) return res.status(400).json({ error: "학번은 숫자 4~6자리로 입력해 주세요. (예: 20315)" });
  if (!CLUBS.includes(club)) return res.status(400).json({ error: "동아리를 선택해 주세요." });

  let student = await store.findStudentByNo(studentNo);
  if (!student) student = await store.addStudent({ name, studentNo, club });
  if (student.name !== name) {
    return res.status(409).json({ error: "이미 다른 이름으로 등록된 학번입니다. 선생님께 문의하세요." });
  }
  if (student.club !== club) {
    return res.status(409).json({ error: `이 학번은 '${student.club}' 동아리로 등록되어 있습니다.` });
  }
  const token = crypto.randomBytes(24).toString("hex");
  await store.addToken(student.id, token);
  res.json({ token, student: publicStudent(student) });
});

app.get("/api/me", auth, (req, res) => {
  res.json({
    student: publicStudent(req.student),
    usedToday: usedToday(req.student),
    dailyLimit: DAILY_LIMIT,
  });
});

// ---------- 내 도안 ----------

app.get("/api/designs", auth, async (req, res) => {
  const list = (await store.designsByOwner(req.student.id)).map((d) => designSummary(d));
  res.json({ designs: list });
});

app.post("/api/designs", auth, async (req, res) => {
  const d = await store.addDesign({ ownerId: req.student.id, club: req.student.club, title: "새 도안" });
  res.json({ design: designSummary(d) });
});

async function loadDesignFor(req, res, { allowClub = false } = {}) {
  const d = await store.getDesign(req.params.id);
  if (!d) {
    res.status(404).json({ error: "도안을 찾을 수 없습니다." });
    return null;
  }
  const mine = d.ownerId === req.student.id;
  const clubVisible = allowClub && d.shared && d.club === req.student.club;
  if (!mine && !clubVisible) {
    res.status(403).json({ error: "볼 수 없는 도안입니다." });
    return null;
  }
  return d;
}

app.get("/api/designs/:id", auth, async (req, res) => {
  const d = await loadDesignFor(req, res, { allowClub: true });
  if (!d) return;
  const owner = await store.getStudent(d.ownerId);
  res.json({
    design: {
      ...designSummary(d),
      owner: { name: owner.name, studentNo: owner.studentNo },
      code: d.code,
      chat: d.chat,
      mine: d.ownerId === req.student.id,
    },
  });
});

app.patch("/api/designs/:id", auth, async (req, res) => {
  const d = await loadDesignFor(req, res);
  if (!d) return;
  const patch = {};
  if (typeof req.body.title === "string") patch.title = req.body.title.trim().slice(0, 40) || "새 도안";
  if (typeof req.body.code === "string") patch.code = req.body.code.slice(0, 100_000);
  if (typeof req.body.shared === "boolean") patch.shared = req.body.shared;
  if (typeof req.body.thumbnail === "string" && req.body.thumbnail.startsWith("data:image/")) {
    patch.thumbnail = req.body.thumbnail.slice(0, 600_000);
  }
  await store.updateDesign(d.id, patch);
  res.json({ ok: true });
});

app.delete("/api/designs/:id", auth, async (req, res) => {
  const d = await loadDesignFor(req, res);
  if (!d) return;
  await store.deleteDesign(d.id);
  res.json({ ok: true });
});

// ---------- 동아리 갤러리 ----------

app.get("/api/club/designs", auth, async (req, res) => {
  const list = (await store.sharedDesignsInClub(req.student.club)).map((d) => designSummary(d));
  res.json({ club: req.student.club, designs: list });
});

// ---------- Claude 대화 (SSE 스트리밍) ----------

app.post("/api/designs/:id/chat", auth, async (req, res) => {
  const d = await loadDesignFor(req, res);
  if (!d) return;
  const kind = req.body.kind === "fix" ? "fix" : "user";
  const images = kind === "user" ? parseImages(req.body.images) : [];
  if (Array.isArray(req.body.images) && req.body.images.length && !images.length) {
    return res.status(400).json({ error: "이미지를 읽을 수 없어요. 다른 사진으로 시도해 보세요." });
  }
  let text = String(req.body.message || "").trim().slice(0, 4000);
  if (!text && images.length) text = "첨부한 이미지를 참고해서 3D 프린트용 도안을 만들어 줘.";
  if (!text) return res.status(400).json({ error: "메시지를 입력해 주세요." });

  const student = req.student;
  if (usedToday(student) >= DAILY_LIMIT) {
    return res.status(429).json({ error: `오늘 사용 가능한 요청 ${DAILY_LIMIT}회를 모두 사용했어요.` });
  }
  if (busyDesigns.has(d.id)) return res.status(409).json({ error: "이전 요청을 처리하는 중이에요. 잠시만 기다려 주세요." });
  busyDesigns.add(d.id);

  let used;
  try {
    used = await store.countUsage(student.id, today());
  } catch (err) {
    busyDesigns.delete(d.id);
    throw err;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const keepAlive = setInterval(() => res.write(": ping\n\n"), 15000);

  // 학생이 직접 코드를 수정했다면, 그 코드를 기준으로 수정하도록 알려 준다.
  let content = text;
  if (kind === "user" && typeof req.body.currentCode === "string" && req.body.currentCode.trim() &&
      req.body.currentCode !== d.lastAssistantCode) {
    content = `${text}\n\n(참고: 내가 코드를 직접 수정했어. 지금 코드는 아래와 같아. 이걸 기준으로 고쳐 줘.)\n\`\`\`openscad\n${req.body.currentCode.slice(0, 30_000)}\n\`\`\``;
  }
  // 이미지는 텍스트보다 앞에 두는 것이 권장된다.
  const userMsg = images.length
    ? {
        role: "user",
        content: [
          ...images.map((img) => ({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } })),
          { type: "text", text: content },
        ],
      }
    : { role: "user", content };
  const messages = [...d.messages, userMsg];

  if (running >= MAX_CONCURRENT) send("status", { message: "다른 친구들의 요청을 처리하는 중이에요. 잠시 기다려 주세요…" });
  await acquireSlot();
  send("status", { message: "Claude가 도안을 구상하고 있어요…" });

  try {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      cache_control: { type: "ephemeral" },
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: EFFORT },
      system: SYSTEM_PROMPT,
      messages,
    });

    res.on("close", () => {
      if (!res.writableEnded) stream.abort();
    });

    for await (const event of stream) {
      if (event.type === "content_block_start" && event.content_block.type === "thinking") {
        send("thinking_start", {});
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") send("text", { text: event.delta.text });
        else if (event.delta.type === "thinking_delta") send("thinking", { text: event.delta.thinking });
      }
    }
    const final = await stream.finalMessage();

    if (final.stop_reason === "refusal") {
      send("error", { message: "이 요청은 처리할 수 없어요. 다른 표현으로 다시 요청해 보세요." });
      return;
    }

    const replyText = final.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    const code = extractCode(replyText);

    const chat = [
      ...d.chat,
      { role: "user", kind, text, at: Date.now(), ...(images.length ? { images: images.map((img) => img.url) } : {}) },
      { role: "assistant", text: replyText, at: Date.now(), truncated: final.stop_reason === "max_tokens" },
    ];
    const patch = {
      // 생각(thinking) 블록 포함 응답 전체를 그대로 저장해서 다음 요청에 그대로 다시 보낸다.
      messages: [...messages, { role: "assistant", content: final.content }],
      chat,
    };
    if (code) {
      patch.code = code;
      patch.lastAssistantCode = code;
    }
    if (d.title === "새 도안" && kind === "user") patch.title = text.replace(/\s+/g, " ").slice(0, 24);
    await store.updateDesign(d.id, patch);
    await store.addTokenUsage(student.id, final.usage);

    send("done", {
      text: replyText,
      code: code || null,
      title: patch.title || d.title,
      truncated: final.stop_reason === "max_tokens",
      usedToday: used,
    });
  } catch (err) {
    console.error("[chat error]", err?.status, err?.message);
    let message = "AI 서버와 통신 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.";
    if (err instanceof Anthropic.RateLimitError) message = "지금 요청이 너무 많아요. 30초 정도 후에 다시 시도해 주세요.";
    else if (err instanceof Anthropic.AuthenticationError) message = "서버의 API 키 설정에 문제가 있어요. 선생님께 알려 주세요.";
    else if (err instanceof Anthropic.APIUserAbortError) message = "요청이 취소되었어요.";
    // 실패한 요청은 하루 사용 횟수에서 빼 준다.
    await store.countUsage(student.id, today(), -1).catch(() => {});
    if (!res.writableEnded) send("error", { message });
  } finally {
    busyDesigns.delete(d.id);
    releaseSlot();
    clearInterval(keepAlive);
    if (!res.writableEnded) res.end();
  }
});

// 참고 이미지: 브라우저에서 줄여서 보낸 data URL 을 검사한다. (최대 3장, 장당 약 2MB)
const MAX_IMAGES = 3;
function parseImages(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_IMAGES).flatMap((url) => {
    const m = typeof url === "string" && url.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
    if (!m || m[2].length > 2_800_000) return [];
    return [{ url, mediaType: m[1], data: m[2] }];
  });
}

function extractCode(text) {
  const blocks = [...text.matchAll(/```(?:openscad|scad)?[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  if (!blocks.length) return "";
  return blocks.sort((a, b) => b.length - a.length)[0].trim();
}

// ---------- 관리자 ----------

function adminOnly(req, res, next) {
  if (!ADMIN_PASSWORD || req.get("x-admin-password") !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: "관리자 비밀번호가 올바르지 않습니다." });
  }
  next();
}

app.get("/api/admin/summary", adminOnly, async (req, res) => {
  res.json(await store.adminSummary(today(), { model: MODEL }));
});

app.post("/api/admin/reset-usage", adminOnly, async (req, res) => {
  await store.resetUsage(String(req.body.studentId || ""));
  res.json({ ok: true });
});

// 처리되지 않은 오류 (DB 연결 문제 등)
app.use((err, req, res, next) => {
  console.error("[server error]", err);
  if (res.headersSent) return res.end();
  res.status(500).json({ error: "서버에 문제가 생겼어요. 잠시 후 다시 시도해 주세요." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ 서버 실행 중: http://localhost:${PORT}`);
  console.log(`   저장소: ${process.env.SUPABASE_URL ? "Supabase" : "로컬 JSON 파일 (data/db.json)"}`);
  console.log(`   모델: ${MODEL} (effort: ${EFFORT}) / 동아리: ${CLUBS.join(", ")}`);
});
