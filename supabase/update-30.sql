-- Update 30: Pforte.
-- Bevor ein Fahrer oder Dolmetscher hinausfährt, meldet er sich in der App an der Pforte ab: wer, mit welchem Fahrzeug, wohin
-- (Arzt, Stadt, Uhrzeit des Termins, Patient). Die Pforte sieht das auf ihrer Anzeige und klickt „Ist zurück“, wenn der Wagen
-- wieder hereinfährt. Am Ende des Tages druckt sie den Bericht mit allen Bewegungen.
--   • neue Rolle 'pforte': sieht nur die Anzeige der Pforte (keine Akten, keine Abrechnung, kein Fuhrpark, keine Kollegenliste)
--   • Tabelle tt_gate: eine Zeile je Ausfahrt – mit allen Aufträgen des Tages (stops), denn wer zwei Aufträge hat, fährt oft
--     von draußen direkt zum zweiten Termin. Kommt ein Auftrag dazu, während er draußen ist, ergänzt die App die Meldung.
--   • Die Rückkehr trägt die Pforte ein (oder das Büro); der Fahrer kann seine Meldung zurücknehmen, solange er nicht zurück ist.
-- Kann beliebig oft ausgeführt werden.

alter table public.tt_profiles drop constraint if exists tt_profiles_role_check;
alter table public.tt_profiles add constraint tt_profiles_role_check
  check (role in ('admin', 'sekretariat', 'dolmetscher', 'pforte'));

create or replace function public.tt_is_gate() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.tt_profiles where id = (select auth.uid()) and active and role = 'pforte');
$$;
grant execute on function public.tt_is_gate() to authenticated;

-- Die Pforte ist kein „Mitglied“ im Sinn der übrigen Regeln: Sie sieht weder Fuhrpark noch Kollegenliste, Chat oder Aufträge –
-- nur ihr eigenes Konto und die Meldungen an die Pforte. Für alle anderen Rollen ändert sich nichts.
create or replace function public.tt_is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.tt_profiles where id = (select auth.uid()) and active and role <> 'pforte');
$$;

create table if not exists public.tt_gate (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  date date not null default ((now() at time zone 'Europe/Berlin')::date),
  profile_id uuid not null references public.tt_profiles(id) on delete cascade,
  driver_name text not null default '',
  assignment_id uuid,                       -- der Auftrag, zu dem die Fahrt gehört (falls es einen gibt)
  plate text not null default '',           -- Kennzeichen
  vehicle text not null default '',         -- Marke und Modell
  appointment_time text not null default '',
  doctor text not null default '',
  city text not null default '',
  patient_name text not null default '',
  patient_nr text not null default '',
  note text not null default '',
  stops jsonb not null default '[]'::jsonb,  -- alle Aufträge dieser Ausfahrt: [{ time, doctor, city, patient_name, patient_nr }]
  out_at timestamptz not null default now(),
  in_at timestamptz,
  in_by text not null default ''
);
alter table public.tt_gate add column if not exists stops jsonb not null default '[]'::jsonb;
create index if not exists tt_gate_date_idx on public.tt_gate (date, out_at);
alter table public.tt_gate enable row level security;
grant select, insert, update, delete on public.tt_gate to authenticated;

-- Wer meldet, steht fest: Name und Zeitpunkt kommen aus der Datenbank, nicht aus der App.
create or replace function public.tt_gate_stamp() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is not null then
    new.profile_id := (select auth.uid());
    new.driver_name := coalesce((select full_name from public.tt_profiles where id = (select auth.uid())), '');
    new.out_at := now();
    new.date := (now() at time zone 'Europe/Berlin')::date;
    new.in_at := null;
    new.in_by := '';
  end if;
  return new;
end;
$$;
drop trigger if exists tt_gate_stamp on public.tt_gate;
create trigger tt_gate_stamp before insert on public.tt_gate for each row execute function public.tt_gate_stamp();

-- Der Fahrer darf seine Meldung ergänzen (Ziele, Fahrzeug), solange er draußen ist – aber nicht, wer wann hinaus- oder hereinfuhr.
create or replace function public.tt_gate_keep() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- (Die Pforte ändert nur über tt_gate_return – direkt hat sie kein Recht dazu.)
  if (select auth.uid()) is not null and not public.tt_is_staff() and not public.tt_is_gate() then
    new.profile_id := old.profile_id;
    new.driver_name := old.driver_name;
    new.date := old.date;
    new.out_at := old.out_at;
    new.in_at := old.in_at;
    new.in_by := old.in_by;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;
drop trigger if exists tt_gate_keep on public.tt_gate;
create trigger tt_gate_keep before update on public.tt_gate for each row execute function public.tt_gate_keep();

drop policy if exists tt_gate_select on public.tt_gate;
create policy tt_gate_select on public.tt_gate for select to authenticated
  using (profile_id = (select auth.uid()) or public.tt_is_staff() or public.tt_is_gate());
drop policy if exists tt_gate_insert on public.tt_gate;
create policy tt_gate_insert on public.tt_gate for insert to authenticated
  with check (public.tt_is_member() and not public.tt_is_gate());
-- Ändern: das Büro (Korrektur) und der Fahrer selbst, solange er draußen ist (nur Ziele und Fahrzeug, siehe tt_gate_keep).
-- Die Pforte trägt die Rückkehr über tt_gate_return ein.
drop policy if exists tt_gate_update on public.tt_gate;
create policy tt_gate_update on public.tt_gate for update to authenticated
  using (public.tt_is_staff() or (profile_id = (select auth.uid()) and in_at is null))
  with check (public.tt_is_staff() or profile_id = (select auth.uid()));
-- Löschen: das Büro immer; der Fahrer seine eigene Meldung, solange er nicht als zurück eingetragen ist.
drop policy if exists tt_gate_delete on public.tt_gate;
create policy tt_gate_delete on public.tt_gate for delete to authenticated
  using (public.tt_is_staff() or (profile_id = (select auth.uid()) and in_at is null));

-- „Ist zurück“ (p_back = true) oder die Rückkehr wieder zurücknehmen (false): Pforte und Büro.
create or replace function public.tt_gate_return(p_id uuid, p_back boolean default true) returns public.tt_gate
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.tt_gate;
  v_name text;
begin
  if not (public.tt_is_gate() or public.tt_is_staff()) then
    raise exception 'Das darf nur die Pforte oder die Einsatzleitung.';
  end if;
  select full_name into v_name from public.tt_profiles where id = (select auth.uid());
  update public.tt_gate
     set in_at = case when p_back then coalesce(in_at, now()) else null end,
         in_by = case when p_back then coalesce(nullif(in_by, ''), coalesce(v_name, '')) else '' end
   where id = p_id
   returning * into v_row;
  if v_row.id is null then
    raise exception 'Diese Meldung gibt es nicht (mehr).';
  end if;
  return v_row;
end;
$$;
revoke execute on function public.tt_gate_return(uuid, boolean) from public, anon;
grant execute on function public.tt_gate_return(uuid, boolean) to authenticated;
