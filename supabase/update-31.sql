-- Update 31: Pforte – nur für fest Angestellte, und die Pforte bestätigt die Ausfahrt.
--   • Melden können sich nur fest angestellte Dolmetscher (und das Büro). Temporäre brauchen das nicht.
--   • Eine Meldung ist zuerst nur „angemeldet“. Erst wenn die Pforte „Ausfahrt bestätigen“ klickt, gilt die Person als draußen
--     (out_confirmed_at, out_by) – so ist sicher, dass wirklich jemand hinausgefahren ist.
--   • Ist die Person doch nicht gefahren, nimmt die Pforte die Meldung heraus („Nicht gefahren“) – nur solange sie nicht bestätigt ist.
--   • Der Fahrer kann seine Meldung zurücknehmen, solange die Pforte sie noch nicht bestätigt hat.
-- Braucht Update 30. Kann beliebig oft ausgeführt werden.

alter table public.tt_gate add column if not exists out_confirmed_at timestamptz;
alter table public.tt_gate add column if not exists out_by text not null default '';

-- Wer meldet, steht fest; bestätigt ist eine neue Meldung nie.
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
    new.out_confirmed_at := null;
    new.out_by := '';
  end if;
  return new;
end;
$$;

-- Der Fahrer darf Ziele und Fahrzeug ergänzen – nicht, wer wann hinaus- oder hereinfuhr und nicht die Bestätigung der Pforte.
create or replace function public.tt_gate_keep() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is not null and not public.tt_is_staff() and not public.tt_is_gate() then
    new.profile_id := old.profile_id;
    new.driver_name := old.driver_name;
    new.date := old.date;
    new.out_at := old.out_at;
    new.in_at := old.in_at;
    new.in_by := old.in_by;
    new.out_confirmed_at := old.out_confirmed_at;
    new.out_by := old.out_by;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

-- Melden: nur fest angestellte Dolmetscher und das Büro.
drop policy if exists tt_gate_insert on public.tt_gate;
create policy tt_gate_insert on public.tt_gate for insert to authenticated
  with check (public.tt_is_staff() or exists (
    select 1 from public.tt_profiles
     where id = (select auth.uid()) and active and role = 'dolmetscher' and employment = 'fest'));
-- Zurücknehmen: der Fahrer nur, solange die Pforte die Ausfahrt noch nicht bestätigt hat. Das Büro immer.
drop policy if exists tt_gate_delete on public.tt_gate;
create policy tt_gate_delete on public.tt_gate for delete to authenticated
  using (public.tt_is_staff() or (profile_id = (select auth.uid()) and in_at is null and out_confirmed_at is null));

-- „Ausfahrt bestätigen“ (p_ok = true) oder die Bestätigung zurücknehmen (false): Pforte und Büro.
create or replace function public.tt_gate_out(p_id uuid, p_ok boolean default true) returns public.tt_gate
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
     set out_confirmed_at = case when p_ok then coalesce(out_confirmed_at, now()) else null end,
         out_by = case when p_ok then coalesce(nullif(out_by, ''), coalesce(v_name, '')) else '' end
   where id = p_id and (p_ok or in_at is null)
   returning * into v_row;
  if v_row.id is null then
    raise exception 'Diese Meldung gibt es nicht (mehr) oder die Person ist schon zurück.';
  end if;
  return v_row;
end;
$$;
revoke execute on function public.tt_gate_out(uuid, boolean) from public, anon;
grant execute on function public.tt_gate_out(uuid, boolean) to authenticated;

-- „Nicht gefahren“: Die Pforte nimmt eine Meldung heraus, die sie noch nicht bestätigt hat (das Büro löscht ohnehin direkt).
create or replace function public.tt_gate_drop(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not (public.tt_is_gate() or public.tt_is_staff()) then
    raise exception 'Das darf nur die Pforte oder die Einsatzleitung.';
  end if;
  delete from public.tt_gate where id = p_id and out_confirmed_at is null and in_at is null;
  if not found then
    raise exception 'Diese Meldung ist schon bestätigt oder es gibt sie nicht mehr.';
  end if;
end;
$$;
revoke execute on function public.tt_gate_drop(uuid) from public, anon;
grant execute on function public.tt_gate_drop(uuid) to authenticated;

-- „Ist zurück“ gilt auch für eine Meldung, die die Pforte nicht eigens bestätigt hatte: Dann zählt die Rückkehr als Bestätigung.
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
         in_by = case when p_back then coalesce(nullif(in_by, ''), coalesce(v_name, '')) else '' end,
         out_confirmed_at = case when p_back then coalesce(out_confirmed_at, out_at) else out_confirmed_at end
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
revoke execute on function public.tt_is_gate() from public, anon;
grant execute on function public.tt_is_gate() to authenticated;
