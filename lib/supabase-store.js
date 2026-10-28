import { createClient } from "@supabase/supabase-js";

// Supabase(Postgres) 저장소. 서버에서만 service_role 키로 접근한다.
// 메서드 모양은 lib/store.js(JSON 파일 저장소)와 같다.

const DESIGN_LIST_COLUMNS = "id, title, shared, thumbnail, code, created_at, updated_at";

function toStudent(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    studentNo: r.student_no,
    club: r.club,
    usage: { date: r.usage_date, count: r.usage_count },
    totalRequests: r.total_requests,
    tokenUsage: {
      input: Number(r.input_tokens),
      output: Number(r.output_tokens),
      cacheRead: Number(r.cache_read_tokens),
      cacheWrite: Number(r.cache_write_tokens),
    },
  };
}

function toDesign(r) {
  if (!r) return null;
  return {
    id: r.id,
    ownerId: r.owner_id,
    club: r.club,
    title: r.title,
    messages: r.messages,
    chat: r.chat,
    code: r.code,
    lastAssistantCode: r.last_assistant_code,
    thumbnail: r.thumbnail,
    shared: r.shared,
    createdAt: Date.parse(r.created_at),
    updatedAt: Date.parse(r.updated_at),
    owner: r.owner ? { name: r.owner.name, studentNo: r.owner.student_no } : undefined,
  };
}

const DESIGN_FIELDS = {
  title: "title",
  messages: "messages",
  chat: "chat",
  code: "code",
  lastAssistantCode: "last_assistant_code",
  thumbnail: "thumbnail",
  shared: "shared",
};

function check({ data, error }) {
  if (error) throw new Error(`[supabase] ${error.message}`);
  return data;
}

export class SupabaseStore {
  constructor(url, serviceKey) {
    this.db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  // ----- 학생 -----
  async findStudentByNo(studentNo) {
    return toStudent(check(await this.db.from("students").select("*").eq("student_no", studentNo).maybeSingle()));
  }
  async findStudentByToken(token) {
    const row = check(
      await this.db.from("sessions").select("student:students(*)").eq("token", token).maybeSingle(),
    );
    return toStudent(row?.student);
  }
  async getStudent(id) {
    return toStudent(check(await this.db.from("students").select("*").eq("id", id).maybeSingle()));
  }
  async addStudent(s) {
    const { data, error } = await this.db
      .from("students")
      .insert({ name: s.name, student_no: s.studentNo, club: s.club })
      .select("*")
      .single();
    // 같은 학번이 동시에 가입하면 먼저 들어간 쪽을 쓴다.
    if (error?.code === "23505") return this.findStudentByNo(s.studentNo);
    if (error) throw new Error(`[supabase] ${error.message}`);
    return toStudent(data);
  }
  async addToken(studentId, token) {
    check(await this.db.from("sessions").insert({ token, student_id: studentId }));
  }
  async countUsage(studentId, date, delta = 1) {
    return check(await this.db.rpc("increment_usage", { p_student_id: studentId, p_date: date, p_delta: delta }));
  }
  async addTokenUsage(studentId, usage) {
    check(
      await this.db.rpc("add_token_usage", {
        p_student_id: studentId,
        p_input: usage.input_tokens || 0,
        p_output: usage.output_tokens || 0,
        p_cache_read: usage.cache_read_input_tokens || 0,
        p_cache_write: usage.cache_creation_input_tokens || 0,
      }),
    );
  }
  async resetUsage(studentId) {
    let q = this.db.from("students").update({ usage_count: 0 });
    q = studentId ? q.eq("id", studentId) : q.not("id", "is", null);
    check(await q);
  }

  // ----- 도안 -----
  async getDesign(id) {
    return toDesign(check(await this.db.from("designs").select("*").eq("id", id).maybeSingle()));
  }
  async designsByOwner(ownerId) {
    const rows = check(
      await this.db
        .from("designs")
        .select(DESIGN_LIST_COLUMNS)
        .eq("owner_id", ownerId)
        .order("updated_at", { ascending: false }),
    );
    return rows.map(toDesign);
  }
  async sharedDesignsInClub(club) {
    const rows = check(
      await this.db
        .from("designs")
        .select(`${DESIGN_LIST_COLUMNS}, owner:students(name, student_no)`)
        .eq("club", club)
        .eq("shared", true)
        .order("updated_at", { ascending: false }),
    );
    return rows.map(toDesign);
  }
  async addDesign(d) {
    const row = check(
      await this.db
        .from("designs")
        .insert({ owner_id: d.ownerId, club: d.club, title: d.title })
        .select("*")
        .single(),
    );
    return toDesign(row);
  }
  async updateDesign(id, patch) {
    const row = { updated_at: new Date().toISOString() };
    for (const [key, col] of Object.entries(DESIGN_FIELDS)) {
      if (patch[key] !== undefined) row[col] = patch[key];
    }
    check(await this.db.from("designs").update(row).eq("id", id));
  }
  async deleteDesign(id) {
    check(await this.db.from("designs").delete().eq("id", id));
  }

  // ----- 관리자 -----
  async adminSummary(date, { model }) {
    const [students, designs] = await Promise.all([
      this.db.from("students").select("*").then(check),
      this.db.from("designs").select("owner_id, shared").then(check),
    ]);
    return {
      model,
      date,
      students: students.map(toStudent).map((s) => ({
        id: s.id,
        name: s.name,
        studentNo: s.studentNo,
        club: s.club,
        today: s.usage.date === date ? s.usage.count : 0,
        totalRequests: s.totalRequests,
        tokenUsage: s.tokenUsage,
        designs: designs.filter((d) => d.owner_id === s.id).length,
        shared: designs.filter((d) => d.owner_id === s.id && d.shared).length,
      })),
    };
  }
}
