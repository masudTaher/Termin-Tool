-- Update 35: Keine automatischen Überstunden mehr.
-- Bisher trug die App Festangestellten beim „Losfahren“ vor 9 Uhr, beim „Fertig“ nach 16 Uhr und am Wochenende die Überstunden
-- von selbst ein. Das entfällt: Überstunden werden immer von Hand unter „Arbeitszeit“ gemeldet und von der Einsatzleitung geprüft.
-- Alles Übrige an der Funktion ist unverändert (Stand Update 28: Losfahren/Fertig, Nachtrag, Tagesstand). Mehrfach ausführbar.
-- Schon vorhandene automatische Einträge bleiben stehen (Vermerk „Automatisch eingetragen“) – prüfen oder löschen wie gewohnt.

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

  -- Überstunden werden NICHT mehr automatisch eingetragen (Update 35): Festangestellte tragen sie selbst unter „Arbeitszeit“ ein.

  return jsonb_build_object('status', v_job.work_status, 'started_at', v_job.started_at, 'finished_at', v_job.finished_at,
                            'overtime_minutes', v_minutes, 'late', v_late);
end;
$$;

revoke execute on function public.tt_assignment_progress(uuid, text) from public, anon;
grant execute on function public.tt_assignment_progress(uuid, text) to authenticated;
