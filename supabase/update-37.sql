-- Update 37: Jeder Schritt lässt sich zurücknehmen – mit Vermerk für die Einsatzleitung.
-- Dolmetscher dürfen Versehen selbst korrigieren, ohne Erlaubnis: „Jetzt losfahren“ und „Fertig“ zurücknehmen (neu), die Antwort
-- ändern, eine Stornierung zurücknehmen, den eigenen Bericht ändern oder löschen (gab es schon). Jede solche Korrektur steht ab jetzt
-- in tt_corrections: wer, wann, was – sichtbar für die Einsatzleitung (Startseite „Korrekturen“ und Meldung), für die Person selbst.
--   • tt_assignment_progress: neue Aktionen 'undo_start' und 'undo_finish'
--   • Auslöser an tt_assignments und tt_documents schreiben den Vermerk von selbst (auch für Änderungen aus der App von früher)
-- Braucht Update 35. Kann beliebig oft ausgeführt werden.

create table if not exists public.tt_corrections (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  profile_id uuid references public.tt_profiles (id) on delete cascade,
  person_name text not null default '',
  kind text not null,                     -- losfahren_zurueck, fertig_zurueck, antwort, storno_zurueck, unterlage, unterlage_geloescht
  assignment_id uuid,
  document_id uuid,
  title text not null default '',         -- Auftrag oder Unterlage
  date date,
  detail text not null default '',        -- z. B. „Zusage → Absage“
  seen_at timestamptz,
  seen_by text not null default ''
);
create index if not exists tt_corrections_at_idx on public.tt_corrections (at desc);
create index if not exists tt_corrections_person_idx on public.tt_corrections (profile_id, at desc);
alter table public.tt_corrections enable row level security;
revoke all on public.tt_corrections from anon, authenticated;
grant select, update, delete on public.tt_corrections to authenticated;
drop policy if exists tt_corrections_select on public.tt_corrections;
create policy tt_corrections_select on public.tt_corrections for select to authenticated
  using (public.tt_is_staff() or profile_id = (select auth.uid()));
drop policy if exists tt_corrections_update on public.tt_corrections;
create policy tt_corrections_update on public.tt_corrections for update to authenticated
  using (public.tt_is_staff()) with check (public.tt_is_staff());
drop policy if exists tt_corrections_delete on public.tt_corrections;
create policy tt_corrections_delete on public.tt_corrections for delete to authenticated
  using (public.tt_is_admin());

