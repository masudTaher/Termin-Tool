-- Update 28: Aufträge nachträglich abschließen.
-- Bleibt ein Auftrag an einem früheren Tag liegen (weder „Fertig“ gemeldet noch abgesagt, ausgefallen oder zurückgezogen), kann der
-- Dolmetscher ihn in der App nachträglich abschließen. Dabei wird auch der Termin im Tagesstand (tt_days) auf „beendet“ gesetzt –
-- mit dem Vermerk „Nachtrag_Abschluss“ (wann nachträglich abgeschlossen wurde). So zählt der Arbeitstag in „Meine Tage“ und in der
-- Abrechnung, ohne dass die Einsatzleitung den alten Tag öffnen muss. Geprüft wird am Monatsende wie bisher.
-- Alles Übrige an der Funktion ist unverändert (Stand Update 26). Mehrfach ausführbar.

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
  v_late boolean := false;
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

  -- Überstunden (nur fest angestellt, nur am Tag des Auftrags): vor Arbeitsbeginn losgefahren oder nach Arbeitsende fertig.
  -- Ein Eintrag je Tag: weitere Aufträge desselben Tages verlängern ihn, statt doppelt zu zählen.
  -- War der Eintrag schon bestätigt und die Zeit ändert sich, geht er zurück auf „eingereicht“ (erneut prüfen).
  -- Samstag und Sonntag zählt jede Stunde: Dann wird immer eingetragen (Beginn beim Losfahren, Ende beim Fertig).
  if v_profile.employment = 'fest' and v_job.date = v_now::date
     and (extract(isodow from v_now) >= 6
          or (p_action = 'start' and v_now::time < v_start) or (p_action = 'finish' and v_now::time > v_end)) then
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
                            'overtime_minutes', v_minutes, 'late', v_late);
end;
$$;

revoke execute on function public.tt_assignment_progress(uuid, text) from public, anon;
grant execute on function public.tt_assignment_progress(uuid, text) to authenticated;
