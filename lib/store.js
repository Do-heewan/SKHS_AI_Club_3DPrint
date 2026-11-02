import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// 로컬 테스트용 JSON 파일 저장소 (SUPABASE_URL 이 없을 때 사용).
// 메서드 모양은 lib/supabase-store.js 와 같다.
export class Store {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.data = { students: [], designs: [] };
    if (fs.existsSync(file)) {
      this.data = JSON.parse(fs.readFileSync(file, "utf8"));
    }
    this.data.likes ||= [];
    this.timer = null;
    const flush = () => this.flushSync();
    process.on("SIGINT", () => (flush(), process.exit(0)));
    process.on("SIGTERM", () => (flush(), process.exit(0)));
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushSync();
    }, 300);
  }

  flushSync() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  // ----- 학생 -----
  async findStudentByNo(studentNo) {
    return this.data.students.find((s) => s.studentNo === studentNo) || null;
  }
  async findStudentByToken(token) {
    return this.data.students.find((s) => s.tokens.includes(token)) || null;
  }
  async getStudent(id) {
    return this.data.students.find((s) => s.id === id) || null;
  }
  async addStudent({ name, studentNo, club }) {
    const s = {
      id: crypto.randomUUID(),
      name,
      studentNo,
      club,
      tokens: [],
      usage: { date: null, count: 0 },
      totalRequests: 0,
      tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    this.data.students.push(s);
    this.save();
    return s;
  }
  async addToken(id, token) {
    const s = await this.getStudent(id);
    s.tokens = [...s.tokens.slice(-9), token];
    this.save();
  }
  async countUsage(id, date, delta = 1) {
    const s = await this.getStudent(id);
    if (s.usage?.date !== date) s.usage = { date, count: 0 };
    s.usage.count = Math.max(0, s.usage.count + delta);
    s.totalRequests = Math.max(0, (s.totalRequests || 0) + delta);
    this.save();
    return s.usage.count;
  }
  async addTokenUsage(id, usage) {
    const s = await this.getStudent(id);
    const t = (s.tokenUsage ||= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    t.input += usage.input_tokens || 0;
    t.output += usage.output_tokens || 0;
    t.cacheRead += usage.cache_read_input_tokens || 0;
    t.cacheWrite += usage.cache_creation_input_tokens || 0;
    this.save();
  }
  async resetUsage(id) {
    for (const s of this.data.students) {
      if (!id || s.id === id) s.usage = { date: s.usage?.date, count: 0 };
    }
    this.save();
  }

  // ----- 도안 -----
  async getDesign(id) {
    return this.data.designs.find((d) => d.id === id) || null;
  }
  async designsByOwner(ownerId) {
    return this.data.designs.filter((d) => d.ownerId === ownerId).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async sharedDesignsInClub(club) {
    return this.data.designs
      .filter((d) => d.club === club && d.shared)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((d) => {
        const o = this.data.students.find((s) => s.id === d.ownerId);
        return { ...d, owner: o && { name: o.name, studentNo: o.studentNo }, likedBy: this.likedBySync(d.id) };
      });
  }
  async allSharedDesigns() {
    const clubs = [...new Set(this.data.designs.map((d) => d.club))];
    return (await Promise.all(clubs.map((c) => this.sharedDesignsInClub(c)))).flat();
  }
  async addDesign({ ownerId, club, title }) {
    const d = {
      id: crypto.randomUUID(),
      ownerId,
      club,
      title,
      messages: [],
      chat: [],
      code: "",
      lastAssistantCode: "",
      thumbnail: null,
      shared: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.data.designs.push(d);
    this.save();
    return d;
  }
  async updateDesign(id, patch) {
    const d = await this.getDesign(id);
    Object.assign(d, patch, { updatedAt: Date.now() });
    this.save();
  }
  async deleteDesign(id) {
    this.data.designs = this.data.designs.filter((d) => d.id !== id);
    this.data.likes = this.data.likes.filter((l) => l.designId !== id);
    this.save();
  }

  // ----- 좋아요 -----
  likedBySync(designId) {
    return this.data.likes.filter((l) => l.designId === designId).map((l) => l.studentId);
  }
  async likedBy(designId) {
    return this.likedBySync(designId);
  }
  async setLike(designId, studentId, on) {
    const has = this.data.likes.some((l) => l.designId === designId && l.studentId === studentId);
    if (on && !has) this.data.likes.push({ designId, studentId, at: Date.now() });
    if (!on && has) {
      this.data.likes = this.data.likes.filter((l) => !(l.designId === designId && l.studentId === studentId));
    }
    this.save();
    return this.likedBySync(designId);
  }

  // ----- 관리자 -----
  async adminSummary(date, { model }) {
    const students = this.data.students.map((s) => ({
      id: s.id,
      name: s.name,
      studentNo: s.studentNo,
      club: s.club,
      today: s.usage?.date === date ? s.usage.count : 0,
      totalRequests: s.totalRequests || 0,
      tokenUsage: s.tokenUsage || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      designs: this.data.designs.filter((d) => d.ownerId === s.id).length,
      shared: this.data.designs.filter((d) => d.ownerId === s.id && d.shared).length,
    }));
    return { model, date, students };
  }
}
