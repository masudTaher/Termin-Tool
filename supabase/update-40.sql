-- Update 40: Ärzte schreiben den Dolmetschern – Frage, Info oder Anweisung.
-- Bisher (Update 36) konnte ein Arzt zu einem Bericht nur eine Frage stellen. Jetzt gibt es drei Arten:
--   • frage     – der Dolmetscher antwortet (wie bisher)
--   • info      – ein Hinweis zur Kenntnis; der Dolmetscher bestätigt „gelesen“
--   • anweisung – eine Anweisung des Arztes; sie erscheint beim Dolmetscher groß und rot und muss mit „Verstanden“ bestätigt werden
-- Der Dolmetscher ändert weiterhin nur Antwort, „gesehen“ und „bestätigt“ (acknowledged_at). Braucht Update 36. Kann beliebig oft
-- ausgeführt werden.

alter table public.tt_doctor_questions add column if not exists kind text not null default 'frage';
alter table public.tt_doctor_questions drop constraint if exists tt_doctor_questions_kind_check;
alter table public.tt_doctor_questions add constraint tt_doctor_questions_kind_check check (kind in ('frage', 'info', 'anweisung'));
alter table public.tt_doctor_questions add column if not exists acknowledged_at timestamptz;

-- Wer schreibt, steht fest; die Art wird geprüft.
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
  new.acknowledged_at := null;
  if new.kind is null or new.kind not in ('frage', 'info', 'anweisung') then new.kind := 'frage'; end if;
  select * into v_doc from public.tt_documents where id = new.document_id;
  if v_doc.id is null then
    raise exception 'Diese Unterlage gibt es nicht (mehr).';
  end if;
  if v_doc.uploader_id is null or not exists (select 1 from public.tt_profiles where id = v_doc.uploader_id and role = 'dolmetscher') then
    raise exception 'Zu dieser Unterlage gibt es keinen Dolmetscher, den man anschreiben könnte.';
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

-- Der Dolmetscher ändert nur Antwort, „gesehen“ und „bestätigt“; alles andere bleibt. Das Büro darf korrigieren.
create or replace function public.tt_doctor_question_keep() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not public.tt_is_staff() then
    new.id := old.id; new.created_at := old.created_at; new.document_id := old.document_id; new.document_title := old.document_title;
    new.document_kind := old.document_kind; new.document_date := old.document_date; new.patient_nr := old.patient_nr; new.patient_name := old.patient_name;
    new.interpreter_id := old.interpreter_id; new.interpreter_name := old.interpreter_name; new.doctor_id := old.doctor_id; new.doctor_name := old.doctor_name;
    new.question := old.question; new.kind := old.kind;
  end if;
  if new.answer is distinct from old.answer then
    new.answered_at := case when btrim(new.answer) = '' then null else now() end;
  end if;
  if new.seen_at is null and old.seen_at is not null then new.seen_at := old.seen_at; end if;
  if new.acknowledged_at is null and old.acknowledged_at is not null and not public.tt_is_staff() then new.acknowledged_at := old.acknowledged_at; end if;
  return new;
end;
$$;
