-- Update 47: Freie Namen – Fahrzeug reservieren und Tankkarte ausgeben an Personen ohne Konto (z. B. Vizechef, Kollegen).
--   • tt_vehicles.driver_note (seit Update 41 nur für Heidelberg) gilt jetzt auch in Bonn: Der Admin trägt in der Fahrzeugakte
--     unter „Reserviert für“ einen beliebigen Namen ein. Ein so reserviertes Fahrzeug sehen die Dolmetscher im Portal nicht
--     und können es nicht übernehmen – genau wie bei einer Reservierung für eine Person mit Konto (assigned_to).
--   • tt_fuel_card_set: p_place darf jetzt jeder Name sein (nicht nur „Heidelberg“). Die Karte steht dann mit diesem Namen
--     im Verlauf, ohne Konto.
-- Kann beliebig oft ausgeführt werden.

-- Ein in Bonn mit Namen reserviertes Fahrzeug (ohne Konto) sieht nur das Büro – und wer es gerade hat.
drop policy if exists tt_vehicles_select on public.tt_vehicles;
create policy tt_vehicles_select on public.tt_vehicles for select to authenticated
  using (
    public.tt_is_member()
    and (
      public.tt_is_staff()
      or (station = 'Bonn' and ((assigned_to is null and driver_note = '') or assigned_to = (select auth.uid())))
      or public.tt_holds_vehicle(id)
    )
  );

-- Tankkarte an einen beliebigen Namen ausgeben (Person ohne Konto oder Standort).
create or replace function public.tt_fuel_card_set(p_card uuid, p_profile uuid default null, p_place text default '')
returns public.tt_fuel_cards
language plpgsql security definer set search_path = '' as $$
declare
  v_card public.tt_fuel_cards;
  v_person public.tt_profiles;
  v_admin text;
  v_place text := nullif(btrim(regexp_replace(coalesce(p_place, ''), '\s+', ' ', 'g')), '');
begin
  if not public.tt_is_admin() then
    raise exception 'Tankkarten darf nur der Admin ausgeben und zurücknehmen.';
  end if;
  if v_place is not null and length(v_place) > 80 then
    raise exception 'Der Name ist zu lang (höchstens 80 Zeichen).';
  end if;
  select * into v_card from public.tt_fuel_cards where id = p_card and active;
  if not found then
    raise exception 'Diese Tankkarte gibt es nicht (mehr).';
  end if;
  select coalesce(nullif(full_name, ''), 'Admin') into v_admin from public.tt_profiles where id = auth.uid();

  -- Zuerst die bisherige Ausgabe beenden (Person, Name oder Standort)
  if (v_card.holder_id is not null or v_card.holder_name <> '') and (v_card.holder_id is distinct from p_profile or v_place is not null or (v_card.holder_id is null and p_profile is null)) then
    if not (v_card.holder_id is null and v_place is not null and v_card.holder_name = v_place) then
      insert into public.tt_fuel_card_log (card_id, card_number, profile_id, profile_name, action, by_name)
      values (v_card.id, v_card.number, v_card.holder_id, v_card.holder_name, 'zurück', v_admin);
    end if;
  end if;

  -- An einen Namen ohne Konto (oder Standort Heidelberg) statt an eine Person mit Konto
  if v_place is not null then
    if v_card.holder_id is null and v_card.holder_name = v_place then
      return v_card;
    end if;
    update public.tt_fuel_cards
       set holder_id = null, holder_name = v_place, assigned_at = now(), assigned_by = v_admin
     where id = p_card returning * into v_card;
    insert into public.tt_fuel_card_log (created_at, card_id, card_number, profile_id, profile_name, action, by_name)
    values (clock_timestamp(), v_card.id, v_card.number, null, v_place, 'ausgegeben', v_admin);
    return v_card;
  end if;

  if p_profile is null then
    update public.tt_fuel_cards set holder_id = null, holder_name = '', assigned_at = null, assigned_by = ''
     where id = p_card returning * into v_card;
    return v_card;
  end if;

  if v_card.holder_id = p_profile then
    return v_card;
  end if;
  select * into v_person from public.tt_profiles where id = p_profile and active;
  if not found then
    raise exception 'Diese Person hat kein freigeschaltetes Konto.';
  end if;
  update public.tt_fuel_cards
     set holder_id = v_person.id, holder_name = coalesce(nullif(v_person.full_name, ''), 'Unbekannt'),
         assigned_at = now(), assigned_by = v_admin
   where id = p_card returning * into v_card;
  insert into public.tt_fuel_card_log (created_at, card_id, card_number, profile_id, profile_name, action, by_name)
  values (clock_timestamp(), v_card.id, v_card.number, v_person.id, v_card.holder_name, 'ausgegeben', v_admin);
  return v_card;