create or replace function public.tt_note_correction(p_kind text, p_assignment uuid, p_document uuid, p_title text, p_date date, p_detail text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
begin
  select full_name into v_name from public.tt_profiles where id = (select auth.uid());
  insert into public.tt_corrections (profile_id, person_name, kind, assignment_id, document_id, title, date, detail)
  values ((select auth.uid()), coalesce(v_name, ''), p_kind, p_assignment, p_document, left(coalesce(p_title, ''), 200), p_date, left(coalesce(p_detail, ''), 400));
end;
$$;
revoke execute on function public.tt_note_correction(text, uuid, uuid, text, date, text) from public, anon, authenticated;

-- Aufträge: Antwort geändert (nachdem schon geantwortet war), Losfahren/Fertig zurückgenommen, Stornierung zurückgenommen.
create or replace function public.tt_assignment_correction() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_labels jsonb := '{"offen": "keine Antwort", "zugesagt": "Zusage", "vorbehalt": "unter Vorbehalt", "abgesagt": "Absage"}'::jsonb;
begin
  if (select auth.uid()) is null or (select auth.uid()) <> new.interpreter_id or public.tt_is_staff() then
    return new;
  end if;
  if old.started_at is not null and new.started_at is null and new.storno_at is null then
    perform public.tt_note_correction('losfahren_zurueck', new.id, null, new.title, new.date, '„Jetzt losfahren“ zurückgenommen (war ' || to_char(old.started_at at time zone 'Europe/Berlin', 'HH24:MI') || ' Uhr)');
  elsif old.finished_at is not null and new.finished_at is null and new.storno_at is null and old.storno_at is null then
    perform public.tt_note_correction('fertig_zurueck', new.id, null, new.title, new.date, '„Fertig“ zurückgenommen (war ' || to_char(old.finished_at at time zone 'Europe/Berlin', 'HH24:MI') || ' Uhr)');
  end if;
  if old.storno_at is not null and new.storno_at is null then
    perform public.tt_note_correction('storno_zurueck', new.id, null, new.title, new.date, 'Stornierung zurückgenommen' || case when old.storno_note <> '' then ' („' || left(old.storno_note, 120) || '“)' else '' end);
  end if;
  if old.response is distinct from new.response and old.responded_at is not null then
    perform public.tt_note_correction('antwort', new.id, null, new.title, new.date, coalesce(v_labels ->> old.response, old.response) || ' → ' || coalesce(v_labels ->> new.response, new.response)
      || case when new.response_note <> '' then ' – „' || left(new.response_note, 120) || '“' else '' end);
  end if;
  return new;
end;
$$;
drop trigger if exists tt_assignment_correction on public.tt_assignments;
create trigger tt_assignment_correction after update on public.tt_assignments for each row execute function public.tt_assignment_correction();

-- Unterlagen und Berichte: vom Dolmetscher nachträglich geändert oder gelöscht.
create or replace function public.tt_document_correction() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or public.tt_is_staff() then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    if old.uploader_id = (select auth.uid()) then
      perform public.tt_note_correction('unterlage_geloescht', old.assignment_id, old.id, coalesce(nullif(old.title, ''), old.kind), coalesce(old.date, old.created_at::date),
        coalesce(old.kind, '') || case when old.patient_name <> '' then ' · ' || old.patient_name else '' end || ' gelöscht');
    end if;
    return old;
  end if;
  if new.uploader_id = (select auth.uid()) and (old.body is distinct from new.body or old.kind is distinct from new.kind or old.note is distinct from new.note
      or old.file_path is distinct from new.file_path or old.date is distinct from new.date or old.doctor is distinct from new.doctor) then
    perform public.tt_note_correction('unterlage', new.assignment_id, new.id, coalesce(nullif(new.title, ''), new.kind), coalesce(new.date, new.created_at::date),
      (case when new.kind = 'Dolmetscherbericht' then 'Bericht' else coalesce(new.kind, 'Unterlage') end) || ' geändert'
      || case when new.patient_name <> '' then ' · ' || new.patient_name else '' end
      || case when old.kind is distinct from new.kind then ' (Art: ' || coalesce(old.kind, '') || ' → ' || coalesce(new.kind, '') || ')' else '' end);
  end if;
  return new;
end;
$$;
drop trigger if exists tt_document_correction on public.tt_documents;
create trigger tt_document_correction after update or delete on public.tt_documents for each row execute function public.tt_document_correction();

create or replace function public.tt_assignment_progress(p_id uuid, p_action text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.tt_assignments;
  v_profile public.tt_profiles;
  v_now timestamp := now() at time zone 'Europe/Berlin';
  v_start time := '09:00';
  v_end time := '16:00';
  v_setting jsonb;
  v_minutes integer := 0;
  v_late boolean := false;
begin
  if p_action not in ('start', 'finish', 'undo_start', 'undo_finish') then
    raise exception 'Unbekannte Aktion.';
  end if;
  select * into v_profile from public.tt_profiles where id = auth.uid() and active;
  if not found then
    raise exception 'Dein Konto ist noch nicht freigeschaltet.';
  end if;
  select * into v_job from public.tt_assignments where id = p_id and interpreter_id = auth.uid() and not cancelled;
  if not found then
    raise exception 'Dieser Auftrag ist nicht (mehr) für dich bestimmt.';
  end if;
  if v_job.response = 'abgesagt' then
    raise exception 'Du hast diesen Auftrag abgesagt. Bitte ändere zuerst deine Antwort.';
  end if;
  if v_job.date > v_now::date and p_action in ('start', 'finish') then
    raise exception 'Dieser Auftrag ist erst am %.', to_char(v_job.date, 'DD.MM.YYYY');
  end if;

  -- Zurücknehmen (Update 37): „Losfahren“ oder „Fertig“ aus Versehen gedrückt. Der Auftrag geht einen Schritt zurück;
  -- der Termin im Tagesstand folgt, sofern sein Stand aus dem Portal kam. Die Einsatzleitung bekommt einen Vermerk (tt_corrections).
  if p_action in ('undo_start', 'undo_finish') then
    if v_job.storno_at is not null then
      raise exception 'Dieser Auftrag ist storniert – bitte zuerst die Stornierung zurücknehmen.';
    end if;
    if p_action = 'undo_start' then
      if v_job.started_at is null then raise exception 'Du hast „Jetzt losfahren“ noch nicht gedrückt.'; end if;
      update public.tt_assignments set started_at = null, finished_at = null, work_status = 'offen', reminded_at = null, reminder_count = 0
       where id = p_id returning * into v_job;
    else
      if v_job.finished_at is null then raise exception 'Dieser Auftrag ist noch nicht beendet.'; end if;
      update public.tt_assignments set finished_at = null, work_status = case when started_at is not null then 'losgefahren' else 'offen' end
       where id = p_id returning * into v_job;
    end if;
    update public.tt_days d
       set records = (
             select jsonb_agg(case when r ->> '_id' = v_job.appointment_id::text
                                    and lower(btrim(coalesce(r ->> 'Status', 'offen'))) in ('losgefahren', 'beendet')
                                    and (r ? 'Portal_Start' or r ? 'Portal_Ende')
                                   then (r - 'Portal_Ende' - 'Nachtrag_Abschluss' - case when p_action = 'undo_start' then 'Portal_Start' else '' end)
                                        || jsonb_build_object('Status', case when p_action = 'undo_start' then 'offen' else 'losgefahren' end)
                                   else r end order by n)
               from jsonb_array_elements(d.records) with ordinality as t(r, n))
     where d.date = v_job.date and jsonb_typeof(d.records) = 'array'
       and exists (select 1 from jsonb_array_elements(d.records) r where r ->> '_id' = v_job.appointment_id::text and (r ? 'Portal_Start' or r ? 'Portal_Ende'));
    return jsonb_build_object('status', v_job.work_status, 'started_at', v_job.started_at, 'finished_at', v_job.finished_at, 'overtime_minutes', 0, 'late', false);
  end if;

  select value into v_setting from public.tt_settings where key = 'arbeitszeit';
  if v_setting ? 'start' then v_start := (v_setting ->> 'start')::time; end if;
  if v_setting ? 'ende' then v_end := (v_setting ->> 'ende')::time; end if;

  if p_action = 'start' then
    if v_job.finished_at is not null then
      raise exception 'Dieser Auftrag ist bereits beendet.';
    end if;
    if not exists (select 1 from public.tt_handovers where driver_id = auth.uid() and end_time is null) then
      raise exception 'Bitte zuerst ein Fahrzeug übernehmen. Ohne Fahrzeug kann der Auftrag nicht gestartet werden.';
    end if;
    update public.tt_assignments
       set started_at = coalesce(started_at, now()), work_status = 'losgefahren',
           response = case when response = 'offen' then 'zugesagt' else response end,
           responded_at = case when response = 'offen' then now() else responded_at end,
           reminded_at = null, reminder_count = 0
     where id = p_id returning * into v_job;
  else
    update public.tt_assignments
       set started_at = coalesce(started_at, now()), finished_at = coalesce(finished_at, now()), work_status = 'beendet',
           response = case when response = 'offen' then 'zugesagt' else response end,
           responded_at = case when response = 'offen' then now() else responded_at end
     where id = p_id returning * into v_job;
    -- Nachträglich abgeschlossen (Auftrag von einem früheren Tag): Der Termin im Tagesstand wird mit abgeschlossen, damit der
    -- Arbeitstag zählt. Nur Termine, die dort noch offen stehen – ein von der Einsatzleitung gesetzter Stand bleibt unberührt.
    -- updated_at bleibt, wie es ist: Der alte Tag soll im Büro nicht als „neuester Stand“ erscheinen.
    if v_job.date < v_now::date then
      update public.tt_days d
         set records = (
               select jsonb_agg(case when r ->> '_id' = v_job.appointment_id::text
                                      and lower(btrim(coalesce(r ->> 'Status', 'offen'))) in ('', 'offen', 'losgefahren')
                                     then r || jsonb_build_object('Status', 'beendet', 'Portal_Start', to_jsonb(v_job.started_at),
                                                                  'Portal_Ende', to_jsonb(v_job.finished_at),
                                                                  'Nachtrag_Abschluss', to_char(v_now, 'DD.MM.YYYY HH24:MI'))
                                     else r end order by n)
                 from jsonb_array_elements(d.records) with ordinality as t(r, n))
       where d.date = v_job.date
         and jsonb_typeof(d.records) = 'array'
         and exists (select 1 from jsonb_array_elements(d.records) r
                      where r ->> '_id' = v_job.appointment_id::text
                        and lower(btrim(coalesce(r ->> 'Status', 'offen'))) in ('', 'offen', 'losgefahren'));
      v_late := true;
    end if;
  end if;

  -- Überstunden werden NICHT mehr automatisch eingetragen (Update 35): Festangestellte tragen sie selbst unter „Arbeitszeit“ ein.

  return jsonb_build_object('status', v_job.work_status, 'started_at', v_job.started_at, 'finished_at', v_job.finished_at,
                            'overtime_minutes', v_minutes, 'late', v_late);
end;
$$;

revoke execute on function public.tt_assignment_progress(uuid, text) from public, anon;
grant execute on function public.tt_assignment_progress(uuid, text) to authenticated;
