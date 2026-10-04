-- Medical Office Bonn · Transport und Dolmetscher · Update 9
-- 1) Reservierte Fahrzeuge: Ein fest zugewiesenes Fahrzeug sieht und übernimmt nur die zugewiesene Person
--    (Einsatzleitung und Sekretariat sehen weiterhin alles).
-- 2) Fahrzeugfoto: Zu jedem Fahrzeug kann ein eigenes Foto hinterlegt werden.
-- Im Supabase-Menü "SQL Editor" einfügen und mit "Run" ausführen. Kann erneut ausgeführt werden.
-- Voraussetzung: schema.sql sowie update-2 bis update-8 wurden bereits ausgeführt.

-- ---------- 1) Reservierte Fahrzeuge ----------
drop policy if exists tt_vehicles_select on public.tt_vehicles;
create policy tt_vehicles_select on public.tt_vehicles for select to authenticated
  using (
    public.tt_is_member()
    and (
      public.tt_is_staff()
      or assigned_to is null
      or assigned_to = (select auth.uid())
      or public.tt_holds_vehicle(id)
    )
  );

-- Übernahme: zusätzlich in der Datenbank abgesichert, damit niemand ein reserviertes Fahrzeug nimmt.
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
  if v_vehicle.assigned_to is not null and v_vehicle.assigned_to <> auth.uid() and not public.tt_is_staff() then
    raise exception 'Dieses Fahrzeug ist fest für eine andere Person reserviert.';
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

-- ---------- 2) Fahrzeugfoto ----------
alter table public.tt_vehicles add column if not exists photo_path text;
