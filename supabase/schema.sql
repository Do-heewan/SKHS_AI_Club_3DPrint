-- 성광 AI 3D 프린트 스튜디오 - Supabase 테이블
-- Supabase 대시보드 > SQL Editor 에 전체를 붙여넣고 Run 하세요. 여러 번 실행해도 안전합니다.

-- 학생
create table if not exists public.students (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  student_no      text not null unique,
  club            text not null,
  usage_date      date,                       -- 오늘 사용 횟수를 센 날짜 (한국 시간)
  usage_count     integer not null default 0, -- 그날 사용 횟수
  total_requests  integer not null default 0,
  input_tokens    bigint  not null default 0,
  output_tokens   bigint  not null default 0,
  cache_read_tokens  bigint not null default 0,
  cache_write_tokens bigint not null default 0,
  created_at      timestamptz not null default now()
);

-- 로그인 토큰 (브라우저에 저장되는 값)
create table if not exists public.sessions (
  token       text primary key,
  student_id  uuid not null references public.students(id) on delete cascade,
  created_at  timestamptz not null default now()
);
create index if not exists sessions_student_idx on public.sessions(student_id);

-- 도안
create table if not exists public.designs (
  id                  uuid primary key default gen_random_uuid(),
  owner_id            uuid not null references public.students(id) on delete cascade,
  club                text not null,
  title               text not null default '새 도안',
  messages            jsonb not null default '[]', -- Claude API에 다시 보내는 대화 기록 (수정 금지)
  chat                jsonb not null default '[]', -- 화면 표시용 대화 기록
  code                text not null default '',    -- 최종 OpenSCAD 코드
  last_assistant_code text not null default '',
  thumbnail           text,                        -- 미리보기 이미지 (data URL)
  shared              boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists designs_owner_idx on public.designs(owner_id, updated_at desc);
create index if not exists designs_club_shared_idx on public.designs(club, updated_at desc) where shared;

-- 하루 사용 횟수를 원자적으로 증감 (동시에 요청이 와도 정확하게 셈)
create or replace function public.increment_usage(p_student_id uuid, p_date date, p_delta integer)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_count integer;
begin
  update students
     set usage_count = greatest(0, case when usage_date = p_date then usage_count else 0 end + p_delta),
         usage_date = p_date,
         total_requests = greatest(0, total_requests + p_delta)
   where id = p_student_id
  returning usage_count into v_count;
  return v_count;
end;
$$;

-- 토큰 사용량 누적
create or replace function public.add_token_usage(
  p_student_id uuid, p_input bigint, p_output bigint, p_cache_read bigint, p_cache_write bigint)
returns void
language sql
set search_path = public
as $$
  update students
     set input_tokens = input_tokens + p_input,
         output_tokens = output_tokens + p_output,
         cache_read_tokens = cache_read_tokens + p_cache_read,
         cache_write_tokens = cache_write_tokens + p_cache_write
   where id = p_student_id;
$$;

-- 보안: 서버(service_role 키)만 접근할 수 있게 하고, 브라우저용 공개 키(anon)로는 아무것도 못 읽게 막는다.
alter table public.students enable row level security;
alter table public.sessions enable row level security;
alter table public.designs  enable row level security;

revoke all on public.students, public.sessions, public.designs from anon, authenticated;
revoke execute on function public.increment_usage(uuid, date, integer) from public, anon, authenticated;
revoke execute on function public.add_token_usage(uuid, bigint, bigint, bigint, bigint) from public, anon, authenticated;
grant execute on function public.increment_usage(uuid, date, integer) to service_role;
grant execute on function public.add_token_usage(uuid, bigint, bigint, bigint, bigint) to service_role;
