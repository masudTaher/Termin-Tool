-- Medical Office Bonn · Transport und Dolmetscher · Update 12
-- 1) Dolmetscher melden im Portal selbst „Losfahren“ und „Fertig“. Losfahren geht nur mit übernommenem Fahrzeug.
-- 2) Beim „Fertig“ eines fest angestellten Dolmetschers werden Überstunden automatisch eingetragen
--    (auf volle 10 Minuten aufgerundet, siehe Update 11).
-- 3) Erinnerung, solange ein gestarteter Auftrag nicht beendet ist: zuerst nach 4 Stunden, danach alle 2 Stunden.
--    Dafür ruft die Datenbank die Funktion "tt-push" jetzt alle 10 Minuten auf (vorher nur nachmittags).
-- Im Supabase-Menü "SQL Editor" einfügen und mit "Run" ausführen. Kann erneut ausgeführt werden.
-- Voraussetzung: schema.sql sowie update-2 bis update-11 wurden bereits ausgeführt.

-- ---------------------------------------------------------------------------
-- 1 Fortschritt eines Auftrags
-- ---------------------------------------------------------------------------
alter table public.tt_assignments
  add column if not exists started_at timestamptz,          -- „Losfahren“ im Portal
  add column if not exists finished_at timestamptz,         -- „Fertig“ im Portal
  add column if not exists reminded_at timestamptz,         -- letzte Erinnerung „bitte beenden“
  add column if not exists reminder_count integer not null default 0;

-- p_action: 'start' (Losfahren) oder 'finish' (Fertig). Antwort: Status, Zeiten und ggf. eingetragene Überstunden.
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
  v_overtime public.tt_overtime;
  v_minutes integer := 0;
  v_new_start time;
  v_new_end time;
begin
  if p_action not in ('start', 'finish') then
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
  if v_job.date > v_now::date then
    raise exception 'Dieser Auftrag ist erst am %.', to_char(v_job.date, 'DD.MM.YYYY');
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
  end if;

  -- Überstunden (nur fest angestellt, nur am Tag des Auftrags): vor Arbeitsbeginn losgefahren oder nach Arbeitsende fertig.
  -- Ein Eintrag je Tag: weitere Aufträge desselben Tages verlängern ihn, statt doppelt zu zählen.
  -- War der Eintrag schon bestätigt und die Zeit ändert sich, geht er zurück auf „eingereicht“ (erneut prüfen).
  if v_profile.employment = 'fest' and v_job.date = v_now::date
     and ((p_action = 'start' and v_now::time < v_start) or (p_action = 'finish' and v_now::time > v_end)) then
    select * into v_overtime from public.tt_overtime
     where profile_id = auth.uid() and date = v_now::date and status in ('eingereicht', 'bestätigt')
     order by (status = 'eingereicht') desc, created_at desc limit 1;
    if found then
      v_new_start := case when p_action = 'start' then least(coalesce(v_overtime.start_time, v_now::time(0)), v_now::time(0)) else v_overtime.start_time end;
      v_new_end := case when p_action = 'finish' then greatest(coalesce(v_overtime.end_time, v_now::time(0)), v_now::time(0)) else v_overtime.end_time end;
      if v_new_start is distinct from v_overtime.start_time or v_new_end is distinct from v_overtime.end_time then
        update public.tt_overtime
           set start_time = v_new_start, end_time = v_new_end, status = 'eingereicht',
               review_note = case when status = 'bestätigt' then 'Zeit nach der Bestätigung geändert (Meldung im Portal) – bitte erneut prüfen.' else review_note end,
               reviewed_by = case when status = 'bestätigt' then '' else reviewed_by end,
               reviewed_at = case when status = 'bestätigt' then null else reviewed_at end
         where id = v_overtime.id returning * into v_overtime;
      end if;
    else
      insert into public.tt_overtime (profile_id, person_name, date, start_time, end_time, assignment_id, appointment, note)
      values (auth.uid(), coalesce(nullif(v_profile.full_name, ''), 'Unbekannt'), v_now::date,
              case when p_action = 'start' then v_now::time(0) end, case when p_action = 'finish' then v_now::time(0) end,
              v_job.id, left(v_job.title, 200), 'Automatisch eingetragen (Losfahren/Fertig im Portal)')
      returning * into v_overtime;
    end if;
    v_minutes := v_overtime.minutes_before + v_overtime.minutes_after;
  end if;

  return jsonb_build_object('status', v_job.work_status, 'started_at', v_job.started_at, 'finished_at', v_job.finished_at,
                            'overtime_minutes', v_minutes);
end;
$$;
revoke execute on function public.tt_assignment_progress(uuid, text) from public, anon;
grant execute on function public.tt_assignment_progress(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2 Zeitplan: alle 10 Minuten prüfen, wer erinnert werden muss
-- ---------------------------------------------------------------------------
-- Die Funktion "tt-push" entscheidet selbst: Fahrzeug-Rückgabe ab 16 Uhr (einmal am Tag),
-- offener Auftrag nach 4 Stunden und dann alle 2 Stunden (nachts zwischen 22 und 7 Uhr ist Ruhe).
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
select cron.unschedule(jobid) from cron.job where jobname in ('tt-rueckgabe-erinnerung', 'tt-erinnerungen');
select cron.schedule(
  'tt-erinnerungen',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://dvjfvbrvhurlagmgprsp.supabase.co/functions/v1/tt-push',
    headers := '{"Content-Type": "application/json", "apikey": "sb_publishable_bw7aJIwh_FxsCGxxyROIbg_4BG9kM0o"}'::jsonb,
    body := '{"action": "remind"}'::jsonb
  );
  $$
);
