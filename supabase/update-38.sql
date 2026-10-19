-- Update 38: Pforte – mehrere Fahrten am Tag erkennen.
-- Wer zwei Termine hat (9:30 und 15:00), kommt oft zwischendurch zurück. Die Pforte soll sofort sehen, dass nur der erste Termin
-- erledigt ist, die Rückkehr eintragen – und die nächste Ausfahrt wieder anmelden, damit jede Bewegung erfasst ist.
--   • tt_gate_jobs(p_date): Stand der Aufträge (losgefahren / fertig / ausgefallen) für alle, die an dem Tag an der Pforte gemeldet
--     sind – ohne Patientendaten. Nur Pforte und Büro.
--   • tt_gate_again(p_id, p_stops): „Fährt wieder raus“ – die Pforte legt für eine zurückgekehrte Person die nächste Ausfahrt an
--     (mit den noch offenen Terminen), sofort bestätigt. Der Fahrer sieht sie in seiner App; „Jetzt losfahren“ meldet dann nicht doppelt.
--   • tt_gate.final + tt_gate_done(p_id, p_done): „Heute fertig“ – die Person ist zurück und fährt nicht mehr, auch wenn noch ein
--     Termin offen steht. Sonst bleibt sie auf der Anzeige als „im Haus – fährt wieder hinaus“ stehen.
-- Braucht Update 31. Kann beliebig oft ausgeführt werden.

alter table public.tt_gate add column if not exists final boolean not null default false;

create or replace function public.tt_gate_jobs(p_date date)
returns table (profile_id uuid, assignment_id uuid, appointment_time text, title text, started_at timestamptz, finished_at timestamptz, storno_at timestamptz, work_status text)
language sql stable security definer set search_path = '' as $$
  select a.interpreter_id, a.id, coalesce(a.time, ''), coalesce(a.title, ''), a.started_at, a.finished_at, a.storno_at, coalesce(a.work_status, '')
    from public.tt_assignments a
   where (public.tt_is_gate() or public.tt_is_staff())
     and a.date = p_date and not a.cancelled and a.response <> 'abgesagt'
     and exists (select 1 from public.tt_gate g where g.profile_id = a.interpreter_id and g.date = p_date)
   order by a.time;
$$;
revoke execute on function public.tt_gate_jobs(date) from public, anon;
grant execute on function public.tt_gate_jobs(date) to authenticated;

-- Beim Anlegen durch die Pforte bleibt die Person des Fahrers stehen (sonst stempelt tt_gate_stamp den Anmelder).
create or replace function public.tt_gate_stamp() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if current_setting('tt.gate_again', true) = '1' then
    return new;
  end if;
  if (select auth.uid()) is not null then
    new.profile_id := (select auth.uid());
    new.driver_name := coalesce((select full_name from public.tt_profiles where id = (select auth.uid())), '');
    new.out_at := now();
    new.date := (now() at time zone 'Europe/Berlin')::date;
    new.in_at := null;
    new.in_by := '';
    new.out_confirmed_at := null;
    new.out_by := '';
  end if;
  return new;
end;
$$;

create or replace function public.tt_gate_again(p_id uuid, p_stops jsonb default '[]'::jsonb) returns public.tt_gate
language plpgsql security definer set search_path = '' as $$
declare
  v_old public.tt_gate;
  v_row public.tt_gate;
  v_name text;
  v_first jsonb;
begin
  if not (public.tt_is_gate() or public.tt_is_staff()) then
    raise exception 'Das darf nur die Pforte oder die Einsatzleitung.';
  end if;
  select * into v_old from public.tt_gate where id = p_id;
  if v_old.id is null then
    raise exception 'Diese Meldung gibt es nicht (mehr).';
  end if;
  if v_old.in_at is null then
    raise exception 'Die Person ist noch draußen – bitte zuerst „Ist zurück“ eintragen.';
  end if;
  if exists (select 1 from public.tt_gate where profile_id = v_old.profile_id and in_at is null) then
    raise exception 'Für diese Person ist schon eine neue Ausfahrt angemeldet.';
  end if;
  if jsonb_typeof(p_stops) <> 'array' then p_stops := '[]'::jsonb; end if;
  select full_name into v_name from public.tt_profiles where id = (select auth.uid());
  v_first := coalesce(p_stops -> 0, '{}'::jsonb);
  perform set_config('tt.gate_again', '1', true);
  insert into public.tt_gate (date, profile_id, driver_name, assignment_id, plate, vehicle, appointment_time, doctor, city, patient_name, patient_nr, note, stops,
                              out_at, in_at, in_by, out_confirmed_at, out_by)
  values ((now() at time zone 'Europe/Berlin')::date, v_old.profile_id, v_old.driver_name, null, v_old.plate, v_old.vehicle,
          coalesce(v_first ->> 'time', ''), coalesce(v_first ->> 'doctor', ''), coalesce(v_first ->> 'city', ''), coalesce(v_first ->> 'patient_name', ''), coalesce(v_first ->> 'patient_nr', ''),
          'Weiterfahrt zum nächsten Termin', p_stops, now(), null, '', now(), coalesce(v_name, ''))
  returning * into v_row;
  perform set_config('tt.gate_again', '', true);
  return v_row;
end;
$$;
revoke execute on function public.tt_gate_again(uuid, jsonb) from public, anon;
grant execute on function public.tt_gate_again(uuid, jsonb) to authenticated;

-- „Heute fertig“ / „Fährt doch wieder raus“: Pforte und Büro.
create or replace function public.tt_gate_done(p_id uuid, p_done boolean default true) returns public.tt_gate
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.tt_gate;
begin
  if not (public.tt_is_gate() or public.tt_is_staff()) then
    raise exception 'Das darf nur die Pforte oder die Einsatzleitung.';
  end if;
  update public.tt_gate set final = p_done where id = p_id and in_at is not null returning * into v_row;
  if v_row.id is null then
    raise exception 'Diese Meldung gibt es nicht (mehr) oder die Person ist noch draußen.';
  end if;
  return v_row;
end;
$$;
revoke execute on function public.tt_gate_done(uuid, boolean) from public, anon;
grant execute on function public.tt_gate_done(uuid, boolean) to authenticated;

-- „Doch nicht zurück“ nimmt auch „Heute fertig“ zurück.
create or replace function public.tt_gate_return(p_id uuid, p_back boolean default true) returns public.tt_gate
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.tt_gate;
  v_name text;
begin
  if not (public.tt_is_gate() or public.tt_is_staff()) then
    raise exception 'Das darf nur die Pforte oder die Einsatzleitung.';
  end if;
  select full_name into v_name from public.tt_profiles where id = (select auth.uid());
  update public.tt_gate
     set in_at = case when p_back then coalesce(in_at, now()) else null end,
         in_by = case when p_back then coalesce(nullif(in_by, ''), coalesce(v_name, '')) else '' end,
         out_confirmed_at = case when p_back then coalesce(out_confirmed_at, out_at) else out_confirmed_at end,
         final = case when p_back then final else false end
   where id = p_id
   returning * into v_row;
  if v_row.id is null then
    raise exception 'Diese Meldung gibt es nicht (mehr).';
  end if;
  return v_row;
end;
$$;
