-- Update 51 (R80): Rolle „PR“ – Berichte für das Visum.
--   • neue Rolle 'pr': sieht auf der Berichte-Anzeige (arzt.html) alle Unterlagen der Dolmetscher wie ein Arzt – und zusätzlich
--     „Wer ist wo“: die Termine des Tages, knapp – welcher Dolmetscher ist bei welchem Arzt mit welchem Patienten, läuft der
--     Termin gerade, ist er fertig, liegt der Bericht schon vor. Keine Telefonnummern, Adressen, Kosten oder Hinweise.
--   • „Bericht anfordern“: Zu einem Termin ohne Bericht schreibt die PR dem Dolmetscher (tt_doctor_questions, Art 'bericht').
--     Sobald der Dolmetscher den Bericht zu diesem Termin hochlädt, gilt die Anfrage automatisch als erledigt.
--     Außerdem kann die PR – wie ein Arzt – zu jedem Termin oder Bericht eine Frage, Info oder Anweisung schicken.
--   • Fragen können jetzt auch zu einem Termin gestellt werden (assignment_id), nicht nur zu einer Unterlage.
-- Braucht Update 34, 36, 40. Kann beliebig oft ausgeführt werden.

alter table public.tt_profiles drop constraint if exists tt_profiles_role_check;
alter table public.tt_profiles add constraint tt_profiles_role_check
  check (role in ('admin', 'sekretariat', 'dolmetscher', 'pforte', 'arzt', 'pr'));

create or replace function public.tt_is_pr() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.tt_profiles where id = (select auth.uid()) and active and role = 'pr');
$$;
revoke execute on function public.tt_is_pr() from public, anon;
grant execute on function public.tt_is_pr() to authenticated;

-- Die PR liest wie ein Arzt: alle Unterlagen, „Gelesen“, Fragen an Dolmetscher, Meldungen an die Einsatzleitung.
create or replace function public.tt_is_doctor() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.tt_profiles where id = (select auth.uid()) and active and role in ('arzt', 'pr'));
$$;
-- … und ist – wie Arzt und Pforte – kein „Mitglied“ im Sinn der übrigen Regeln (keine Aufträge, kein Fuhrpark, kein Chat).
create or replace function public.tt_is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.tt_profiles where id = (select auth.uid()) and active and role not in ('pforte', 'arzt', 'pr'));
$$;

-- ---------------------------------------------------------------------------
-- Aus dem Auftragstext lesen: Arzt, Ort, Patient, Aktennummer (gleiche Regeln wie in der App)
-- ---------------------------------------------------------------------------
create or replace function public.tt_job_doctor(p_title text, p_message text) returns text
language sql immutable set search_path = '' as $$
  select coalesce(
    nullif(btrim(substring(coalesce(p_message, '') from '\*ARZT[^*]*\*\s*Name:\s*([^\r\n]+)')), ''),
    nullif(btrim(case when split_part(coalesce(p_title, ''), ' · ', 1) ~ '^\d{1,2}:\d{2}\s*Uhr$' then split_part(coalesce(p_title, ''), ' · ', 2) else split_part(coalesce(p_title, ''), ' · ', 1) end), ''),
    '');
$$;
create or replace function public.tt_job_city(p_title text, p_message text) returns text
language sql immutable set search_path = '' as $$
  select coalesce(
    nullif(btrim(substring(coalesce(p_message, '') from '\*Ort:\s*([^*\r\n]+)\*')), ''),
    nullif(btrim(case when split_part(coalesce(p_title, ''), ' · ', 1) ~ '^\d{1,2}:\d{2}\s*Uhr$' then split_part(coalesce(p_title, ''), ' · ', 3) else split_part(coalesce(p_title, ''), ' · ', 2) end), ''),
    '');
$$;
create or replace function public.tt_job_patient(p_message text) returns text
language sql immutable set search_path = '' as $$
  select coalesce(
    nullif(btrim(substring(coalesce(p_message, '') from '\*Patient/in:\s*([^*\r\n]+)\*')), ''),
    nullif(btrim(substring(coalesce(p_message, '') from '\*Hauptpatient/in:\s*([^*\r\n]+)\*')), ''),
    '');
