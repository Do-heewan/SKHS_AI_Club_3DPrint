import fs from "node:fs";

// 프로젝트 루트의 .env 파일을 읽어 환경변수로 등록 (Node 20.12+ 내장 기능 사용)
export function loadEnv() {
  if (fs.existsSync(".env")) process.loadEnvFile(".env");
}
