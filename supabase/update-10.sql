-- Medical Office Bonn · Transport und Dolmetscher · Update 10
-- 1) Tankkarten: Nur der Admin gibt sie aus und nimmt sie zurück; die Person sieht ihre Karte im Portal.
-- 2) Unterlagen je Patient: Arztberichte, Rezepte, Überweisungen (als PDF) und der Bericht der Dolmetscher.
-- 3) Speicher "dokumente" (privat): Dolmetscher laden nur in ihren eigenen Ordner, lesen dürfen
--    die Einsatzleitung, das Sekretariat und die Person, die hochgeladen hat (solange ihr Konto freigeschaltet ist).
-- 4) Speicheranzeige zählt die Unterlagen mit.
-- Im Supabase-Menü "SQL Editor" einfügen und mit "Run" ausführen. Kann erneut ausgeführt werden.
-- Voraussetzung: schema.sql sowie update-2 bis update-9 wurden bereits ausgeführt.

-- ---------------------------------------------------------------------------
-- 1 Tankkarten
-- ---------------------------------------------------------------------------
create table if not exists public.tt_fuel_cards (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  number text not null,                         -- Kartennummer oder Bezeichnung
  note text not null default '',
  active boolean not null default true,
  holder_id uuid references public.tt_profiles (id) on delete set null,
  holder_name text not null default '',
  assigned_at timestamptz,
  assigned_by text not null default ''
);
create unique index if not exists tt_fuel_cards_number_idx on public.tt_fuel_cards (lower(number)) where active;
create index if not exists tt_fuel_cards_holder_idx on public.tt_fuel_cards (holder_id);

-- Verlauf: wer hatte wann welche Karte
create table if not exists public.tt_fuel_card_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  card_id uuid not null references public.tt_fuel_cards (id) on delete cascade,
  card_number text not null default '',
  profile_id uuid references public.tt_profiles (id) on delete set null,
  profile_name text not null default '',
  action text not null check (action in ('ausgegeben', 'zurück')),
  by_name text not null default ''
);
create index if not exists tt_fuel_card_log_card_idx on public.tt_fuel_card_log (card_id, created_at desc);

alter table public.tt_fuel_cards enable row level security;
alter table public.tt_fuel_card_log enable row level security;
revoke all on public.tt_fuel_cards, public.tt_fuel_card_log from anon;
grant select, insert, update, delete on public.tt_fuel_cards, public.tt_fuel_card_log to authenticated;

drop policy if exists tt_fuel_cards_select on public.tt_fuel_cards;
create policy tt_fuel_cards_select on public.tt_fuel_cards for select to authenticated
  using (public.tt_is_staff() or holder_id = (select auth.uid()));
drop policy if exists tt_fuel_cards_admin on public.tt_fuel_cards;
create policy tt_fuel_cards_admin on public.tt_fuel_cards for all to authenticated
  using (public.tt_is_admin()) with check (public.tt_is_admin());

drop policy if exists tt_fuel_card_log_select on public.tt_fuel_card_log;
create policy tt_fuel_card_log_select on public.tt_fuel_card_log for select to authenticated
  using (public.tt_is_staff());
drop policy if exists tt_fuel_card_log_admin on public.tt_fuel_card_log;
create policy tt_fuel_card_log_admin on public.tt_fuel_card_log for all to authenticated
  using (public.tt_is_admin()) with check (public.tt_is_admin());

-- Karte ausgeben (p_profile = Person) oder zurücknehmen (p_profile = null). Nur der Admin.
create or replace function public.tt_fuel_card_set(p_card uuid, p_profile uuid default null)
returns public.tt_fuel_cards
language plpgsql security definer set search_path = '' as $$
declare
  v_card public.tt_fuel_cards;
  v_person public.tt_profiles;
  v_admin text;
begin
  if not public.tt_is_admin() then
    raise exception 'Tankkarten darf nur der Admin ausgeben und zurücknehmen.';
  end if;
  select * into v_card from public.tt_fuel_cards where id = p_card and active;
  if not found then
    raise exception 'Diese Tankkarte gibt es nicht (mehr).';
  end if;
  select coalesce(nullif(full_name, ''), 'Admin') into v_admin from public.tt_profiles where id = auth.uid();

  -- Zuerst die bisherige Ausgabe beenden
  if v_card.holder_id is not null and v_card.holder_id is distinct from p_profile then
    insert into public.tt_fuel_card_log (card_id, card_number, profile_id, profile_name, action, by_name)
    values (v_card.id, v_card.number, v_card.holder_id, v_card.holder_name, 'zurück', v_admin);
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
  -- Eigener Zeitstempel (aktuelle Uhrzeit statt Beginn des Aufrufs): Beim Weitergeben steht "ausgegeben"
  -- im Verlauf dadurch sicher nach dem "zurück" der bisherigen Person.
  insert into public.tt_fuel_card_log (created_at, card_id, card_number, profile_id, profile_name, action, by_name)
  values (clock_timestamp(), v_card.id, v_card.number, v_person.id, v_card.holder_name, 'ausgegeben', v_admin);
  return v_card;
