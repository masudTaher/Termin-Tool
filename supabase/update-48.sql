-- Update 48: Rückgabe bei mehreren offenen Übernahmen; Pforte: Termine bleiben aktuell, wenn das Büro sie ändert oder zurücknimmt.
--   • tt_return_vehicle bekommt p_handover: Zurückgegeben wird genau die Übernahme, die die App zeigt. Der Kilometerstand wird nur
--     gegen DIESES Fahrzeug geprüft. Weitere offene Übernahmen derselben Person (z. B. vom Büro im Live-Tracking eingetragen,
--     ohne Kilometer) werden still beendet – bisher scheiterte die Rückgabe daran („Kilometerstand ist fehlerhaft“, zurück zu Schritt 1).
--   • Aufräumen: Hat jemand heute mehr als eine offene Übernahme, bleibt die mit Kilometerstand (sonst die neueste) offen; die
--     anderen werden beendet. Das Büro kann es unter „Übergaben“ jederzeit korrigieren.
--   • tt_gate.stops_changed_at und Trigger auf tt_assignments: Ändert das Büro einen Auftrag (Uhrzeit, Arzt, Ort) oder nimmt ihn
--     zurück, werden die Termine in der offenen Pforten-Meldung der Person nachgezogen – zurückgenommene bleiben als „zurückgenommen“
--     stehen (cancelled = true), geänderte zeigen die neuen Angaben, neue Aufträge werden angehängt, „Fertig“ setzt done.
--     Die App schreibt die Termine seitdem nicht mehr selbst (sie würde mit altem Stand überschreiben).
-- Kann beliebig oft ausgeführt werden.

-- ---------- 1. Rückgabe: genau die gezeigte Übernahme ----------
drop function if exists public.tt_return_vehicle(integer, integer, text, boolean, boolean);
create or replace function public.tt_return_vehicle(
  p_mileage integer default null,
  p_fuel integer default null,
  p_parking text default '',
  p_clean_inside boolean default null,
  p_clean_outside boolean default null,
  p_handover uuid default null
) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamp := now() at time zone 'Europe/Berlin';
  v_name text;
  v_target public.tt_handovers;
  v_other public.tt_handovers;
  v_last integer;
  v_count integer := 0;
begin
  if not public.tt_is_member() then
    raise exception 'Dein Konto ist noch nicht freigeschaltet.';
  end if;
  if p_fuel is not null and (p_fuel < 0 or p_fuel > 4) then
    raise exception 'Der Tankstand ist ungültig.';
  end if;
  select nullif(full_name, '') into v_name from public.tt_profiles where id = auth.uid();
  v_name := coalesce(v_name, 'Unbekannt');

  -- Die Übernahme, die zurückgegeben wird: die gewählte – sonst die neueste mit Kilometerstand, sonst die neueste.
  if p_handover is not null then
    select * into v_target from public.tt_handovers where id = p_handover and driver_id = auth.uid() and end_time is null;
  end if;
  if v_target.id is null then
    select * into v_target from public.tt_handovers where driver_id = auth.uid() and end_time is null
     order by (start_mileage is not null) desc, created_at desc limit 1;
  end if;
  if v_target.id is null then
    raise exception 'Du hast gerade kein Fahrzeug.';
  end if;

  select mileage into v_last from public.tt_vehicles where id = v_target.vehicle_id;
  if p_mileage is not null and v_last is not null and p_mileage < v_last then
    raise exception 'Kilometerstand ist fehlerhaft: % km ist weniger als der letzte Stand (% km).', p_mileage, v_last;
  end if;
  update public.tt_handovers
     set end_time = v_now::time(0), end_date = v_now::date,
         end_mileage = coalesce(p_mileage, end_mileage),
         end_fuel = p_fuel, end_parking = coalesce(p_parking, ''),
         end_clean_inside = p_clean_inside, end_clean_outside = p_clean_outside
   where id = v_target.id;
  update public.tt_vehicles
     set mileage = coalesce(p_mileage, mileage),
         fuel = coalesce(p_fuel, fuel),
         parking = coalesce(nullif(p_parking, ''), parking),
         clean_inside = coalesce(p_clean_inside, clean_inside),
         clean_outside = coalesce(p_clean_outside, clean_outside),
         state_updated_at = now(), state_updated_by = v_name
   where id = v_target.vehicle_id;
  v_count := 1;

  -- Weitere offene Übernahmen derselben Person: nur beenden (kein Kilometerstand, kein Fahrzeugstand).
  for v_other in select * from public.tt_handovers where driver_id = auth.uid() and end_time is null and id <> v_target.id loop
    update public.tt_handovers
       set end_time = v_now::time(0), end_date = v_now::date,
           note = left(btrim(concat_ws(' · ', nullif(note, ''), 'automatisch beendet bei Rückgabe von ' || (select plate from public.tt_vehicles where id = v_target.vehicle_id))), 500)
     where id = v_other.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke execute on function public.tt_return_vehicle(integer, integer, text, boolean, boolean, uuid) from public, anon;
