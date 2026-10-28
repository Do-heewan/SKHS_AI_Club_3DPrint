// 워커를 감싸서 renderScad(code) → Promise 형태로 쓰게 해 주는 모듈
let worker = null;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (!worker) {
    worker = new Worker("/js/scad-worker.js", { type: "module" });
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      p.resolve(e.data);
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.resolve({ ok: false, error: e.message || "워커 오류" });
      pending.clear();
      worker = null;
    };
  }
  return worker;
}

const TIMEOUT_MS = 90_000;

export function renderScad(code) {
  const id = ++seq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // 너무 오래 걸리면 워커를 강제로 종료하고 새로 만든다.
      pending.delete(id);
      worker?.terminate();
      worker = null;
      resolve({ ok: false, error: "렌더링이 90초 넘게 걸려 중단했어요. 모양을 더 단순하게 바꿔 달라고 요청해 보세요.", timeout: true });
    }, TIMEOUT_MS);
    pending.set(id, {
      resolve: (r) => {
        clearTimeout(timer);
        resolve(r);
      },
    });
    getWorker().postMessage({ id, code });
  });
}
