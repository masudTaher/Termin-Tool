-- Medical Office Bonn · Transport und Dolmetscher · Update 15
-- 1) Dolmetscherinnen und Dolmetscher geben an: weiblich oder männlich (bei der Registrierung oder einmalig im Portal).
--    Außerdem merkt sich jedes Konto, wann es freigeschaltet wurde – so lässt sich „wartet auf Freischaltung“
--    von „gesperrt“ unterscheiden.
-- 2) Abwesenheiten der Festangestellten – getrennt erfasst: Urlaub, Krank, Verspätung, Fehlstunden, Notfall.
-- 3) „Kannst du morgen arbeiten?“: Tagesanfrage der Einsatzleitung an die temporären Dolmetscher.
-- 4) Merkzettel für automatische Mitteilungen (Wochenplan am Freitag um 15 Uhr, Erinnerung am Samstag und Sonntag)
--    und die Auskunft, wer Mitteilungen aufs Handy eingeschaltet hat.
-- Im Supabase-Menü "SQL Editor" einfügen und mit "Run" ausführen. Kann erneut ausgeführt werden.
-- Voraussetzung: schema.sql sowie update-2 bis update-14 wurden bereits ausgeführt.

-- ---------------------------------------------------------------------------
-- 1 Weiblich / männlich
-- ---------------------------------------------------------------------------
alter table public.tt_profiles
  add column if not exists gender text not null default '' check (gender in ('', 'weiblich', 'männlich')),
  add column if not exists approved_at timestamptz;            -- erste Freischaltung; leer = wartet noch
-- Konten, die schon freigeschaltet sind, gelten als freigeschaltet seit ihrer Anmeldung.
update public.tt_profiles set approved_at = created_at where active and approved_at is null;

-- Rolle, Freischaltung und Anstellung darf nur ein Admin ändern. Neu: Die erste Freischaltung wird mit Zeitpunkt gemerkt.
create or replace function public.tt_protect_profile_fields() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (new.role is distinct from old.role or new.active is distinct from old.active or new.employment is distinct from old.employment
      or new.approved_at is distinct from old.approved_at)
     and (select auth.uid()) is not null
     and not public.tt_is_admin() then
    raise exception 'Nur ein Admin darf Rolle, Freischaltung und Anstellung ändern.';
  end if;
  if new.active and not old.active and new.approved_at is null then
    new.approved_at := now();
  end if;
  return new;
end;
$$;

-- Registrierung: Name, Handy, Anstellung und jetzt auch weiblich/männlich kommen aus dem Anmeldeformular.
create or replace function public.tt_handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  first_user boolean;
  v_employment text := coalesce(new.raw_user_meta_data ->> 'employment', 'temporär');
  v_gender text := coalesce(new.raw_user_meta_data ->> 'gender', '');
begin
  if v_employment not in ('fest', 'temporär') then
    v_employment := 'temporär';
  end if;
  if v_gender not in ('weiblich', 'männlich') then
    v_gender := '';
  end if;
  select not exists (select 1 from public.tt_profiles) into first_user;
  insert into public.tt_profiles (id, full_name, phone, role, active, employment, gender, approved_at)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    coalesce(new.raw_user_meta_data ->> 'phone', ''),
    case when first_user then 'admin' else 'dolmetscher' end,
    first_user,
    v_employment,
    v_gender,
    case when first_user then now() end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2 Abwesenheiten der Festangestellten
-- ---------------------------------------------------------------------------
create table if not exists public.tt_absences (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),            -- bei Urlaub: wann beantragt
  profile_id uuid not null references public.tt_profiles (id) on delete cascade,
  person_name text not null default '',
  kind text not null check (kind in ('urlaub', 'krank', 'verspätung', 'fehlstunden', 'notfall')),
  date_from date not null,
  date_to date not null,
  minutes integer check (minutes is null or minutes between 1 and 1440),   -- Verspätung, Fehlstunden, Notfall: Dauer in Minuten
  days numeric(5,1) check (days is null or days between 0 and 366),        -- Urlaub, Krank: gezählte Tage, falls von Hand korrigiert
                                                                            -- (leer = Montag bis Freitag ohne Feiertage, halbe Tage möglich)
  note text not null default '',
  status text not null default 'beantragt' check (status in ('beantragt', 'genehmigt', 'abgelehnt')),
  created_by uuid default auth.uid(),
  created_by_name text not null default '',
  reviewed_by text not null default '',
  reviewed_at timestamptz,
  review_note text not null default '',
  constraint tt_absences_range check (date_to >= date_from)
);
alter table public.tt_absences
  add column if not exists days numeric(5,1) check (days is null or days between 0 and 366);
