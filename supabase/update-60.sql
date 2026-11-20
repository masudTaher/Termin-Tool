-- Update 60 (R98): Fahrzeuge zwischen Bonn und den Standorten der Kollegen (Heidelberg, Düsseldorf) bewegen.
--   • tt_vehicle_move(p_vehicle, p_to_station, p_note, p_partner, p_driver_note): Ein Fahrzeug wechselt den Standort –
--     „Zurück zu uns“ (Standort → Bonn), „Aus unserer Liste übernehmen“ (Bonn → Standort) oder Tausch (p_partner: das zweite
--     Fahrzeug geht den umgekehrten Weg). Beide Seiten werden im Verlauf (tt_vehicle_events, Art 'standort') festgehalten.
--     Ein Fahrzeug, das zu uns kommt, verliert den festen Fahrer des Kollegen (driver_note) und steht sofort zur Übernahme;
--     ein Fahrzeug, das zu den Kollegen geht, bekommt den Kollegen als festen Fahrer (p_driver_note) und ist in Bonn weg.
--   • Tausch gegen ein neues Kennzeichen (ATU, Vermieter) geht weiter über tt_vehicle_swap (Update 44) – auch für Standort-Fahrzeuge.
-- Kann beliebig oft ausgeführt werden.

alter table public.tt_vehicle_events drop constraint if exists tt_vehicle_events_kind_check;
alter table public.tt_vehicle_events add constraint tt_vehicle_events_kind_check check (kind in ('aufnahme', 'tausch', 'ersetzt', 'rueckgabe', 'sonstiges', 'wieder', 'standort'));

create or replace function public.tt_vehicle_move(p_vehicle uuid, p_to_station text, p_note text default '', p_partner uuid default null, p_driver_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_a public.tt_vehicles;
  v_b public.tt_vehicles;
  v_me text;
  v_from text;
  v_holder text;
  v_note text := left(coalesce(p_note, ''), 400);
begin
  if not public.tt_is_staff() then
    raise exception 'Das darf nur die Einsatzleitung.';
  end if;
  if p_to_station not in ('Bonn', 'Heidelberg', 'Düsseldorf') then
    raise exception 'Unbekannter Standort: %', p_to_station;
  end if;
  select coalesce(nullif(full_name, ''), 'Einsatzleitung') into v_me from public.tt_profiles where id = (select auth.uid());
  select * into v_a from public.tt_vehicles where id = p_vehicle and active;
  if v_a.id is null then
    raise exception 'Dieses Fahrzeug gibt es nicht (mehr) im Fuhrpark.';
  end if;
  if v_a.station = p_to_station then
    raise exception 'Das Fahrzeug steht schon in %.', p_to_station;
  end if;
  select driver_name into v_holder from public.tt_handovers where vehicle_id = v_a.id and end_time is null limit 1;
  if v_holder is not null then
    raise exception 'Das Fahrzeug ist gerade bei %. Bitte zuerst die Rückgabe eintragen.', v_holder;
  end if;
  v_from := v_a.station;

  if p_partner is not null then
    select * into v_b from public.tt_vehicles where id = p_partner and active;
    if v_b.id is null then
      raise exception 'Das Tauschfahrzeug gibt es nicht (mehr) im Fuhrpark.';
    end if;
    if v_b.id = v_a.id then
      raise exception 'Ein Fahrzeug kann nicht mit sich selbst getauscht werden.';
    end if;
    if v_b.station <> p_to_station then
      raise exception 'Das Tauschfahrzeug steht nicht in %, sondern in %.', p_to_station, v_b.station;
    end if;
    select driver_name into v_holder from public.tt_handovers where vehicle_id = v_b.id and end_time is null limit 1;
    if v_holder is not null then
      raise exception 'Das Tauschfahrzeug ist gerade bei %. Bitte zuerst die Rückgabe eintragen.', v_holder;
    end if;
  end if;

  -- Fahrzeug A: an den neuen Standort
  update public.tt_vehicles
     set station = p_to_station,
         driver_note = case when p_to_station = 'Bonn' then '' else coalesce(nullif(btrim(p_driver_note), ''), '') end,
         assigned_to = null, preferred_driver = case when p_to_station = 'Bonn' then preferred_driver else null end,
         service_status = '', service_note = '', service_since = null, service_until = null,
         state_updated_at = now(), state_updated_by = v_me
   where id = v_a.id;
  insert into public.tt_vehicle_events (vehicle_id, kind, other_vehicle_id, other_plate, note, mileage, created_by)
  values (v_a.id, 'standort', v_b.id, coalesce(v_b.plate, ''),
          'Standort ' || v_from || ' → ' || p_to_station || case when v_b.id is not null then ' (Tausch mit ' || v_b.plate || ')' else '' end || case when v_note <> '' then ' – ' || v_note else '' end,
          v_a.mileage, v_me);

  -- Fahrzeug B (Tausch): den umgekehrten Weg
  if v_b.id is not null then
    update public.tt_vehicles
       set station = v_from,
           driver_note = case when v_from = 'Bonn' then '' else coalesce(nullif(btrim(p_driver_note), ''), nullif(btrim(v_a.driver_note), ''), '') end,
           assigned_to = null, preferred_driver = case when v_from = 'Bonn' then preferred_driver else null end,
           service_status = '', service_note = '', service_since = null, service_until = null,
           state_updated_at = now(), state_updated_by = v_me
     where id = v_b.id;
    insert into public.tt_vehicle_events (vehicle_id, kind, other_vehicle_id, other_plate, note, mileage, created_by)
    values (v_b.id, 'standort', v_a.id, v_a.plate,
            'Standort ' || p_to_station || ' → ' || v_from || ' (Tausch mit ' || v_a.plate || ')' || case when v_note <> '' then ' – ' || v_note else '' end,
            v_b.mileage, v_me);
  end if;

  return jsonb_build_object('vehicle', v_a.id, 'plate', v_a.plate, 'from', v_from, 'to', p_to_station, 'partner', v_b.id, 'partner_plate', v_b.plate);
end;
$$;
revoke execute on function public.tt_vehicle_move(uuid, text, text, uuid, text) from public, anon;
grant execute on function public.tt_vehicle_move(uuid, text, text, uuid, text) to authenticated;

notify pgrst, 'reload schema';