$$;
create or replace function public.tt_job_patient_nr(p_message text) returns text
language sql immutable set search_path = '' as $$
  select coalesce(nullif(btrim(substring(coalesce(p_message, '') from '\*Aktennummer:\s*([^*\r\n]+)\*')), ''), '');
$$;

-- ---------------------------------------------------------------------------
-- Fragen und Berichtsanfragen auch zu einem Termin
-- ---------------------------------------------------------------------------
alter table public.tt_doctor_questions add column if not exists assignment_id uuid references public.tt_assignments (id) on delete set null;
create index if not exists tt_doctor_questions_assignment_idx on public.tt_doctor_questions (assignment_id) where assignment_id is not null;
alter table public.tt_doctor_questions drop constraint if exists tt_doctor_questions_kind_check;
alter table public.tt_doctor_questions add constraint tt_doctor_questions_kind_check check (kind in ('frage', 'info', 'anweisung', 'bericht'));

-- Wer schreibt, steht fest. Dolmetscher, Patient und Bezug kommen aus der Unterlage – oder aus dem Termin.
create or replace function public.tt_doctor_question_stamp() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_doc public.tt_documents;
  v_job public.tt_assignments;
begin
  new.doctor_id := (select auth.uid());
  new.doctor_name := coalesce((select full_name from public.tt_profiles where id = (select auth.uid())), '');
  new.created_at := now();
  new.answer := '';
  new.answered_at := null;
  new.seen_at := null;
  new.acknowledged_at := null;
  if new.kind is null or new.kind not in ('frage', 'info', 'anweisung', 'bericht') then new.kind := 'frage'; end if;
  if new.document_id is not null then
    select * into v_doc from public.tt_documents where id = new.document_id;
    if v_doc.id is null then
      raise exception 'Diese Unterlage gibt es nicht (mehr).';
    end if;
    if v_doc.uploader_id is null or not exists (select 1 from public.tt_profiles where id = v_doc.uploader_id and role = 'dolmetscher') then
      raise exception 'Zu dieser Unterlage gibt es keinen Dolmetscher, den man anschreiben könnte.';
    end if;
    new.assignment_id := coalesce(new.assignment_id, v_doc.assignment_id);
    new.interpreter_id := v_doc.uploader_id;
    new.interpreter_name := coalesce(v_doc.uploader_name, '');
    new.document_title := coalesce(nullif(v_doc.title, ''), v_doc.kind, '');
    new.document_kind := coalesce(v_doc.kind, '');
    new.document_date := coalesce(v_doc.date, v_doc.created_at::date);
    new.patient_nr := coalesce(v_doc.patient_nr, '');
    new.patient_name := coalesce(v_doc.patient_name, '');
  elsif new.assignment_id is not null then
    select * into v_job from public.tt_assignments where id = new.assignment_id;
    if v_job.id is null then
      raise exception 'Diesen Termin gibt es nicht (mehr).';
    end if;
    if not exists (select 1 from public.tt_profiles where id = v_job.interpreter_id and role = 'dolmetscher') then
      raise exception 'Zu diesem Termin gibt es keinen Dolmetscher, den man anschreiben könnte.';
    end if;
    new.interpreter_id := v_job.interpreter_id;
    new.interpreter_name := coalesce(v_job.interpreter_name, '');
    new.document_title := btrim(concat_ws(' · ', 'Termin', nullif(left(v_job.time, 5), '') || ' Uhr', nullif(public.tt_job_doctor(v_job.title, v_job.message), '')));
    new.document_kind := 'Termin';
    new.document_date := v_job.date;
    new.patient_nr := public.tt_job_patient_nr(v_job.message);
    new.patient_name := public.tt_job_patient(v_job.message);
  else
    raise exception 'Keine Unterlage und kein Termin angegeben.';
  end if;
  return new;
end;
$$;
drop trigger if exists tt_doctor_question_stamp on public.tt_doctor_questions;
create trigger tt_doctor_question_stamp before insert on public.tt_doctor_questions for each row execute function public.tt_doctor_question_stamp();