end;
$$;
revoke execute on function public.tt_fuel_card_set(uuid, uuid) from public, anon;
grant execute on function public.tt_fuel_card_set(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2 Unterlagen je Patient
-- ---------------------------------------------------------------------------
create table if not exists public.tt_documents (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  patient_nr text not null default '',          -- Patienten- bzw. Aktennummer
  patient_name text not null default '',
  date date,                                    -- Datum des Termins
  doctor text not null default '',
  appointment_id uuid,                          -- Termin im Tagesstand (tt_days.records[]._id)
  assignment_id uuid references public.tt_assignments (id) on delete set null,
  kind text not null default 'Sonstiges',       -- Arztbericht, Rezept Medikamente, … oder Dolmetscherbericht
  note text not null default '',
  body text not null default '',                -- Text des Dolmetscherberichts
  pages integer not null default 0,
  file_path text,                               -- PDF im Speicher "dokumente"
  file_bytes integer,
  text_content text not null default '',        -- erkannter Text, für die Suche
  warnings text[] not null default '{}',        -- Hinweise der Prüfung (z. B. "Seite 2 von 3 fehlt")
  uploader_id uuid references public.tt_profiles (id) on delete set null,
  uploader_name text not null default '',
  status text not null default 'neu' check (status in ('neu', 'geprüft', 'weitergeleitet')),
  checked_at timestamptz,
  checked_by text not null default '',
  forwarded_at timestamptz,
  forwarded_to text not null default '',
  forwarded_by text not null default ''
);
create index if not exists tt_documents_patient_idx on public.tt_documents (patient_nr, created_at desc);
create index if not exists tt_documents_created_idx on public.tt_documents (created_at desc);
create index if not exists tt_documents_assignment_idx on public.tt_documents (assignment_id);
create index if not exists tt_documents_uploader_idx on public.tt_documents (uploader_id, created_at desc);

alter table public.tt_documents enable row level security;
revoke all on public.tt_documents from anon;
grant select, insert, update, delete on public.tt_documents to authenticated;

-- Eigene Einträge sieht und bearbeitet nur, wer freigeschaltet ist: Ein gesperrtes Konto kommt
-- an seine früheren Unterlagen nicht mehr heran (wie bei Belegen und Aufträgen).
drop policy if exists tt_documents_select on public.tt_documents;
create policy tt_documents_select on public.tt_documents for select to authenticated
  using (public.tt_is_staff() or (public.tt_is_member() and uploader_id = (select auth.uid())));
drop policy if exists tt_documents_insert on public.tt_documents;
create policy tt_documents_insert on public.tt_documents for insert to authenticated
  with check (public.tt_is_member() and uploader_id = (select auth.uid()) and status = 'neu');
-- Eigene Einträge lassen sich ändern oder löschen, solange die Einsatzleitung sie noch nicht geprüft hat.
drop policy if exists tt_documents_update_own on public.tt_documents;
create policy tt_documents_update_own on public.tt_documents for update to authenticated
  using (public.tt_is_member() and uploader_id = (select auth.uid()) and status = 'neu')
  with check (uploader_id = (select auth.uid()) and status = 'neu');
drop policy if exists tt_documents_delete_own on public.tt_documents;
create policy tt_documents_delete_own on public.tt_documents for delete to authenticated
  using (public.tt_is_member() and uploader_id = (select auth.uid()) and status = 'neu');
drop policy if exists tt_documents_staff on public.tt_documents;
create policy tt_documents_staff on public.tt_documents for all to authenticated
  using (public.tt_is_staff()) with check (public.tt_is_staff());

-- ---------------------------------------------------------------------------
-- 3 Speicher für Unterlagen (privat)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('dokumente', 'dokumente', false, 20971520, array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do nothing;

drop policy if exists dokumente_insert on storage.objects;
create policy dokumente_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'dokumente' and public.tt_is_member()
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
-- Lesen und Löschen im eigenen Ordner nur mit freigeschaltetem Konto (ein gesperrtes Konto sieht nichts mehr).
drop policy if exists dokumente_select on storage.objects;
create policy dokumente_select on storage.objects for select to authenticated
  using (
    bucket_id = 'dokumente'
    and (public.tt_is_staff() or (public.tt_is_member() and (storage.foldername(name))[1] = (select auth.uid())::text))
  );
drop policy if exists dokumente_delete on storage.objects;
create policy dokumente_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'dokumente'
    and (public.tt_is_staff() or (public.tt_is_member() and (storage.foldername(name))[1] = (select auth.uid())::text))
  );

-- ---------------------------------------------------------------------------
-- 4 Speicheranzeige: Fotos und Unterlagen zusammen
-- ---------------------------------------------------------------------------
create or replace function public.tt_usage() returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when public.tt_is_staff() then jsonb_build_object(
    'database_bytes', pg_database_size(current_database()),
    'storage_bytes', coalesce((select sum(coalesce((o.metadata ->> 'size')::bigint, 0)) from storage.objects o where o.bucket_id in ('schaeden', 'dokumente')), 0),
    'photos', (select count(*) from storage.objects o where o.bucket_id = 'schaeden'),
    'documents', (select count(*) from storage.objects o where o.bucket_id = 'dokumente')
  ) else null end;
$$;
revoke execute on function public.tt_usage() from public, anon;
grant execute on function public.tt_usage() to authenticated;
