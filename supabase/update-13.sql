-- Medical Office Bonn · Transport und Dolmetscher · Update 13
-- 1) Fuhrpark für viele Fahrzeuge: Status „Werkstatt“ / „gesperrt“ je Fahrzeug, Fahrzeug aus dem Fuhrpark nehmen
--    oder endgültig löschen (nur Admin). Gelöschte Kennzeichen werden gemerkt, damit kein anderes Gerät sie wieder anlegt.
-- Im Supabase-Menü "SQL Editor" einfügen und mit "Run" ausführen. Kann erneut ausgeführt werden.
-- Voraussetzung: schema.sql sowie update-2 bis update-12 wurden bereits ausgeführt.

-- ---------------------------------------------------------------------------
-- 1 Fuhrpark
-- ---------------------------------------------------------------------------
alter table public.tt_vehicles
  add column if not exists service_status text not null default '' check (service_status in ('', 'werkstatt', 'gesperrt')),
  add column if not exists service_note text not null default '',      -- z. B. „Inspektion bei Mercedes Bonn“
  add column if not exists service_since timestamptz,
  add column if not exists service_until date;                         -- voraussichtlich wieder da

-- Anlegen und ändern: Einsatzleitung und Sekretariat. Löschen: nur der Admin.
drop policy if exists tt_vehicles_admin on public.tt_vehicles;
drop policy if exists tt_vehicles_staff_insert on public.tt_vehicles;
create policy tt_vehicles_staff_insert on public.tt_vehicles for insert to authenticated
  with check (public.tt_is_staff());
drop policy if exists tt_vehicles_staff_update on public.tt_vehicles;
create policy tt_vehicles_staff_update on public.tt_vehicles for update to authenticated
  using (public.tt_is_staff()) with check (public.tt_is_staff());
drop policy if exists tt_vehicles_admin_delete on public.tt_vehicles;
create policy tt_vehicles_admin_delete on public.tt_vehicles for delete to authenticated
  using (public.tt_is_admin());

-- Gelöschte Kennzeichen: Jedes Gerät hat eine eigene Fahrzeugliste im Browser. Ohne diesen Merkzettel würde
-- ein Gerät, das das Fahrzeug noch kennt, es beim nächsten Abgleich wieder anlegen.
create table if not exists public.tt_vehicle_removed (
  plate_key text primary key,
  plate text not null default '',
  removed_at timestamptz not null default now(),
  removed_by text not null default ''
);
alter table public.tt_vehicle_removed enable row level security;
revoke all on public.tt_vehicle_removed from anon;
grant select on public.tt_vehicle_removed to authenticated;
drop policy if exists tt_vehicle_removed_select on public.tt_vehicle_removed;
create policy tt_vehicle_removed_select on public.tt_vehicle_removed for select to authenticated
  using (public.tt_is_staff());

create or replace function public.tt_vehicle_removed_note() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    insert into public.tt_vehicle_removed (plate_key, plate, removed_at, removed_by)
    values (old.plate_key, old.plate, now(), coalesce((select full_name from public.tt_profiles where id = auth.uid()), ''))
    on conflict (plate_key) do update set plate = excluded.plate, removed_at = excluded.removed_at, removed_by = excluded.removed_by;
    return old;
  end if;
  -- Dasselbe Kennzeichen wird später bewusst neu angelegt: Der Merkzettel gilt nicht mehr.
  delete from public.tt_vehicle_removed where plate_key = new.plate_key;
  return new;
end;
$$;
drop trigger if exists tt_vehicle_removed_note on public.tt_vehicles;
create trigger tt_vehicle_removed_note after insert or delete or update of plate_key on public.tt_vehicles
  for each row execute function public.tt_vehicle_removed_note();

-- Fahrzeug endgültig löschen – mit allen Fahrten, Schäden und Meldungen. Nur der Admin.
-- Antwort: Kennzeichen und die Fotos, die die App danach aus dem Speicher entfernt.
create or replace function public.tt_vehicle_delete(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_vehicle public.tt_vehicles;
  v_holder text;
  v_photos text[];
  v_trips integer;
  v_damages integer;
begin
  if not public.tt_is_admin() then
    raise exception 'Fahrzeuge darf nur der Admin endgültig löschen.';
  end if;
  select * into v_vehicle from public.tt_vehicles where id = p_id;
  if not found then
    raise exception 'Dieses Fahrzeug gibt es nicht (mehr).';
  end if;
  select driver_name into v_holder from public.tt_handovers where vehicle_id = p_id and end_time is null order by created_at desc limit 1;
  if found then
    raise exception 'Das Fahrzeug ist gerade ausgegeben (%). Bitte zuerst die Rückgabe eintragen.', v_holder;
  end if;
  select array_agg(distinct path) into v_photos from (
    select v_vehicle.photo_path as path
    union all select photo_path from public.tt_damages where vehicle_id = p_id
    union all select unnest(photo_paths) from public.tt_damages where vehicle_id = p_id
    union all select photo_path from public.tt_alerts where vehicle_id = p_id
  ) as found_paths where coalesce(path, '') <> '';
  select count(*) into v_trips from public.tt_handovers where vehicle_id = p_id;
  select count(*) into v_damages from public.tt_damages where vehicle_id = p_id;
  delete from public.tt_vehicles where id = p_id;      -- Fahrten, Schäden und Meldungen hängen daran und gehen mit
  return jsonb_build_object('plate', v_vehicle.plate, 'photos', coalesce(to_jsonb(v_photos), '[]'::jsonb),
                            'trips', v_trips, 'damages', v_damages);
end;
$$;
revoke execute on function public.tt_vehicle_delete(uuid) from public, anon;
grant execute on function public.tt_vehicle_delete(uuid) to authenticated;

-- Übernahme im Portal: Ein Fahrzeug in der Werkstatt oder ein gesperrtes Fahrzeug kann niemand übernehmen.
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
