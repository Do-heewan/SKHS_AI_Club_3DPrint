# 성광 AI 3D 프린트 스튜디오

성광여자고등학교 AI 동아리 학생들이 **말로 설명하면 Claude가 3D 프린터용 도안(OpenSCAD → STL)을 만들어 주는** 웹 서비스입니다.
Bambu Lab **P2S / X2D**(출력 범위 약 256mm)에 맞춰 설계 규칙이 들어가 있습니다.

## 동작 방식

```
학생 브라우저 ──프롬프트──▶ 서버(Node.js) ──API 키──▶ Claude (Opus 5.5)
      ▲                                                   │
      └──── OpenSCAD 코드 ◀────────────────────────────────┘
      │
      ├─ 브라우저 안에서 OpenSCAD(WASM)로 3D 모델 생성 → 3D 미리보기
      ├─ 렌더링 오류가 나면 오류 내용을 Claude에게 자동으로 보내서 수정 (최대 2회)
      └─ STL 다운로드 → Bambu Studio에서 열어 출력
```

- API 키는 **서버에만** 있고 학생 브라우저로는 절대 전달되지 않습니다.
- 3D 렌더링은 각 학생 PC에서 하므로 28명이 동시에 써도 서버 부담이 적습니다.
- 같은 동아리 학생끼리만 '동아리에 공유'한 작품과 사용한 프롬프트를 볼 수 있습니다.

## 실행 방법

1. [Node.js](https://nodejs.org) 20.12 이상 설치
2. 패키지 설치
   ```bash
   npm install
   ```
3. `.env.example`을 복사해 `.env`를 만들고 값을 채웁니다.
   - `ANTHROPIC_API_KEY`: Claude 콘솔에서 발급한 키
   - `CLUBS`: 동아리 이름 3개 (쉼표로 구분)
   - `ACCESS_CODE`: 학생 입장 코드 (외부인이 API 크레딧을 쓰지 못하게 막는 용도)
   - `ADMIN_PASSWORD`: 관리자 페이지 비밀번호
4. 서버 실행
   ```bash
   npm start
   ```
5. 접속
   - 학생: `http://<서버 컴퓨터 IP>:3000`
   - 관리자: `http://<서버 컴퓨터 IP>:3000/admin.html` (학생별 사용량·예상 비용, 사용량 초기화)

## 수업 당일 체크리스트

- [ ] 선생님 노트북과 학생 PC가 **같은 와이파이/네트워크**에 있는지 확인 (`ipconfig`로 IP 확인)
- [ ] 처음 실행할 때 Windows 방화벽 창이 뜨면 **허용**
- [ ] 학교 네트워크가 기기 간 접속을 막는 경우(클라이언트 격리), 클라우드 배포(Render, Railway 등)를 사용
- [ ] 학생 PC 브라우저는 최신 Chrome / Edge 권장 (첫 접속 시 3D 엔진 약 11MB 다운로드)
- [ ] Claude 콘솔에서 잔액/크레딧과 Rate limit 확인

## 설정 (.env)

| 이름 | 기본값 | 설명 |
|---|---|---|
| `CLAUDE_MODEL` | `claude-opus-5-5` | 비용을 줄이려면 `claude-sonnet-5-5` |
| `CLAUDE_EFFORT` | `medium` | 생각 깊이 `low` / `medium` / `high` |
| `DAILY_MESSAGE_LIMIT` | `40` | 학생 1명당 하루 요청 수 (실패한 요청은 차감 안 됨) |
| `MAX_CONCURRENT` | `8` | 동시에 Claude로 보내는 요청 수. 넘으면 대기열에서 기다림 |

## Render + Supabase 배포

### 1. Supabase 준비
1. [supabase.com](https://supabase.com)에서 새 프로젝트 생성 (Region: **Northeast Asia (Seoul)** 권장)
2. 왼쪽 메뉴 **SQL Editor** → `supabase/schema.sql` 내용을 전부 붙여넣고 **Run**
3. **Project Settings → API**에서 두 값을 복사
   - `Project URL` → `SUPABASE_URL`
   - `service_role` 키 (secret) → `SUPABASE_SERVICE_ROLE_KEY` ⚠️ 절대 공개 금지

### 2. Render 배포
1. 이 프로젝트를 GitHub 저장소에 올림 (`.env`, `data/`는 자동으로 제외됨)
2. Render 대시보드 → **New → Blueprint** → 저장소 선택 (`render.yaml`을 자동으로 읽음)
3. 입력 화면에서 `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CLUBS`, `ACCESS_CODE`, `ADMIN_PASSWORD` 입력
4. 배포가 끝나면 `https://<서비스이름>.onrender.com` 으로 접속

### 참고
- **Render 무료 요금제**는 15분간 접속이 없으면 잠들고, 첫 접속 때 30초~1분 걸립니다. 수업 시작 전에 선생님이 먼저 한 번 접속해 두세요. (데이터는 Supabase에 있으므로 사라지지 않습니다)
- **Supabase 무료 요금제**는 7일 동안 사용이 없으면 프로젝트가 일시 정지됩니다. 대시보드에서 Restore 버튼으로 다시 켤 수 있습니다.

## 데이터 관리

- **Supabase 사용 시:** 대시보드 **Table Editor**에서 학생(`students`)·도안(`designs`)을 보고 고치거나 지울 수 있습니다.
  - 학생 이름/동아리를 잘못 입력한 경우: `students` 표에서 직접 수정
  - 학생을 지우면 그 학생의 도안과 로그인 정보도 함께 지워집니다.
- **로컬 테스트 시** (`SUPABASE_URL`을 비워 둔 경우): `data/db.json` 파일 하나에 저장됩니다.

## 폴더 구조

```
server.js            서버 (로그인, 도안 저장, Claude 스트리밍, 관리자 API)
lib/prompt.js        Claude에게 주는 3D 프린팅 설계 규칙 (시스템 프롬프트)
lib/store.js         로컬 테스트용 JSON 파일 저장소
lib/supabase-store.js  Supabase 저장소
supabase/schema.sql  Supabase 테이블 생성 SQL
render.yaml          Render 배포 설정
public/index.html    학생 화면
public/admin.html    관리자 화면
public/js/app.js     화면 동작
public/js/viewer.js  three.js 3D 미리보기
public/js/scad-worker.js  브라우저용 OpenSCAD(WASM) 렌더러
public/fonts/        한글 글꼴 (나눔고딕 Bold, SIL OFL)
```
