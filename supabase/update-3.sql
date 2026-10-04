-- Termin-Tool · Update 3: Aufträge, gemeinsamer Tagesstand und Online-Archiv
-- Achtung: Ab hier liegen Termindaten (auch Patientennamen) in der Datenbank.
-- Im Supabase-Menü "SQL Editor" einfügen und mit "Run" ausführen. Kann erneut ausgeführt werden.
-- Voraussetzung: schema.sql und update-2.sql wurden bereits ausgeführt.

-- ---------------------------------------------------------------------------
-- 0 Rolle "Sekretariat": sieht und bearbeitet alles wie die Einsatzleitung,
--   darf aber keine Konten freischalten, sperren, löschen oder Rollen vergeben.
-- ---------------------------------------------------------------------------
alter table public.tt_profiles drop constraint if exists tt_profiles_role_check;
alter table public.tt_profiles add constraint tt_profiles_role_check
  check (role in ('admin', 'sekretariat', 'dolmetscher'));

create or replace function public.tt_is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.tt_profiles where id = (select auth.uid()) and active and role in ('admin', 'sekretariat'));
$$;
grant execute on function public.tt_is_staff() to authenticated;

drop policy if exists tt_vehicles_admin on public.tt_vehicles;
create policy tt_vehicles_admin on public.tt_vehicles for all to authenticated
  using (public.tt_is_staff()) with check (public.tt_is_staff());
drop policy if exists tt_handovers_admin on public.tt_handovers;
create policy tt_handovers_admin on public.tt_handovers for all to authenticated
  using (public.tt_is_staff()) with check (public.tt_is_staff());
drop policy if exists tt_damages_admin on public.tt_damages;
create policy tt_damages_admin on public.tt_damages for all to authenticated
  using (public.tt_is_staff()) with check (public.tt_is_staff());
drop policy if exists tt_alerts_admin on public.tt_alerts;
create policy tt_alerts_admin on public.tt_alerts for all to authenticated
  using (public.tt_is_staff()) with check (public.tt_is_staff());
drop policy if exists tt_workdays_admin on public.tt_workdays;
create policy tt_workdays_admin on public.tt_workdays for all to authenticated
  using (public.tt_is_staff()) with check (public.tt_is_staff());
drop policy if exists schaeden_delete_admin on storage.objects;
create policy schaeden_delete_admin on storage.objects for delete to authenticated
  using (bucket_id = 'schaeden' and public.tt_is_staff());
-- Konten bleiben Sache der Einsatzleitung: die Regeln tt_profiles_* und tt_protect_profile_fields
-- verwenden weiterhin tt_is_admin().

-- ---------------------------------------------------------------------------
-- 1 Tagesstand: ein Eintrag pro Tag, nur für Admins (Einsatzleitung, Sekretariat)
-- ---------------------------------------------------------------------------
create table if not exists public.tt_days (
  date date primary key,
  records jsonb not null default '[]'::jsonb,   -- alle Termine des Tages
  deleted jsonb not null default '{}'::jsonb,   -- gelöschte Termine (für den Abgleich)
  archived boolean not null default false,
  archived_at timestamptz,
  archived_by text not null default '',
  updated_at timestamptz not null default now(),
  updated_by text not null default ''
);

alter table public.tt_days enable row level security;
revoke all on public.tt_days from anon;
grant select, insert, update, delete on public.tt_days to authenticated;
drop policy if exists tt_days_admin on public.tt_days;
create policy tt_days_admin on public.tt_days for all to authenticated
  using (public.tt_is_staff()) with check (public.tt_is_staff());

-- ---------------------------------------------------------------------------
-- 2 Aufträge an Dolmetscher mit Rückmeldung
-- ---------------------------------------------------------------------------
create table if not exists public.tt_assignments (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null unique,          -- Termin im Tagesstand
  date date not null,
  time text not null default '',
  interpreter_id uuid not null references public.tt_profiles (id) on delete cascade,
  interpreter_name text not null default '',
  title text not null default '',
  message text not null default '',
  response text not null default 'offen' check (response in ('offen', 'zugesagt', 'vorbehalt', 'abgesagt')),
  response_note text not null default '',
  responded_at timestamptz,
  work_status text not null default '',         -- Endstatus aus dem Live-Tracking (beendet, storniert …)
  cancelled boolean not null default false,
  sent_at timestamptz not null default now(),
  sent_by text not null default ''
);
create index if not exists tt_assignments_interpreter_idx on public.tt_assignments (interpreter_id, date);
create index if not exists tt_assignments_date_idx on public.tt_assignments (date);

alter table public.tt_assignments enable row level security;
revoke all on public.tt_assignments from anon;
grant select, insert, update, delete on public.tt_assignments to authenticated;

-- Dolmetscher sehen nur ihre eigenen Aufträge; antworten können sie nur über die Funktion unten.
drop policy if exists tt_assignments_select_own on public.tt_assignments;
create policy tt_assignments_select_own on public.tt_assignments for select to authenticated
  using (public.tt_is_member() and interpreter_id = (select auth.uid()));
drop policy if exists tt_assignments_admin on public.tt_assignments;
create policy tt_assignments_admin on public.tt_assignments for all to authenticated
  using (public.tt_is_staff()) with check (public.tt_is_staff());

create or replace function public.tt_respond_assignment(p_id uuid, p_response text, p_note text default '')
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_response not in ('zugesagt', 'vorbehalt', 'abgesagt') then
    raise exception 'Unbekannte Antwort.';
  end if;
  update public.tt_assignments
     set response = p_response, response_note = left(coalesce(p_note, ''), 300), responded_at = now()
   where id = p_id and interpreter_id = auth.uid() and not cancelled;
  if not found then
    raise exception 'Dieser Auftrag ist nicht (mehr) für dich bestimmt.';
  end if;
end;
$$;

revoke execute on function public.tt_respond_assignment(uuid, text, text) from public, anon;
grant execute on function public.tt_respond_assignment(uuid, text, text) to authenticated;
