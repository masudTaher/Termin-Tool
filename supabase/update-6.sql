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
