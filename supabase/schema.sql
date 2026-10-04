-- Termin-Tool · Online-Datenbank (Supabase)
-- Einmal im Supabase-Menü "SQL Editor" einfügen und mit "Run" ausführen.
-- Das Skript kann gefahrlos erneut ausgeführt werden.
-- Alle Tabellen und Funktionen beginnen mit "tt_", damit sie sich nicht mit anderen
-- Tabellen im selben Projekt überschneiden.
-- Hier liegen nur Fahrzeuge, Übergaben, Schäden, Arbeitstage und Dolmetscher-Konten – keine Patientendaten.

-- ---------------------------------------------------------------------------
-- 1 Tabellen
-- ---------------------------------------------------------------------------
create table if not exists public.tt_profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null default '',
  phone text not null default '',
  role text not null default 'dolmetscher' check (role in ('admin', 'dolmetscher')),
  active boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.tt_vehicles (
  id uuid primary key default gen_random_uuid(),
  plate text not null,
  plate_key text not null unique,          -- Kennzeichen ohne Leerzeichen, in Großbuchstaben
  brand text not null default '',
  body text not null default '',           -- Kombi / Limousine / Bus
  type text not null default '',           -- Diplomatisch / Mietwagen
  label text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.tt_handovers (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references public.tt_vehicles (id) on delete cascade,
  driver_id uuid references public.tt_profiles (id) on delete set null,
  driver_name text not null,
  date date not null,
  start_time time not null,
  end_time time,
  start_mileage integer,
  end_mileage integer,
  note text not null default '',
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists tt_handovers_date_idx on public.tt_handovers (date);

create table if not exists public.tt_damages (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references public.tt_vehicles (id) on delete cascade,
  reporter_id uuid references public.tt_profiles (id) on delete set null,
  reporter_name text not null default '',
  description text not null,
  photo_path text not null default '',
  status text not null default 'offen' check (status in ('offen', 'in Arbeit', 'erledigt')),
  created_at timestamptz not null default now()
);

create table if not exists public.tt_workdays (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.tt_profiles (id) on delete cascade,
  date date not null,
  status text not null check (status in ('verfügbar', 'nicht verfügbar')),
  note text not null default '',
  created_at timestamptz not null default now(),
  unique (user_id, date)
);

-- ---------------------------------------------------------------------------
-- 2 Hilfsfunktionen für die Zugriffsregeln
-- ---------------------------------------------------------------------------
create or replace function public.tt_is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.tt_profiles where id = (select auth.uid()) and active);
$$;

create or replace function public.tt_is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.tt_profiles where id = (select auth.uid()) and active and role = 'admin');
$$;

-- Neues Konto -> Profil. Das allererste Konto wird Admin und ist sofort freigeschaltet,
-- alle weiteren warten auf die Freischaltung durch den Admin.
create or replace function public.tt_handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  first_user boolean;
begin
  select not exists (select 1 from public.tt_profiles) into first_user;
  insert into public.tt_profiles (id, full_name, phone, role, active)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    coalesce(new.raw_user_meta_data ->> 'phone', ''),
    case when first_user then 'admin' else 'dolmetscher' end,
    first_user
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists tt_on_auth_user_created on auth.users;
create trigger tt_on_auth_user_created
  after insert on auth.users
  for each row execute function public.tt_handle_new_user();

-- Rolle und Freischaltung darf nur ein Admin ändern (oder das Supabase-Dashboard).
create or replace function public.tt_protect_profile_fields() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (new.role is distinct from old.role or new.active is distinct from old.active)
     and (select auth.uid()) is not null
     and not public.tt_is_admin() then
    raise exception 'Nur ein Admin darf Rolle und Freischaltung ändern.';
  end if;
  return new;
end;
$$;

drop trigger if exists tt_protect_profile_fields on public.tt_profiles;
create trigger tt_protect_profile_fields
  before update on public.tt_profiles
  for each row execute function public.tt_protect_profile_fields();

-- Fahrzeug übernehmen: beendet die bisherige Nutzung des Fahrzeugs und ein anderes
-- Fahrzeug derselben Person, dann wird die neue Übernahme eingetragen.
create or replace function public.tt_take_vehicle(p_vehicle uuid, p_mileage integer default null, p_note text default '')
returns public.tt_handovers
language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamp := now() at time zone 'Europe/Berlin';
  v_name text;
  v_row public.tt_handovers;
begin
  if not public.tt_is_member() then
    raise exception 'Dein Konto ist noch nicht freigeschaltet.';
  end if;
  if not exists (select 1 from public.tt_vehicles where id = p_vehicle and active) then
    raise exception 'Dieses Fahrzeug gibt es nicht (mehr).';
  end if;
  select full_name into v_name from public.tt_profiles where id = auth.uid();

  select * into v_row from public.tt_handovers
   where vehicle_id = p_vehicle and driver_id = auth.uid() and date = v_now::date and end_time is null
   limit 1;
  if found then
    return v_row;
  end if;

  update public.tt_handovers
     set end_time = v_now::time(0),
         end_mileage = case when vehicle_id = p_vehicle then coalesce(p_mileage, end_mileage) else end_mileage end
   where date = v_now::date and end_time is null
     and (vehicle_id = p_vehicle or driver_id = auth.uid());

  insert into public.tt_handovers (vehicle_id, driver_id, driver_name, date, start_time, start_mileage, note, created_by)
  values (p_vehicle, auth.uid(), coalesce(nullif(v_name, ''), 'Unbekannt'), v_now::date, v_now::time(0), p_mileage, coalesce(p_note, ''), auth.uid())
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.tt_return_vehicle(p_mileage integer default null)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamp := now() at time zone 'Europe/Berlin';
  v_count integer;
