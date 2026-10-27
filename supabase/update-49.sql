-- Update 49: Pforte – Person einer Meldung korrigieren; Eilmeldung der Dolmetscher (Hilfe / Korrektur anfragen).
--   • tt_gate_person(p_id, p_profile, p_reason, p_by): Die Pforte (oder das Büro) trägt die richtige Person zu einer Meldung ein –
--     mit Grund, im Protokoll (Aktion „person“) und im Tagesbericht. Die Termine der Meldung werden aus den Aufträgen der neuen
--     Person für diesen Tag neu aufgebaut.
--   • tt_chat.urgent / kind: Eine Nachricht des Dolmetschers kann eine Eilmeldung sein (kind 'hilfe' = technisches Problem,
--     'korrektur' = Korrektur anfragen). Sie geht als EILMELDUNG an Einsatzleitung und Sekretariat (Mitteilung aufs Handy, rotes
--     Band in allen Büro-Seiten, bis sie gelesen ist).
-- Kann beliebig oft ausgeführt werden.

alter table public.tt_chat add column if not exists urgent boolean not null default false;
alter table public.tt_chat add column if not exists kind text not null default '';
alter table public.tt_chat drop constraint if exists tt_chat_kind_check;
alter table public.tt_chat add constraint tt_chat_kind_check check (kind in ('', 'hilfe', 'korrektur'));
create index if not exists tt_chat_urgent_idx on public.tt_chat (created_at desc) where urgent and read_at is null;

-- Termin-Eintrag für die Pforte aus einem Auftrag (wie die App ihn schickt): Zeit, Arzt, Ort, Patient, Aktennummer.
create or replace function public.tt_gate_stop_of(a public.tt_assignments) returns jsonb
language sql stable set search_path = '' as $$
  with parts as (
    select array(select p from unnest(string_to_array(coalesce(a.title, ''), ' · ')) as p where p !~ '^\d{1,2}:\d{2} Uhr$') as list
  )
  select jsonb_build_object(
    'time', left(coalesce(a.time, ''), 5),
    'doctor', coalesce(list[1], ''),
    'city', coalesce(array_to_string(list[2:], ' · '), ''),
    'patient_name', btrim(coalesce(substring(coalesce(a.message, '') from '\*(?:Haupt)?[Pp]atient/in:\s*([^*\r\n]+)\*'), '')),
    'patient_nr', btrim(coalesce(substring(coalesce(a.message, '') from '\*Aktennummer:\s*([^*\r\n]+)\*'), '')),
    'assignment_id', a.id::text,
    'done', coalesce(a.finished_at::text, ''))
  from parts;
$$;

create or replace function public.tt_gate_person(p_id uuid, p_profile uuid, p_reason text default '', p_by text default null) returns public.tt_gate
language plpgsql security definer set search_path = '' as $$
declare
  v_old public.tt_gate;
  v_row public.tt_gate;
  v_person public.tt_profiles;
  v_name text;
  v_stops jsonb;
begin
  if not (public.tt_is_gate() or public.tt_is_staff()) then
    raise exception 'Das darf nur die Pforte oder die Einsatzleitung.';
  end if;
  select * into v_old from public.tt_gate where id = p_id;
  if v_old.id is null then
    raise exception 'Diese Meldung gibt es nicht (mehr).';
  end if;
  if btrim(coalesce(p_reason, '')) = '' then
    raise exception 'Bitte einen Grund für die Korrektur angeben.';
  end if;
  select * into v_person from public.tt_profiles where id = p_profile and active
     and ((role = 'dolmetscher' and employment = 'fest') or role in ('admin', 'sekretariat'));
  if v_person.id is null then
    raise exception 'Diese Person steht nicht zur Auswahl.';
  end if;
  if v_person.id = v_old.profile_id then
    return v_old;
  end if;
  if v_old.in_at is null and v_old.away_reason = '' and exists (select 1 from public.tt_gate where profile_id = v_person.id and in_at is null and away_reason = '' and id <> p_id) then
    raise exception 'Für % ist schon eine andere Ausfahrt offen.', coalesce(v_person.full_name, 'diese Person');
  end if;
  v_name := public.tt_gate_who(p_by);
  -- Termine der neuen Person an diesem Tag (wie die App sie melden würde)
  select coalesce(jsonb_agg(public.tt_gate_stop_of(a) order by a.time), '[]'::jsonb) into v_stops
    from public.tt_assignments a
   where a.interpreter_id = v_person.id and a.date = v_old.date and not a.cancelled and a.storno_at is null;
  update public.tt_gate
     set profile_id = v_person.id, driver_name = coalesce(nullif(v_person.full_name, ''), 'Unbekannt'),
         stops = v_stops, stops_changed_at = case when v_stops <> v_old.stops then now() else stops_changed_at end,
         fixed_at = now(), fixed_by = v_name
   where id = p_id
   returning * into v_row;
  perform public.tt_gate_log_write(v_row, p_by, 'person', concat('Person korrigiert: ', coalesce(v_old.driver_name, '–'), ' → ', v_row.driver_name, ' · Grund: ', left(btrim(p_reason), 200)),
                                   jsonb_build_object('driver_name', v_old.driver_name, 'profile_id', v_old.profile_id, 'stops', v_old.stops),
                                   jsonb_build_object('driver_name', v_row.driver_name, 'profile_id', v_row.profile_id, 'stops', v_row.stops));
  return v_row;
end;
$$;
revoke execute on function public.tt_gate_person(uuid, uuid, text, text) from public, anon;
grant execute on function public.tt_gate_person(uuid, uuid, text, text) to authenticated;
