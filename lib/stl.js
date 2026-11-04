import zlib from "node:zlib";

// 학생이 직접 올리는 STL 파일(Tinkercad 등) 검사. 브라우저가 gzip 으로 압축해서 보낸다.
export const MAX_STL_BYTES = 50 * 1024 * 1024; // 압축을 푼 STL 최대 크기
export const MAX_STL_GZ_BYTES = 8 * 1024 * 1024; // 압축한 파일 최대 크기 (요청 본문 12MB 안에 들어가야 함)

// 압축을 조금씩 풀어 보며 크기와 형식을 확인한다. 문제가 있으면 학생에게 보여 줄 문장을, 없으면 null 을 돌려준다.
// 전체를 메모리에 올리지 않으므로 압축 폭탄 같은 파일도 안전하게 걸러 낸다.
export async function stlProblem(gz) {
  if (!gz.length) return "STL 파일을 골라 주세요.";
  if (gz.length > MAX_STL_GZ_BYTES) return "파일이 너무 커요. Tinkercad에서 모양을 조금 단순하게 해서 다시 내보내 주세요.";
  const gunzip = zlib.createGunzip();
  gunzip.end(gz);
  let size = 0;
  const head = [];
  try {
    for await (const chunk of gunzip) {
      if (size < 4096) head.push(chunk);
      size += chunk.length;
      if (size > MAX_STL_BYTES) return "파일이 너무 커요. (최대 50MB)";
    }
  } catch {
    return "파일을 읽을 수 없어요. 다시 시도해 주세요.";
  }
  const buf = Buffer.concat(head);
  // 바이너리 STL: 80바이트 머리말 + 삼각형 개수(4바이트) + 삼각형마다 50바이트
  const faces = buf.length >= 84 ? buf.readUInt32LE(80) : 0;
  if (faces > 0 && 84 + faces * 50 <= size) return null;
  // 텍스트(ASCII) STL: "solid" 로 시작하고 "facet" 이 나온다. (앞에 BOM 이 붙어 있을 수 있음)
  const text = buf.subarray(0, 4096).toString("latin1");
  if (/^[\s\S]{0,4}solid/.test(text) && text.includes("facet")) return null;
  return "STL 파일이 아니에요. Tinkercad에서 '.STL'로 내보낸 파일을 올려 주세요.";
}