begin
  update public.tt_handovers
     set end_time = v_now::time(0), end_mileage = coalesce(p_mileage, end_mileage)
   where driver_id = auth.uid() and date = v_now::date and end_time is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3 Zugriffsregeln (Row Level Security)
-- ---------------------------------------------------------------------------
alter table public.tt_profiles enable row level security;
alter table public.tt_vehicles enable row level security;
alter table public.tt_handovers enable row level security;
alter table public.tt_damages enable row level security;
alter table public.tt_workdays enable row level security;

revoke all on public.tt_profiles, public.tt_vehicles, public.tt_handovers, public.tt_damages, public.tt_workdays from anon;
grant select, insert, update, delete on public.tt_profiles, public.tt_vehicles, public.tt_handovers, public.tt_damages, public.tt_workdays to authenticated;
revoke execute on function public.tt_take_vehicle(uuid, integer, text), public.tt_return_vehicle(integer) from public, anon;
grant execute on function public.tt_take_vehicle(uuid, integer, text), public.tt_return_vehicle(integer), public.tt_is_member(), public.tt_is_admin() to authenticated;

-- Profile: jeder sieht sein eigenes, freigeschaltete Mitglieder sehen die Namen der Kollegen.
drop policy if exists tt_profiles_select on public.tt_profiles;
create policy tt_profiles_select on public.tt_profiles for select to authenticated
  using (id = (select auth.uid()) or public.tt_is_member());
drop policy if exists tt_profiles_update_own on public.tt_profiles;
create policy tt_profiles_update_own on public.tt_profiles for update to authenticated
  using (id = (select auth.uid()) or public.tt_is_admin())
  with check (id = (select auth.uid()) or public.tt_is_admin());
drop policy if exists tt_profiles_delete_admin on public.tt_profiles;
create policy tt_profiles_delete_admin on public.tt_profiles for delete to authenticated
  using (public.tt_is_admin());

-- Fahrzeuge: Mitglieder lesen, nur Admins ändern.
drop policy if exists tt_vehicles_select on public.tt_vehicles;
create policy tt_vehicles_select on public.tt_vehicles for select to authenticated using (public.tt_is_member());
drop policy if exists tt_vehicles_admin on public.tt_vehicles;
create policy tt_vehicles_admin on public.tt_vehicles for all to authenticated
  using (public.tt_is_admin()) with check (public.tt_is_admin());

-- Übergaben: Mitglieder lesen; eigene Einträge ändern; Admins alles.
-- (Die Übernahme selbst läuft über take_vehicle / return_vehicle.)
drop policy if exists tt_handovers_select on public.tt_handovers;
create policy tt_handovers_select on public.tt_handovers for select to authenticated using (public.tt_is_member());
drop policy if exists tt_handovers_update_own on public.tt_handovers;
create policy tt_handovers_update_own on public.tt_handovers for update to authenticated
  using (public.tt_is_member() and driver_id = (select auth.uid()))
  with check (public.tt_is_member() and driver_id = (select auth.uid()));
drop policy if exists tt_handovers_admin on public.tt_handovers;
create policy tt_handovers_admin on public.tt_handovers for all to authenticated
  using (public.tt_is_admin()) with check (public.tt_is_admin());

-- Schäden: Mitglieder lesen und melden; Status ändern nur Admins.
drop policy if exists tt_damages_select on public.tt_damages;
create policy tt_damages_select on public.tt_damages for select to authenticated using (public.tt_is_member());
drop policy if exists tt_damages_insert on public.tt_damages;
create policy tt_damages_insert on public.tt_damages for insert to authenticated
  with check (public.tt_is_member() and reporter_id = (select auth.uid()));
drop policy if exists tt_damages_admin on public.tt_damages;
create policy tt_damages_admin on public.tt_damages for all to authenticated
  using (public.tt_is_admin()) with check (public.tt_is_admin());

-- Arbeitstage: jeder pflegt seine eigenen; Admins sehen alle.
drop policy if exists tt_workdays_own on public.tt_workdays;
create policy tt_workdays_own on public.tt_workdays for all to authenticated
  using (public.tt_is_member() and user_id = (select auth.uid()))
  with check (public.tt_is_member() and user_id = (select auth.uid()));
drop policy if exists tt_workdays_admin on public.tt_workdays;
create policy tt_workdays_admin on public.tt_workdays for all to authenticated
  using (public.tt_is_admin()) with check (public.tt_is_admin());

-- ---------------------------------------------------------------------------
-- 4 Speicher für Schadensfotos (privat, nur für freigeschaltete Mitglieder)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('schaeden', 'schaeden', false)
on conflict (id) do nothing;

drop policy if exists schaeden_insert on storage.objects;
create policy schaeden_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'schaeden' and public.tt_is_member());
drop policy if exists schaeden_select on storage.objects;
create policy schaeden_select on storage.objects for select to authenticated
  using (bucket_id = 'schaeden' and public.tt_is_member());
drop policy if exists schaeden_delete_admin on storage.objects;
create policy schaeden_delete_admin on storage.objects for delete to authenticated
  using (bucket_id = 'schaeden' and public.tt_is_admin());
