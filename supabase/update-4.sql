-- Termin-Tool · Update 4: Übernahme mit letztem Stand, Hinweis an den Vorgänger, Notdienst, fest/temporär bei der Anmeldung
-- Im Supabase-Menü "SQL Editor" einfügen und mit "Run" ausführen. Kann erneut ausgeführt werden.
-- Voraussetzung: schema.sql, update-2.sql und update-3.sql wurden bereits ausgeführt.

alter table public.tt_handovers
  add column if not exists emergency boolean not null default false,            -- Notdienst / Bereitschaft: Auto bleibt über Nacht
  add column if not exists start_note text not null default '',                 -- Hinweis bei der Übernahme ("Angaben stimmen nicht …")
  add column if not exists note_seen boolean not null default false,            -- von der Einsatzleitung gelesen
  add column if not exists previous_driver_id uuid references public.tt_profiles (id) on delete set null,
  add column if not exists previous_driver_name text not null default '';

-- Bei der Registrierung gibt jede Person an, ob sie fest angestellt oder temporär ist.
-- Der Admin sieht die Angabe beim Freischalten und kann sie ändern.
create or replace function public.tt_handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  first_user boolean;
  v_employment text := coalesce(new.raw_user_meta_data ->> 'employment', 'temporär');
begin
  if v_employment not in ('fest', 'temporär') then
    v_employment := 'temporär';
  end if;
  select not exists (select 1 from public.tt_profiles) into first_user;
  insert into public.tt_profiles (id, full_name, phone, role, active, employment)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    coalesce(new.raw_user_meta_data ->> 'phone', ''),
    case when first_user then 'admin' else 'dolmetscher' end,
    first_user,
    v_employment
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Fahrzeug übernehmen: merkt sich den vorherigen Fahrer, einen Hinweis zum vorgefundenen Zustand
-- und (nur für fest Angestellte) die Markierung "Notdienst".
drop function if exists public.tt_take_vehicle(uuid, integer, text);
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