-- Der Dolmetscher ändert nur Antwort, „gesehen“ und „bestätigt“; alles andere bleibt. Das Büro darf korrigieren.
create or replace function public.tt_doctor_question_keep() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not public.tt_is_staff() then
    new.id := old.id; new.created_at := old.created_at; new.document_id := old.document_id; new.document_title := old.document_title;
    new.document_kind := old.document_kind; new.document_date := old.document_date; new.patient_nr := old.patient_nr; new.patient_name := old.patient_name;
    new.interpreter_id := old.interpreter_id; new.interpreter_name := old.interpreter_name; new.doctor_id := old.doctor_id; new.doctor_name := old.doctor_name;
    new.question := old.question; new.kind := old.kind; new.assignment_id := old.assignment_id;
  end if;
  if new.answer is distinct from old.answer then
    new.answered_at := case when btrim(new.answer) = '' then null else now() end;
  end if;
  if new.seen_at is null and old.seen_at is not null then new.seen_at := old.seen_at; end if;
  if new.acknowledged_at is null and old.acknowledged_at is not null and not public.tt_is_staff() then new.acknowledged_at := old.acknowledged_at; end if;
  return new;
end;
$$;
drop trigger if exists tt_doctor_question_keep on public.tt_doctor_questions;
create trigger tt_doctor_question_keep before update on public.tt_doctor_questions for each row execute function public.tt_doctor_question_keep();

-- Kommt der Bericht zum Termin, ist die Anfrage erledigt – automatisch, mit Zeitpunkt.
create or replace function public.tt_report_request_done() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'Dolmetscherbericht' and new.assignment_id is not null and new.replaced_by is null then
    update public.tt_doctor_questions
       set acknowledged_at = now(), seen_at = coalesce(seen_at, now())
     where assignment_id = new.assignment_id and kind = 'bericht' and acknowledged_at is null;
  end if;
  return new;
end;
$$;
drop trigger if exists tt_report_request_done on public.tt_documents;
create trigger tt_report_request_done after insert or update of assignment_id, kind, replaced_by on public.tt_documents
  for each row execute function public.tt_report_request_done();

-- ---------------------------------------------------------------------------
-- „Wer ist wo“: die Termine eines Tages, knapp – nur für PR und Büro
-- ---------------------------------------------------------------------------
create or replace function public.tt_pr_live(p_date date default null)
returns table (
  id uuid, "time" text, "date" date, interpreter_id uuid, interpreter_name text, doctor text, city text,
  patient_name text, patient_nr text, response text, work_status text, started_at timestamptz, finished_at timestamptz,
  storno_at timestamptz, storno_note text, report_id uuid, report_at timestamptz, report_status text,
  request_id uuid, request_at timestamptz, request_by text, request_done_at timestamptz, request_answer text
)
language sql stable security definer set search_path = '' as $$
  select a.id, left(a.time, 5), a.date, a.interpreter_id, a.interpreter_name,
         public.tt_job_doctor(a.title, a.message), public.tt_job_city(a.title, a.message),
         public.tt_job_patient(a.message), public.tt_job_patient_nr(a.message),
         a.response, a.work_status, a.started_at, a.finished_at, a.storno_at, a.storno_note,
         r.id, r.created_at, r.status,
         q.id, q.created_at, q.doctor_name, q.acknowledged_at, q.answer
    from public.tt_assignments a
    left join lateral (select d.id, d.created_at, d.status from public.tt_documents d
                        where d.assignment_id = a.id and d.kind = 'Dolmetscherbericht' and d.replaced_by is null and d.status <> 'archiv'
                        order by d.created_at desc limit 1) r on true
    left join lateral (select x.id, x.created_at, x.doctor_name, x.acknowledged_at, x.answer from public.tt_doctor_questions x
                        where x.assignment_id = a.id and x.kind = 'bericht'
                        order by x.created_at desc limit 1) q on true
   where (public.tt_is_pr() or public.tt_is_staff())
     and a.date = coalesce(p_date, (now() at time zone 'Europe/Berlin')::date)
     and not a.cancelled and a.response <> 'abgesagt'
   order by a.time, a.interpreter_name;
$$;
revoke execute on function public.tt_pr_live(date) from public, anon;
grant execute on function public.tt_pr_live(date) to authenticated;

comment on function public.tt_pr_live(date) is 'Update 51: Termine eines Tages für die PR – Dolmetscher, Arzt, Patient, Stand, Bericht, Berichtsanfrage';
