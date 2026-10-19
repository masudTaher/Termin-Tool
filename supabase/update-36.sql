-- Update 36: Fragen der Ärzte an die Dolmetscher.
-- Ein Arzt liest auf der Berichte-Anzeige einen Bericht und hat eine Frage: Er tippt „Dolmetscher fragen“ und schreibt sie direkt
-- zum Bericht. Der Dolmetscher bekommt sie in seiner App (Nachrichten) mit Patient, Bericht und Datum – und antwortet dort.
-- Die Antwort erscheint beim Arzt unter dem Bericht. Die Einsatzleitung sieht alle Fragen und Antworten.
--   • Fragen stellen: nur Ärzte (und das Büro). Antworten: nur der gefragte Dolmetscher (und das Büro).
--   • Niemand kann fremde Fragen oder Antworten ändern; löschen darf das Büro, der Arzt seine eigene Frage, solange sie unbeantwortet ist.
-- Braucht Update 34. Kann beliebig oft ausgeführt werden.

create table if not exists public.tt_doctor_questions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  document_id uuid references public.tt_documents (id) on delete set null,
  document_title text not null default '',
  document_kind text not null default '',
  document_date date,
  patient_nr text not null default '',
  patient_name text not null default '',
  interpreter_id uuid not null references public.tt_profiles (id) on delete cascade,
  interpreter_name text not null default '',
  doctor_id uuid not null references public.tt_profiles (id) on delete cascade,
  doctor_name text not null default '',
  question text not null check (char_length(question) between 1 and 2000),
  answer text not null default '' check (char_length(answer) <= 4000),
  answered_at timestamptz,
  seen_at timestamptz                              -- wann der Dolmetscher die Frage gesehen hat
);
create index if not exists tt_doctor_questions_interpreter_idx on public.tt_doctor_questions (interpreter_id, created_at desc);
create index if not exists tt_doctor_questions_document_idx on public.tt_doctor_questions (document_id);
alter table public.tt_doctor_questions enable row level security;
revoke all on public.tt_doctor_questions from anon, authenticated;
grant select, insert, update, delete on public.tt_doctor_questions to authenticated;

-- Wer fragt, steht fest; Bericht, Patient und Dolmetscher kommen aus der Unterlage selbst (nicht aus der App).
create or replace function public.tt_doctor_question_stamp() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_doc public.tt_documents;
begin
  new.doctor_id := (select auth.uid());
  new.doctor_name := coalesce((select full_name from public.tt_profiles where id = (select auth.uid())), '');
  new.created_at := now();
  new.answer := '';
  new.answered_at := null;
  new.seen_at := null;
  select * into v_doc from public.tt_documents where id = new.document_id;
  if v_doc.id is null then
    raise exception 'Diese Unterlage gibt es nicht (mehr).';
  end if;
  if v_doc.uploader_id is null or not exists (select 1 from public.tt_profiles where id = v_doc.uploader_id and role = 'dolmetscher') then
    raise exception 'Zu dieser Unterlage gibt es keinen Dolmetscher, den man fragen könnte.';
  end if;
  new.interpreter_id := v_doc.uploader_id;
  new.interpreter_name := coalesce(v_doc.uploader_name, '');
  new.document_title := coalesce(nullif(v_doc.title, ''), v_doc.kind, '');
  new.document_kind := coalesce(v_doc.kind, '');
  new.document_date := coalesce(v_doc.date, v_doc.created_at::date);
  new.patient_nr := coalesce(v_doc.patient_nr, '');
  new.patient_name := coalesce(v_doc.patient_name, '');
  return new;
end;
$$;
drop trigger if exists tt_doctor_question_stamp on public.tt_doctor_questions;
create trigger tt_doctor_question_stamp before insert on public.tt_doctor_questions for each row execute function public.tt_doctor_question_stamp();

-- Der Dolmetscher ändert nur Antwort und „gesehen“; alles andere bleibt. Das Büro darf korrigieren.
create or replace function public.tt_doctor_question_keep() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not public.tt_is_staff() then
    new.id := old.id; new.created_at := old.created_at; new.document_id := old.document_id; new.document_title := old.document_title;
    new.document_kind := old.document_kind; new.document_date := old.document_date; new.patient_nr := old.patient_nr; new.patient_name := old.patient_name;
    new.interpreter_id := old.interpreter_id; new.interpreter_name := old.interpreter_name; new.doctor_id := old.doctor_id; new.doctor_name := old.doctor_name;
    new.question := old.question;
  end if;
  if new.answer is distinct from old.answer then
    new.answered_at := case when btrim(new.answer) = '' then null else now() end;
  end if;
  if new.seen_at is null and old.seen_at is not null then new.seen_at := old.seen_at; end if;
  return new;
end;
$$;
drop trigger if exists tt_doctor_question_keep on public.tt_doctor_questions;
create trigger tt_doctor_question_keep before update on public.tt_doctor_questions for each row execute function public.tt_doctor_question_keep();

drop policy if exists tt_doctor_questions_select on public.tt_doctor_questions;
create policy tt_doctor_questions_select on public.tt_doctor_questions for select to authenticated
  using (public.tt_is_staff() or doctor_id = (select auth.uid()) or (public.tt_is_member() and interpreter_id = (select auth.uid())));
drop policy if exists tt_doctor_questions_insert on public.tt_doctor_questions;
create policy tt_doctor_questions_insert on public.tt_doctor_questions for insert to authenticated
  with check (public.tt_is_doctor() or public.tt_is_staff());
drop policy if exists tt_doctor_questions_update on public.tt_doctor_questions;
create policy tt_doctor_questions_update on public.tt_doctor_questions for update to authenticated
  using (public.tt_is_staff() or (public.tt_is_member() and interpreter_id = (select auth.uid())))
  with check (public.tt_is_staff() or (public.tt_is_member() and interpreter_id = (select auth.uid())));
drop policy if exists tt_doctor_questions_delete on public.tt_doctor_questions;
create policy tt_doctor_questions_delete on public.tt_doctor_questions for delete to authenticated
  using (public.tt_is_staff() or (doctor_id = (select auth.uid()) and answered_at is null));