grant execute on function public.tt_return_vehicle(integer, integer, text, boolean, boolean, uuid) to authenticated;

-- ---------- 2. Aufräumen: doppelte offene Übernahmen ----------
with ranked as (
  select id, driver_id, vehicle_id,
         row_number() over (partition by driver_id order by (start_mileage is not null) desc, created_at desc) as rn
    from public.tt_handovers
   where end_time is null and driver_id is not null
)
update public.tt_handovers h
   set end_time = (now() at time zone 'Europe/Berlin')::time(0), end_date = (now() at time zone 'Europe/Berlin')::date,
       note = left(btrim(concat_ws(' · ', nullif(h.note, ''), 'automatisch beendet (doppelte offene Übernahme, Update 48)')), 500)
  from ranked r
 where h.id = r.id and r.rn > 1;

-- ---------- 3. Pforte: Termine aktuell halten ----------
alter table public.tt_gate add column if not exists stops_changed_at timestamptz;

create or replace function public.tt_gate_assignment_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.tt_gate;
  v_stop jsonb;
  v_new jsonb;
  v_stops jsonb;
  v_found boolean;
  v_gone boolean;
  v_changed boolean;
  v_time text := left(coalesce(new.time, ''), 5);
  v_parts text[];
  v_doctor text;
  v_city text;
  v_patient text;
  v_nr text;
begin
  if tg_op = 'UPDATE' and (old.cancelled, old.time, old.title, old.message, old.date, old.interpreter_id, old.storno_at, old.finished_at)
     is not distinct from (new.cancelled, new.time, new.title, new.message, new.date, new.interpreter_id, new.storno_at, new.finished_at) then
    return new;
  end if;
  -- Titel: „HH:MM Uhr · Arzt · Ort“; Patient und Aktennummer stehen als *Feld: Wert* im Text des Auftrags.
  v_parts := array(select p from unnest(string_to_array(coalesce(new.title, ''), ' · ')) as p where p !~ '^\d{1,2}:\d{2} Uhr$');
  v_doctor := coalesce(v_parts[1], '');
  v_city := coalesce(array_to_string(v_parts[2:], ' · '), '');
  v_patient := btrim(coalesce(substring(coalesce(new.message, '') from '\*(?:Haupt)?[Pp]atient/in:\s*([^*\r\n]+)\*'), ''));
  v_nr := btrim(coalesce(substring(coalesce(new.message, '') from '\*Aktennummer:\s*([^*\r\n]+)\*'), ''));

  for v_row in
    select * from public.tt_gate g
     where g.in_at is null
       and (g.stops @> jsonb_build_array(jsonb_build_object('assignment_id', new.id::text))
            or (g.profile_id = new.interpreter_id and g.date = new.date))
  loop
    v_gone := new.cancelled or new.storno_at is not null or new.interpreter_id is distinct from v_row.profile_id or new.date <> v_row.date;
    v_stops := '[]'::jsonb; v_found := false; v_changed := false;
    for v_stop in select value from jsonb_array_elements(coalesce(v_row.stops, '[]'::jsonb)) loop
      if v_stop ->> 'assignment_id' = new.id::text then
        v_found := true;
        v_new := v_stop || jsonb_build_object('cancelled', v_gone);
        if not v_gone then
          v_new := v_new || jsonb_build_object(
            'time', v_time,
            'doctor', case when v_doctor <> '' then v_doctor else coalesce(v_stop ->> 'doctor', '') end,
            'city', case when v_doctor <> '' then v_city else coalesce(v_stop ->> 'city', '') end,
            'patient_name', coalesce(nullif(v_patient, ''), v_stop ->> 'patient_name', ''),
            'patient_nr', coalesce(nullif(v_nr, ''), v_stop ->> 'patient_nr', ''),
            'done', coalesce(new.finished_at::text, ''));
        end if;
        if v_new <> v_stop then v_changed := true; end if;
        v_stops := v_stops || v_new;
      else
        v_stops := v_stops || v_stop;
      end if;
    end loop;
    -- Neuer Auftrag für jemanden, der gerade draußen ist: anhängen.
    if not v_found and not v_gone and (new.finished_at is null) then
      v_stops := v_stops || jsonb_build_object('time', v_time, 'doctor', v_doctor, 'city', v_city, 'patient_name', v_patient, 'patient_nr', v_nr,
                                               'assignment_id', new.id::text, 'done', '', 'added', true);
      v_changed := true;
    end if;
    if v_changed then
      select coalesce(jsonb_agg(s order by s ->> 'time', ordinality), '[]'::jsonb) into v_stops
        from jsonb_array_elements(v_stops) with ordinality as t(s, ordinality);
      update public.tt_gate set stops = v_stops, stops_changed_at = now() where id = v_row.id;
    end if;
  end loop;
  return new;
end;
$$;
drop trigger if exists tt_gate_assignment_changed on public.tt_assignments;
create trigger tt_gate_assignment_changed after insert or update on public.tt_assignments
  for each row execute function public.tt_gate_assignment_changed();
