-- Update 34: Anzeige für die Ärzte im Haus (arzt.html).
--   • neue Rolle 'arzt': sieht die Unterlagen des Tages – Dolmetscherberichte, Arztberichte, Rezepte, Überweisungen –
--     und die ganze Akte eines Patienten. Sonst nichts: keine Aufträge, kein Fuhrpark, keine Abrechnung, keine Kollegenliste.
--   • „Gelesen“: Der Arzt hakt einen Bericht ab; alle sehen, wer wann gelesen hat. Jeder Blick in eine Akte wird festgehalten.
--   • Ärzte können nichts hochladen, ändern oder löschen – nur lesen und abhaken.
-- Braucht Update 30 (tt_is_member ohne Pforte). Kann beliebig oft ausgeführt werden.

alter table public.tt_profiles drop constraint if exists tt_profiles_role_check;
alter table public.tt_profiles add constraint tt_profiles_role_check
  check (role in ('admin', 'sekretariat', 'dolmetscher', 'pforte', 'arzt'));

create or replace function public.tt_is_doctor() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.tt_profiles where id = (select auth.uid()) and active and role = 'arzt');
$$;
revoke execute on function public.tt_is_doctor() from public, anon;
grant execute on function public.tt_is_doctor() to authenticated;

-- Ärzte sind – wie die Pforte – kein „Mitglied“ im Sinn der übrigen Regeln.
create or replace function public.tt_is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.tt_profiles where id = (select auth.uid()) and active and role not in ('pforte', 'arzt'));
$$;

-- Unterlagen: Ärzte lesen alle (nur lesen).
drop policy if exists tt_documents_select_doctor on public.tt_documents;
create policy tt_documents_select_doctor on public.tt_documents for select to authenticated
  using (public.tt_is_doctor());
drop policy if exists dokumente_select_doctor on storage.objects;
create policy dokumente_select_doctor on storage.objects for select to authenticated
  using (bucket_id = 'dokumente' and public.tt_is_doctor());

-- „Gelesen“ und „Akte angesehen“
create table if not exists public.tt_doctor_marks (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  action text not null check (action in ('gelesen', 'akte')),
  document_id uuid references public.tt_documents (id) on delete cascade,
  patient_nr text not null default '',
  doctor_id uuid not null references public.tt_profiles (id) on delete cascade,
  doctor_name text not null default ''
);
create index if not exists tt_doctor_marks_doc_idx on public.tt_doctor_marks (document_id);
create index if not exists tt_doctor_marks_at_idx on public.tt_doctor_marks (at desc);
alter table public.tt_doctor_marks enable row level security;
revoke all on public.tt_doctor_marks from anon, authenticated;
grant select, insert, delete on public.tt_doctor_marks to authenticated;

-- Wer markiert, steht fest (Name und Zeit aus der Datenbank).
create or replace function public.tt_doctor_mark_stamp() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.doctor_id := (select auth.uid());
  new.doctor_name := coalesce((select full_name from public.tt_profiles where id = (select auth.uid())), '');
  new.at := now();
  return new;
end;
$$;
drop trigger if exists tt_doctor_mark_stamp on public.tt_doctor_marks;
create trigger tt_doctor_mark_stamp before insert on public.tt_doctor_marks for each row execute function public.tt_doctor_mark_stamp();

drop policy if exists tt_doctor_marks_select on public.tt_doctor_marks;
create policy tt_doctor_marks_select on public.tt_doctor_marks for select to authenticated
  using (public.tt_is_staff() or (public.tt_is_doctor() and action = 'gelesen') or doctor_id = (select auth.uid()));
drop policy if exists tt_doctor_marks_insert on public.tt_doctor_marks;
create policy tt_doctor_marks_insert on public.tt_doctor_marks for insert to authenticated
  with check (public.tt_is_doctor() or public.tt_is_staff());
-- Vertippt? Der eigene „Gelesen“-Haken lässt sich am selben Tag zurücknehmen. Das Büro darf alles löschen.
drop policy if exists tt_doctor_marks_delete on public.tt_doctor_marks;
create policy tt_doctor_marks_delete on public.tt_doctor_marks for delete to authenticated
  using (public.tt_is_staff() or (doctor_id = (select auth.uid()) and action = 'gelesen' and at > now() - interval '1 day'));