create index if not exists tt_absences_profile_idx on public.tt_absences (profile_id, date_from);
create index if not exists tt_absences_range_idx on public.tt_absences (date_from, date_to);

alter table public.tt_absences enable row level security;
revoke all on public.tt_absences from anon;
grant select, insert, update, delete on public.tt_absences to authenticated;

drop policy if exists tt_absences_select on public.tt_absences;
create policy tt_absences_select on public.tt_absences for select to authenticated
  using (public.tt_is_staff() or (public.tt_is_member() and profile_id = (select auth.uid())));
-- Die Person selbst: Urlaub beantragen, Krankheit oder Notfall melden – immer mit dem Stand „beantragt“.
-- Verspätung und Fehlstunden trägt nur die Einsatzleitung ein, ebenso eine korrigierte Zahl der Tage. Nur für fest Angestellte.
drop policy if exists tt_absences_insert_own on public.tt_absences;
create policy tt_absences_insert_own on public.tt_absences for insert to authenticated
  with check (
    public.tt_is_member() and profile_id = (select auth.uid()) and status = 'beantragt'
    and kind in ('urlaub', 'krank', 'notfall') and days is null and minutes is null
    and exists (select 1 from public.tt_profiles p where p.id = (select auth.uid()) and p.employment = 'fest')
  );
-- Zurückziehen geht, solange die Einsatzleitung noch nicht entschieden hat.
drop policy if exists tt_absences_delete_own on public.tt_absences;
create policy tt_absences_delete_own on public.tt_absences for delete to authenticated
  using (public.tt_is_member() and profile_id = (select auth.uid()) and status = 'beantragt');
-- Einsatzleitung und Sekretariat tragen ein und korrigieren; endgültig löschen darf nur der Admin.
-- (Ein falscher Eintrag lässt sich auch ohne Löschen aus der Zählung nehmen: Stand „abgelehnt“.)
drop policy if exists tt_absences_staff on public.tt_absences;
drop policy if exists tt_absences_staff_insert on public.tt_absences;
create policy tt_absences_staff_insert on public.tt_absences for insert to authenticated
  with check (public.tt_is_staff());
drop policy if exists tt_absences_staff_update on public.tt_absences;
create policy tt_absences_staff_update on public.tt_absences for update to authenticated
  using (public.tt_is_staff()) with check (public.tt_is_staff());
drop policy if exists tt_absences_admin_delete on public.tt_absences;
create policy tt_absences_admin_delete on public.tt_absences for delete to authenticated
  using (public.tt_is_admin());

-- ---------------------------------------------------------------------------
-- 3 Tagesanfrage: „Kannst du morgen arbeiten?“
-- ---------------------------------------------------------------------------
-- Ein Eintrag je Tag, für den die Einsatzleitung nachfragt. Die Antwort ist der Arbeitstag der Person
-- (Tabelle tt_workdays: verfügbar / nicht verfügbar).
create table if not exists public.tt_day_requests (
  date date primary key,
  asked_at timestamptz not null default now(),
  asked_by uuid default auth.uid(),
  asked_by_name text not null default '',
  note text not null default ''
);
alter table public.tt_day_requests enable row level security;
revoke all on public.tt_day_requests from anon;
grant select, insert, update, delete on public.tt_day_requests to authenticated;
drop policy if exists tt_day_requests_select on public.tt_day_requests;
create policy tt_day_requests_select on public.tt_day_requests for select to authenticated
  using (public.tt_is_member());
drop policy if exists tt_day_requests_staff on public.tt_day_requests;
create policy tt_day_requests_staff on public.tt_day_requests for all to authenticated
  using (public.tt_is_staff()) with check (public.tt_is_staff());

-- ---------------------------------------------------------------------------
-- 4 Automatische Mitteilungen
-- ---------------------------------------------------------------------------
-- Merkzettel der Server-Funktion: Jede automatische Mitteilung (z. B. „Wochenplan“ am Freitag) geht nur einmal hinaus.
-- Nur die Server-Funktion liest und schreibt hier.
create table if not exists public.tt_push_log (
  key text primary key,
  created_at timestamptz not null default now()
);
alter table public.tt_push_log enable row level security;
revoke all on public.tt_push_log from anon, authenticated;

-- Wer hat Mitteilungen aufs Handy eingeschaltet? (nur für Einsatzleitung und Sekretariat; ohne Geräte-Daten)
create or replace function public.tt_push_profiles() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select distinct s.profile_id from public.tt_push_subscriptions s where public.tt_is_staff();
$$;
revoke execute on function public.tt_push_profiles() from public, anon;
grant execute on function public.tt_push_profiles() to authenticated;
