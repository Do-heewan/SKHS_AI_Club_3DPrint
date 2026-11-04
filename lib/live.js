// 관리자 실시간 현황판: 학생들이 지금 무엇을 하고 있는지 서버 메모리에만 기록한다.
// DB 에 쓰지 않으므로 서버가 다시 켜지면(Render 가 잠들었다 깨면) 비워진다.

export const ONLINE_MS = 90_000; // 학생 화면은 30초마다 접속 신호를 보낸다. (뒤에 깔린 탭은 1분까지 늦어질 수 있음)
const MAX_EVENTS = 300; // 서버에 남겨 두는 활동 기록 수
const SNAPSHOT_EVENTS = 80; // 현황판에 한 번에 보내는 활동 기록 수

export class Live {
  constructor(now = Date.now) {
    this.now = now;
    this.boot = now(); // 서버가 켜진 시각. 이 값이 바뀌면 현황판이 활동 기록을 처음부터 다시 그린다.
    this.seq = 0;
    this.events = [];
    this.students = new Map(); // 학생 id -> { seenAt, tab, designId, generating, prompt, problem }
  }

  state(id) {
    if (!this.students.has(id)) this.students.set(id, {});
    return this.students.get(id);
  }

  // 학생이 서버에 요청을 보낼 때마다. presence 는 학생 화면이 알려 주는 { tab, designId }
  seen(student, presence) {
    Object.assign(this.state(student.id), presence, { seenAt: this.now() });
  }

  // 활동을 기록하고, 종류에 따라 학생 상태(생성 중, 도움 필요)를 바꾼다.
  log(student, type, { text = "", design = null, images = 0, queued = false } = {}) {
    const s = this.state(student.id);
    if (type === "limit" && s.problem?.type === "limit") return; // 한도에 걸린 뒤 계속 눌러도 한 번만 기록
    const at = this.now();
    text = String(text).slice(0, 300);
    switch (type) {
      case "prompt":
      case "fix":
        s.generating = { designId: design?.id ?? null, since: at, kind: type, queued };
        if (type === "prompt") s.prompt = { text, at, images };
        s.problem = null;
        break;
      case "done":
      case "cancel":
        s.generating = null;
        break;
      case "error":
      case "refusal":
        s.generating = null;
        s.problem = { type, message: text, at };
        break;
      case "render_fail":
      case "limit":
        s.problem = { type, message: text, at };
        break;
      case "render_ok":
        if (s.problem?.type !== "limit") s.problem = null;
        break;
    }
    this.events.push({
      id: ++this.seq,
      at,
      type,
      studentId: student.id,
      name: student.name,
      club: student.club,
      text,
      images,
      designId: design?.id ?? null,
      title: design?.title ?? "",
    });
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }

  // 대기열에서 나와 Claude 에게 보내기 시작함
  started(student) {
    const g = this.students.get(student.id)?.generating;
    if (g) g.queued = false;
  }
}

// 현황판 화면에 보낼 동아리별 현황. students, designs 는 store.liveData() 결과 (미리보기 이미지는 따로 받아 감)
export function liveSnapshot(live, { clubs, students, designs, dailyLimit, queue }) {
  const now = live.now();
  const sum = (list, f) => list.reduce((n, x) => n + f(x), 0);
  const names = new Map(students.map((s) => [s.id, s.name]));
  const byOwner = new Map();
  for (const d of [...designs].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (!byOwner.has(d.ownerId)) byOwner.set(d.ownerId, []);
    byOwner.get(d.ownerId).push(d);
  }

  const rows = students.map((s) => {
    const m = live.students.get(s.id) || {};
    const mine = byOwner.get(s.id) || [];
    // 지금 생성 중인 도안 > 화면에 열어 둔 도안 > 가장 최근에 고친 도안 (남의 도안 id 는 무시된다)
    const find = (id) => id && mine.find((d) => d.id === id);
    const current = find(m.generating?.designId) || find(m.designId) || mine[0];
    let status = "offline";
    if (m.generating) status = m.generating.queued ? "queued" : "generating";
    else if (m.seenAt && now - m.seenAt < ONLINE_MS) status = "online";
    else if (m.seenAt) status = "away";
    return {
      id: s.id,
      name: s.name,
      studentNo: s.studentNo,
      club: s.club,
      status,
      seenAt: m.seenAt || null,
      tab: m.tab || null,
      today: s.today,
      generating: m.generating || null,
      current: current
        ? { id: current.id, title: current.title, shared: current.shared, source: current.source, updatedAt: current.updatedAt }
        : null,
      prompt: m.prompt || null,
      problem: m.problem || null,
    };
  });

  // CLUBS 순서대로. 목록에 없는 이름(동아리 이름만 바꾸고 DB 는 그대로 둔 경우 등)은 뒤에 따로 보여 준다.
  const extra = [...new Set(students.map((s) => s.club))].filter((c) => !clubs.includes(c));
  const groups = [...clubs, ...extra].map((club) => {
    const members = rows.filter((r) => r.club === club).sort((a, b) => a.studentNo.localeCompare(b.studentNo));
    const shared = designs.filter((d) => d.club === club && d.shared);
    const top = [...shared].sort((a, b) => b.likes - a.likes || a.updatedAt - b.updatedAt)[0];
    return {
      club,
      listed: clubs.includes(club),
      online: members.filter((r) => r.status !== "away" && r.status !== "offline").length,
      working: members.filter((r) => r.generating).length,
      today: sum(members, (r) => r.today),
      shared: shared.length,
      likes: sum(shared, (d) => d.likes),
      top: top?.likes ? { id: top.id, title: top.title, likes: top.likes, owner: names.get(top.ownerId) || "" } : null,
      members,
    };
  });

  return {
    now,
    boot: live.boot,
    dailyLimit,
    queue,
    clubs: groups,
    events: live.events.slice(-SNAPSHOT_EVENTS).reverse(),
  };
}
