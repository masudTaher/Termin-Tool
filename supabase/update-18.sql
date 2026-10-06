-- Update 18: Neue Termine, die Dolmetscher aus der Praxis oder Klinik mitbringen (mit Terminzettel als Nachweis).
-- Das Büro sieht sie in einer Tabelle, trägt sie in FileMaker ein und hakt sie ab. Kann beliebig oft ausgeführt werden.
create table if not exists public.tt_new_appointments (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  reporter_id uuid references public.tt_profiles (id) on delete set null,
  reporter_name text not null default '',
  patient_nr text not null default '',
  patient_name text not null default '',
  date date not null,                                   -- Datum des neuen Termins
  time time,                                            -- Uhrzeit (leer = noch offen)
  place text not null default '',                       -- Krankenhaus oder Praxis
  city text not null default '',
  doctor text not null default '',                      -- Arzt oder Abteilung
  description text not null default '',                 -- wofür der Termin ist
  payer text not null default 'unbekannt' check (payer in ('selbstzahler', 'kostenuebernahme', 'unbekannt')),
  file_path text,                                       -- Terminzettel als PDF im Speicher "dokumente"
  no_slip boolean not null default false,               -- es gibt keinen Zettel (z. B. telefonisch vereinbart)
  status text not null default 'neu' check (status in ('neu', 'eingetragen')),
  handled_at timestamptz,
  handled_by text not null default '',
  office_note text not null default ''
);
create index if not exists tt_new_appointments_status_idx on public.tt_new_appointments (status, created_at desc);
create index if not exists tt_new_appointments_reporter_idx on public.tt_new_appointments (reporter_id, created_at desc);

alter table public.tt_new_appointments enable row level security;
revoke all on public.tt_new_appointments from anon;
grant select, insert, update, delete on public.tt_new_appointments to authenticated;

-- Dolmetscher sehen und melden nur eigene Termine; ändern oder löschen geht, solange das Büro sie nicht eingetragen hat.
drop policy if exists tt_new_appointments_select on public.tt_new_appointments;
create policy tt_new_appointments_select on public.tt_new_appointments for select to authenticated
  using (public.tt_is_staff() or (public.tt_is_member() and reporter_id = (select auth.uid())));
drop policy if exists tt_new_appointments_insert on public.tt_new_appointments;
create policy tt_new_appointments_insert on public.tt_new_appointments for insert to authenticated
  with check (public.tt_is_member() and reporter_id = (select auth.uid()) and status = 'neu');
drop policy if exists tt_new_appointments_update_own on public.tt_new_appointments;
create policy tt_new_appointments_update_own on public.tt_new_appointments for update to authenticated
  using (public.tt_is_member() and reporter_id = (select auth.uid()) and status = 'neu')
  with check (reporter_id = (select auth.uid()) and status = 'neu');
drop policy if exists tt_new_appointments_delete_own on public.tt_new_appointments;
create policy tt_new_appointments_delete_own on public.tt_new_appointments for delete to authenticated
  using (public.tt_is_member() and reporter_id = (select auth.uid()) and status = 'neu');
drop policy if exists tt_new_appointments_staff on public.tt_new_appointments;
create policy tt_new_appointments_staff on public.tt_new_appointments for all to authenticated
  using (public.tt_is_staff()) with check (public.tt_is_staff());

-- Vorschläge beim Eintippen: Krankenhäuser, Praxen, Orte und Ärzte – gelernt aus den gemeldeten Terminen aller
-- Dolmetscher und aus den Terminlisten der letzten 180 Tage. Bewusst ohne Patientendaten: Patienten werden nur aus
-- den eigenen Aufträgen und eigenen Meldungen vorgeschlagen (das macht das Portal selbst).
create or replace function public.tt_appointment_suggestions()
returns table (place text, city text, doctor text, uses bigint)
language sql stable security definer set search_path = '' as $$
  with reported as (
    select btrim(a.place) as place, btrim(a.city) as city, btrim(a.doctor) as doctor, count(*)::bigint * 3 as uses
    from public.tt_new_appointments a
    where btrim(a.place) <> ''
    group by 1, 2, 3
  ),
  listed as (
    select btrim(r ->> 'Arzt Nr::Name') as place,
           btrim(coalesce(nullif(r ->> 'Arzt Nr::Ort', ''), nullif(r ->> 'Arzt Nr::Stadt', ''), nullif(r ->> 'Ort', ''), '')) as city,
           ''::text as doctor, count(*)::bigint as uses
    from public.tt_days d
    cross join lateral jsonb_array_elements(case when jsonb_typeof(d.records) = 'array' then d.records else '[]'::jsonb end) r
    where d.date >= current_date - 180 and btrim(coalesce(r ->> 'Arzt Nr::Name', '')) <> ''
    group by 1, 2
  )
  select s.place, s.city, s.doctor, sum(s.uses)::bigint as uses
  from (select * from reported union all select * from listed) s
  where public.tt_is_member()
  group by s.place, s.city, s.doctor
  order by 4 desc, 1
  limit 400;
$$;
revoke all on function public.tt_appointment_suggestions() from public, anon;
grant execute on function public.tt_appointment_suggestions() to authenticated;

-- Rückmeldung der Einsatzleitung an die Person, die einen Schaden oder eine Meldung im Portal gemeldet hat:
-- Die Nachricht selbst steht in tt_messages; hier wird nur vermerkt, dass und was zuletzt geantwortet wurde.
alter table public.tt_damages add column if not exists feedback_at timestamptz;
alter table public.tt_damages add column if not exists feedback_text text not null default '';
alter table public.tt_damages add column if not exists feedback_by text not null default '';
alter table public.tt_alerts add column if not exists feedback_at timestamptz;
alter table public.tt_alerts add column if not exists feedback_text text not null default '';
alter table public.tt_alerts add column if not exists feedback_by text not null default '';
