-- Termin-Tool · Update 2: Fahrzeugakten
-- Schadensskizze mit Altschäden, Fehlermeldungen (Reifendruck, AdBlue, Service …),
-- Kilometer-Prüfung, Tankstand, Parkort, Sauberkeit, feste und temporäre Dolmetscher.
-- Im Supabase-Menü "SQL Editor" einfügen und mit "Run" ausführen. Kann erneut ausgeführt werden.
-- Voraussetzung: supabase/schema.sql wurde bereits ausgeführt.

-- ---------------------------------------------------------------------------
-- 1 Neue Spalten
-- ---------------------------------------------------------------------------
alter table public.tt_profiles
  add column if not exists employment text not null default 'temporär' check (employment in ('fest', 'temporär'));

alter table public.tt_vehicles
  add column if not exists assigned_to uuid references public.tt_profiles (id) on delete set null,  -- fester Fahrer
  add column if not exists mileage integer,
  add column if not exists fuel smallint check (fuel between 0 and 4),       -- 0 = leer, 4 = voll
  add column if not exists parking text not null default '',
  add column if not exists clean_inside boolean,
  add column if not exists clean_outside boolean,
  add column if not exists state_updated_at timestamptz,
  add column if not exists state_updated_by text not null default '';

alter table public.tt_handovers
  add column if not exists end_date date,
  add column if not exists end_fuel smallint,
  add column if not exists end_parking text,
  add column if not exists end_clean_inside boolean,
  add column if not exists end_clean_outside boolean;

alter table public.tt_damages
  add column if not exists pos_x real,                    -- Position auf der Skizze (0 … 1)
  add column if not exists pos_y real,
  add column if not exists zone text not null default '', -- z. B. "hinten rechts"
  add column if not exists photo_paths text[] not null default '{}',
  add column if not exists resolved_at timestamptz;

-- Schadensstatus: offen = neu gemeldet, bekannt = Altschaden, in Arbeit = in Reparatur, erledigt = behoben (Archiv)
alter table public.tt_damages drop constraint if exists tt_damages_status_check;
alter table public.tt_damages add constraint tt_damages_status_check
  check (status in ('offen', 'bekannt', 'in Arbeit', 'erledigt'));

-- ---------------------------------------------------------------------------
-- 2 Fehlermeldungen (Warnleuchten und Wartung)
-- ---------------------------------------------------------------------------
create table if not exists public.tt_alerts (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references public.tt_vehicles (id) on delete cascade,
  reporter_id uuid references public.tt_profiles (id) on delete set null,
  reporter_name text not null default '',
  kind text not null,
  note text not null default '',
  photo_path text not null default '',
  status text not null default 'offen' check (status in ('offen', 'erledigt')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text not null default ''
);

alter table public.tt_alerts enable row level security;
revoke all on public.tt_alerts from anon;
grant select, insert, update, delete on public.tt_alerts to authenticated;

drop policy if exists tt_alerts_select on public.tt_alerts;
create policy tt_alerts_select on public.tt_alerts for select to authenticated using (public.tt_is_member());
drop policy if exists tt_alerts_insert on public.tt_alerts;
create policy tt_alerts_insert on public.tt_alerts for insert to authenticated
  with check (public.tt_is_member() and reporter_id = (select auth.uid()));
drop policy if exists tt_alerts_admin on public.tt_alerts;
create policy tt_alerts_admin on public.tt_alerts for all to authenticated
  using (public.tt_is_admin()) with check (public.tt_is_admin());

-- ---------------------------------------------------------------------------
-- 3 Funktionen
-- ---------------------------------------------------------------------------
-- Auch "fest / temporär" darf nur ein Admin ändern.
create or replace function public.tt_protect_profile_fields() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (new.role is distinct from old.role or new.active is distinct from old.active or new.employment is distinct from old.employment)
     and (select auth.uid()) is not null
     and not public.tt_is_admin() then
    raise exception 'Nur ein Admin darf Rolle, Freischaltung und Anstellung ändern.';
  end if;
  return new;
end;
$$;

-- Fahrzeug übernehmen – mit Kilometer-Prüfung.
create or replace function public.tt_take_vehicle(p_vehicle uuid, p_mileage integer default null, p_note text default '')
returns public.tt_handovers
language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamp := now() at time zone 'Europe/Berlin';
  v_name text;
  v_vehicle public.tt_vehicles;
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
  select nullif(full_name, '') into v_name from public.tt_profiles where id = auth.uid();
  v_name := coalesce(v_name, 'Unbekannt');

  select * into v_row from public.tt_handovers
   where vehicle_id = p_vehicle and driver_id = auth.uid() and end_time is null
   order by created_at desc limit 1;
  if found then
    return v_row;
  end if;

  -- Bisherige Nutzung dieses Fahrzeugs und ein anderes Fahrzeug derselben Person beenden.
  update public.tt_handovers
     set end_time = v_now::time(0), end_date = v_now::date,
         end_mileage = case when vehicle_id = p_vehicle then coalesce(p_mileage, end_mileage) else end_mileage end
   where end_time is null and (vehicle_id = p_vehicle or driver_id = auth.uid());

  insert into public.tt_handovers (vehicle_id, driver_id, driver_name, date, start_time, start_mileage, note, created_by)
  values (p_vehicle, auth.uid(), v_name, v_now::date, v_now::time(0), p_mileage, coalesce(p_note, ''), auth.uid())
  returning * into v_row;

  if p_mileage is not null then
    update public.tt_vehicles
       set mileage = p_mileage, state_updated_at = now(), state_updated_by = v_name
     where id = p_vehicle;
  end if;
  return v_row;
end;
$$;

-- Fahrzeug zurückgeben – mit Kilometerstand, Tank, Parkort und Sauberkeit.
drop function if exists public.tt_return_vehicle(integer);
create or replace function public.tt_return_vehicle(
  p_mileage integer default null,
  p_fuel integer default null,
  p_parking text default '',
  p_clean_inside boolean default null,
  p_clean_outside boolean default null
) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamp := now() at time zone 'Europe/Berlin';
  v_name text;
  v_handover public.tt_handovers;
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

  for v_handover in
    select * from public.tt_handovers where driver_id = auth.uid() and end_time is null
  loop
    select mileage into v_last from public.tt_vehicles where id = v_handover.vehicle_id;
    if p_mileage is not null and v_last is not null and p_mileage < v_last then
      raise exception 'Kilometerstand ist fehlerhaft: % km ist weniger als der letzte Stand (% km).', p_mileage, v_last;
    end if;
    update public.tt_handovers
       set end_time = v_now::time(0), end_date = v_now::date,
           end_mileage = coalesce(p_mileage, end_mileage),
           end_fuel = p_fuel, end_parking = coalesce(p_parking, ''),
           end_clean_inside = p_clean_inside, end_clean_outside = p_clean_outside
     where id = v_handover.id;
    update public.tt_vehicles
       set mileage = coalesce(p_mileage, mileage),
           fuel = coalesce(p_fuel, fuel),
           parking = coalesce(nullif(p_parking, ''), parking),
           clean_inside = coalesce(p_clean_inside, clean_inside),
           clean_outside = coalesce(p_clean_outside, clean_outside),
           state_updated_at = now(), state_updated_by = v_name
     where id = v_handover.vehicle_id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke execute on function public.tt_return_vehicle(integer, integer, text, boolean, boolean) from public, anon;
grant execute on function public.tt_return_vehicle(integer, integer, text, boolean, boolean) to authenticated;