end;
$$;
revoke execute on function public.tt_fuel_card_set(uuid, uuid, text) from public, anon;
grant execute on function public.tt_fuel_card_set(uuid, uuid, text) to authenticated;

-- Übernahme im Portal: ein mit Namen reserviertes Fahrzeug (ohne Konto) kann kein Dolmetscher übernehmen.
create or replace function public.tt_take_vehicle(
  p_vehicle uuid,
  p_mileage integer default null,
  p_note text default '',
  p_emergency boolean default false,
  p_start_note text default ''
) returns public.tt_handovers
language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamp := now() at time zone 'Europe/Berlin';
  v_profile public.tt_profiles;
  v_name text;
  v_vehicle public.tt_vehicles;
  v_previous public.tt_handovers;
  v_row public.tt_handovers;
begin
  if not public.tt_is_member() then
    raise exception 'Dein Konto ist noch nicht freigeschaltet.';
  end if;
  select * into v_vehicle from public.tt_vehicles where id = p_vehicle and active;
  if not found then
    raise exception 'Dieses Fahrzeug gibt es nicht (mehr).';
  end if;
  if v_vehicle.service_status <> '' then
    raise exception 'Dieses Fahrzeug ist zurzeit nicht verfügbar (%). Bitte wähle ein anderes Fahrzeug.',
      case v_vehicle.service_status when 'werkstatt' then 'in der Werkstatt' else 'gesperrt' end;
  end if;
  if v_vehicle.assigned_to is not null and v_vehicle.assigned_to <> auth.uid() and not public.tt_is_staff() then
    raise exception 'Dieses Fahrzeug ist fest für eine andere Person reserviert.';
  end if;
  if v_vehicle.assigned_to is null and v_vehicle.driver_note <> '' and not public.tt_is_staff() then
    raise exception 'Dieses Fahrzeug ist fest reserviert für %.', v_vehicle.driver_note;
  end if;
  if p_mileage is not null and v_vehicle.mileage is not null and p_mileage < v_vehicle.mileage then
    raise exception 'Kilometerstand ist fehlerhaft: % km ist weniger als der letzte Stand (% km).', p_mileage, v_vehicle.mileage;
  end if;
  select * into v_profile from public.tt_profiles where id = auth.uid();
  v_name := coalesce(nullif(v_profile.full_name, ''), 'Unbekannt');
  if coalesce(p_emergency, false) and v_profile.employment <> 'fest' then
    raise exception 'Notdienst können nur fest angestellte Dolmetscher eintragen.';
  end if;

  select * into v_row from public.tt_handovers
   where vehicle_id = p_vehicle and driver_id = auth.uid() and end_time is null
   order by created_at desc limit 1;
  if found then
    return v_row;
  end if;

  -- Wer hatte das Fahrzeug zuletzt?
  select * into v_previous from public.tt_handovers
   where vehicle_id = p_vehicle and driver_id is distinct from auth.uid()
   order by created_at desc limit 1;

  update public.tt_handovers
     set end_time = v_now::time(0), end_date = v_now::date,
         end_mileage = case when vehicle_id = p_vehicle then coalesce(p_mileage, end_mileage) else end_mileage end
   where end_time is null and (vehicle_id = p_vehicle or driver_id = auth.uid());

  insert into public.tt_handovers (vehicle_id, driver_id, driver_name, date, start_time, start_mileage, note, created_by,
                                   emergency, start_note, previous_driver_id, previous_driver_name)
  values (p_vehicle, auth.uid(), v_name, v_now::date, v_now::time(0), p_mileage, coalesce(p_note, ''), auth.uid(),
          coalesce(p_emergency, false), left(coalesce(p_start_note, ''), 500), v_previous.driver_id, coalesce(v_previous.driver_name, ''))
  returning * into v_row;

  if p_mileage is not null then
    update public.tt_vehicles
       set mileage = p_mileage, state_updated_at = now(), state_updated_by = v_name
     where id = p_vehicle;
  end if;
  return v_row;
end;
$$;
revoke execute on function public.tt_take_vehicle(uuid, integer, text, boolean, text) from public, anon;
grant execute on function public.tt_take_vehicle(uuid, integer, text, boolean, text) to authenticated;
