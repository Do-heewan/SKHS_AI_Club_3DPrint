// OpenSCAD(WASM)로 코드를 STL로 바꾸는 웹 워커. 화면이 멈추지 않도록 별도 스레드에서 실행한다.
import { createOpenSCAD } from "/vendor/openscad/openscad.js";

let fontPromise = null;
const loadFont = () =>
  (fontPromise ||= fetch("/fonts/NanumGothic-Bold.ttf").then((r) => r.arrayBuffer()).then((b) => new Uint8Array(b)));

const FONTS_CONF = `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>/fonts</dir></fontconfig>`;

self.onmessage = async (e) => {
  const { id, code } = e.data;
  const log = [];
  try {
    const font = await loadFont();
    // callMain은 인스턴스당 한 번만 호출할 수 있어서 매번 새로 만든다.
    const scad = await createOpenSCAD({
      noInitialRun: true,
      print: (t) => log.push(t),
      printErr: (t) => log.push(t),
    });
    const inst = scad.getInstance();
    inst.FS.mkdir("/fonts");
    inst.FS.writeFile("/fonts/NanumGothic-Bold.ttf", font);
    inst.FS.writeFile("/fonts/fonts.conf", FONTS_CONF);
    if (inst.ENV) inst.ENV.FONTCONFIG_FILE = "/fonts/fonts.conf";
    inst.FS.writeFile("/input.scad", code);

    const started = performance.now();
    let rc;
    try {
      rc = inst.callMain(["/input.scad", "-o", "/output.stl"]);
    } catch (err) {
      log.push(`ERROR: ${err?.message || err}`);
      rc = 1;
    }
    let stl = null;
    try {
      stl = inst.FS.readFile("/output.stl", { encoding: "utf8" });
    } catch {}

    const problems = log.filter((l) => /ERROR|WARNING|error|Parser/.test(l) && !/localization/.test(l));
    if (rc !== 0 || !stl || !/facet/.test(stl)) {
      const empty = log.some((l) => /empty/i.test(l));
      self.postMessage({
        id,
        ok: false,
        error: problems.join("\n") || (empty ? "모델이 비어 있습니다 (만들어진 도형이 없음)." : "알 수 없는 렌더링 오류"),
        log: log.join("\n"),
      });
      return;
    }
    self.postMessage({ id, ok: true, stl, warnings: problems.join("\n"), ms: Math.round(performance.now() - started) });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err), log: log.join("\n") });
  }
};
