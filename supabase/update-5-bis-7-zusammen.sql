-- Botschaft Dolmetscher und Transport-App · Updates 5, 6 und 7 in einem Schritt
-- Alles markieren, im Supabase-Menü "SQL Editor" einfügen und einmal auf "Run" klicken.
-- Kann gefahrlos erneut ausgeführt werden. Voraussetzung: schema.sql sowie update-2 bis update-4.

-- ===================== UPDATE 5 =====================
-- Termin-Tool · Update 5: Monatsabrechnung für temporäre Dolmetscher
-- Belege (Parken/Tanken) aus dem Portal, Sondertage, Arbeitstage und die Endliste für die Buchhaltung.
-- Im Supabase-Menü "SQL Editor" einfügen und mit "Run" ausführen. Kann erneut ausgeführt werden.
-- Voraussetzung: schema.sql sowie update-2 bis update-4 wurden bereits ausgeführt.

-- ---------------------------------------------------------------------------
-- 1 Belege: jede Zeile ein Park- oder Tankbeleg
-- ---------------------------------------------------------------------------
create table if not exists public.tt_receipts (
  id uuid primary key default gen_random_uuid(),
  person_name text not null,                                   -- Name wie in der Endliste
  profile_id uuid references public.tt_profiles (id) on delete set null,
  date date not null,
  place text not null default '',
  amount numeric(10, 2) not null check (amount >= 0),
  kind text not null default 'Parken' check (kind in ('Parken', 'Tanken', 'Sonstiges')),
  proof text not null default 'Parkbeleg',                     -- Nachweis: Parkbeleg, Parkschein, Kartenbeleg …
  note text not null default '',
  photo_path text not null default '',
  status text not null default 'eingereicht' check (status in ('eingereicht', 'geprüft', 'abgelehnt')),
  source text not null default 'portal' check (source in ('portal', 'manuell', 'import')),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists tt_receipts_date_idx on public.tt_receipts (date);
create index if not exists tt_receipts_profile_idx on public.tt_receipts (profile_id, date);

alter table public.tt_receipts enable row level security;
revoke all on public.tt_receipts from anon;
grant select, insert, update, delete on public.tt_receipts to authenticated;

-- Dolmetscher: eigene Belege sehen, einreichen und löschen, solange sie noch nicht geprüft sind.
drop policy if exists tt_receipts_select_own on public.tt_receipts;
create policy tt_receipts_select_own on public.tt_receipts for select to authenticated
  using (public.tt_is_member() and profile_id = (select auth.uid()));
drop policy if exists tt_receipts_insert_own on public.tt_receipts;
create policy tt_receipts_insert_own on public.tt_receipts for insert to authenticated
  with check (public.tt_is_member() and profile_id = (select auth.uid()) and status = 'eingereicht' and source = 'portal');
drop policy if exists tt_receipts_delete_own on public.tt_receipts;
create policy tt_receipts_delete_own on public.tt_receipts for delete to authenticated
  using (public.tt_is_member() and profile_id = (select auth.uid()) and status = 'eingereicht');
drop policy if exists tt_receipts_staff on public.tt_receipts;
create policy tt_receipts_staff on public.tt_receipts for all to authenticated
  using (public.tt_is_staff()) with check (public.tt_is_staff());

-- ---------------------------------------------------------------------------
-- 2 Sondertage, Angaben pro Person und Monat, Einstellungen pro Monat (nur Einsatzleitung/Sekretariat)
-- ---------------------------------------------------------------------------
create table if not exists public.tt_special_days (
  id uuid primary key default gen_random_uuid(),
  person_name text not null,
  date date not null,
  job text not null default '',                                -- Einsatz
  amount numeric(10, 2) not null default 0,                    -- Betrag für den Tag (ersetzt den Tagessatz)
  counts text not null default 'Ja' check (counts in ('Ja', 'Nein', 'prüfen')),
  mark text not null default '',                               -- Vermerk auf dem Tagesblatt
  hint text not null default '',
  source text not null default 'manuell' check (source in ('manuell', 'import')),
  created_at timestamptz not null default now()
);
create index if not exists tt_special_days_date_idx on public.tt_special_days (date);

create table if not exists public.tt_payroll (
  month text not null check (month ~ '^\d{4}-\d{2}$'),         -- z. B. 2026-09
  person_name text not null,
  full_name text not null default '',
  workdays integer check (workdays >= 0),                      -- leer = automatisch aus dem Online-Archiv zählen
  status text not null default '',
  remark text not null default '',
  primary key (month, person_name)
);

create table if not exists public.tt_payroll_months (
  month text primary key check (month ~ '^\d{4}-\d{2}$'),
  daily_rate numeric(10, 2) not null default 80,
  check_date date
);

alter table public.tt_special_days enable row level security;
alter table public.tt_payroll enable row level security;
alter table public.tt_payroll_months enable row level security;
revoke all on public.tt_special_days, public.tt_payroll, public.tt_payroll_months from anon;
grant select, insert, update, delete on public.tt_special_days, public.tt_payroll, public.tt_payroll_months to authenticated;

drop policy if exists tt_special_days_staff on public.tt_special_days;
create policy tt_special_days_staff on public.tt_special_days for all to authenticated
  using (public.tt_is_staff()) with check (public.tt_is_staff());
drop policy if exists tt_payroll_staff on public.tt_payroll;
create policy tt_payroll_staff on public.tt_payroll for all to authenticated
  using (public.tt_is_staff()) with check (public.tt_is_staff());
drop policy if exists tt_payroll_months_staff on public.tt_payroll_months;
create policy tt_payroll_months_staff on public.tt_payroll_months for all to authenticated
  using (public.tt_is_staff()) with check (public.tt_is_staff());

-- ===================== UPDATE 6 =====================
-- Termin-Tool · Update 6: Abrechnung im Dolmetscher-Portal
-- Die Einsatzleitung gibt die Monatsabrechnung pro Person frei; die Person sieht sie im Portal
-- und bestätigt sie oder meldet einen Einwand.
-- Im Supabase-Menü "SQL Editor" einfügen und mit "Run" ausführen. Kann erneut ausgeführt werden.
-- Voraussetzung: schema.sql sowie update-2 bis update-5 wurden bereits ausgeführt.

-- Zeile der Endliste mit einem Portal-Konto verknüpfen (Name auf dem Tagesblatt ↔ Konto).
alter table public.tt_payroll
  add column if not exists profile_id uuid references public.tt_profiles (id) on delete set null;

-- Freigegebene Abrechnung: ein fester Stand pro Person und Monat.
create table if not exists public.tt_statements (
  month text not null check (month ~ '^\d{4}-\d{2}$'),
  profile_id uuid not null references public.tt_profiles (id) on delete cascade,
  person_name text not null default '',
  data jsonb not null,                                         -- Arbeitstage, Sondertage, Belege, Summen
  released_at timestamptz not null default now(),
  released_by text not null default '',
  response text not null default 'offen' check (response in ('offen', 'bestätigt', 'einwand')),
  response_note text not null default '',
  responded_at timestamptz,
  primary key (month, profile_id)
);

alter table public.tt_statements enable row level security;
revoke all on public.tt_statements from anon;
grant select, insert, update, delete on public.tt_statements to authenticated;

drop policy if exists tt_statements_select_own on public.tt_statements;
create policy tt_statements_select_own on public.tt_statements for select to authenticated
  using (public.tt_is_member() and profile_id = (select auth.uid()));
drop policy if exists tt_statements_staff on public.tt_statements;
create policy tt_statements_staff on public.tt_statements for all to authenticated
  using (public.tt_is_staff()) with check (public.tt_is_staff());

-- Antwort der Person: bestätigen oder Einwand mit Begründung.
create or replace function public.tt_respond_statement(p_month text, p_response text, p_note text default '')
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_response not in ('bestätigt', 'einwand') then
    raise exception 'Unbekannte Antwort.';
  end if;
  if p_response = 'einwand' and coalesce(trim(p_note), '') = '' then
    raise exception 'Bitte schreib kurz, was nicht stimmt.';
  end if;
  update public.tt_statements
     set response = p_response, response_note = left(coalesce(p_note, ''), 500), responded_at = now()
   where month = p_month and profile_id = auth.uid();
  if not found then
    raise exception 'Für diesen Monat ist noch keine Abrechnung freigegeben.';
  end if;
end;
$$;

revoke execute on function public.tt_respond_statement(text, text, text) from public, anon;
grant execute on function public.tt_respond_statement(text, text, text) to authenticated;

-- ===================== UPDATE 7 =====================
-- Botschaft Dolmetscher und Transport-App · Update 7: Schäden nur mit übernommenem Fahrzeug
-- Dolmetscher können Schäden und Meldungen nur noch für das Fahrzeug eintragen,
-- das sie gerade übernommen haben. Einsatzleitung und Sekretariat dürfen weiterhin alles.
-- Im Supabase-Menü "SQL Editor" einfügen und mit "Run" ausführen. Kann erneut ausgeführt werden.
-- Voraussetzung: schema.sql sowie update-2 bis update-6 wurden bereits ausgeführt.

-- Hat die angemeldete Person dieses Fahrzeug gerade übernommen (noch nicht zurückgegeben)?
create or replace function public.tt_holds_vehicle(p_vehicle uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.tt_handovers
    where vehicle_id = p_vehicle and driver_id = (select auth.uid()) and end_time is null
  );
$$;
grant execute on function public.tt_holds_vehicle(uuid) to authenticated;

drop policy if exists tt_damages_insert on public.tt_damages;
create policy tt_damages_insert on public.tt_damages for insert to authenticated
  with check (
    public.tt_is_member() and reporter_id = (select auth.uid())
    and (public.tt_is_staff() or public.tt_holds_vehicle(vehicle_id))
  );

drop policy if exists tt_alerts_insert on public.tt_alerts;
create policy tt_alerts_insert on public.tt_alerts for insert to authenticated
  with check (
    public.tt_is_member() and reporter_id = (select auth.uid())
    and (public.tt_is_staff() or public.tt_holds_vehicle(vehicle_id))
  );
