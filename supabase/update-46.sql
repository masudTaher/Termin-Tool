-- Update 46: Pforte – „Kommt heute nicht mehr ins Büro“ (Bereitschaft / Notdienst, früher Termin morgen, sonstiges).
--   • Wer nach dem letzten Termin direkt in den Bereitschaftsdienst geht oder morgen früh von zu Hause zum Termin fährt, kommt
--     nicht mehr zurück ins Büro. Das trägt die Person in der App ein (oder die Pforte) – die Pforte sieht es sofort, die
--     Ausfahrt gilt als abgeschlossen und bleibt nicht bis zum nächsten Tag „draußen“ stehen.
--   • tt_gate.away_reason / away_note / away_at / away_by; Funktion tt_gate_away (Person selbst, Pforte, Büro).
--   • Eine so abgeschlossene Ausfahrt zählt nicht mehr als „offen“: neue Meldung am nächsten Tag, „Fährt wieder raus“ und
--     Nachtrag sind wieder möglich; „Ist zurück“ hebt den Vermerk auf.
-- Braucht Update 45. Kann beliebig oft ausgeführt werden.

alter table public.tt_gate add column if not exists away_reason text not null default '';
alter table public.tt_gate drop constraint if exists tt_gate_away_reason_check;
alter table public.tt_gate add constraint tt_gate_away_reason_check check (away_reason in ('', 'bereitschaft', 'frueh', 'sonstiges'));
alter table public.tt_gate add column if not exists away_note text not null default '';
alter table public.tt_gate add column if not exists away_at timestamptz;
alter table public.tt_gate add column if not exists away_by text not null default '';

-- „Kommt heute nicht mehr zurück“ (p_reason gesetzt) oder den Vermerk aufheben (p_reason = ''). Die Person selbst für ihre eigene
-- Meldung, sonst Pforte und Büro. Geht nur, solange die Person nicht als zurück eingetragen ist.
create or replace function public.tt_gate_away(p_id uuid, p_reason text, p_note text default '', p_by text default null) returns public.tt_gate
language plpgsql security definer set search_path = '' as $$
declare
  v_old public.tt_gate;
  v_row public.tt_gate;
  v_name text;
  v_mine boolean;
begin
  select * into v_old from public.tt_gate where id = p_id;
  if v_old.id is null then
    raise exception 'Diese Meldung gibt es nicht (mehr).';
  end if;
  v_mine := v_old.profile_id = (select auth.uid());
  if not (v_mine or public.tt_is_gate() or public.tt_is_staff()) then
    raise exception 'Das darf nur die Person selbst, die Pforte oder die Einsatzleitung.';
  end if;
  if v_old.in_at is not null then
    raise exception 'Die Person ist schon als zurück eingetragen.';
  end if;
  if coalesce(p_reason, '') not in ('', 'bereitschaft', 'frueh', 'sonstiges') then
    raise exception 'Unbekannter Grund: %', p_reason;
  end if;
  if p_reason = 'sonstiges' and btrim(coalesce(p_note, '')) = '' then
    raise exception 'Bitte kurz angeben, warum du heute nicht mehr ins Büro kommst.';
  end if;
  v_name := case when v_mine and not (public.tt_is_gate() or public.tt_is_staff()) then coalesce(v_old.driver_name, 'Dolmetscher') else public.tt_gate_who(p_by) end;
  update public.tt_gate
     set away_reason = coalesce(p_reason, ''),
         away_note = case when coalesce(p_reason, '') = '' then '' else left(btrim(coalesce(p_note, '')), 200) end,
         away_at = case when coalesce(p_reason, '') = '' then null else now() end,
         away_by = case when coalesce(p_reason, '') = '' then '' else v_name end,
         final = coalesce(p_reason, '') <> ''
   where id = p_id
   returning * into v_row;
  perform public.tt_gate_log_write(v_row, case when v_mine and not (public.tt_is_gate() or public.tt_is_staff()) then v_name else p_by end,
                                   case when coalesce(p_reason, '') = '' then 'doch_zurueck' else 'nicht_zurueck' end,
                                   case when coalesce(p_reason, '') = '' then 'Vermerk „kommt nicht zurück“ aufgehoben'
                                        else concat('Kommt heute nicht mehr ins Büro: ', case p_reason when 'bereitschaft' then 'Bereitschaft / Notdienst' when 'frueh' then 'früher Termin morgen' else 'sonstiges' end,
                                                    case when btrim(coalesce(p_note, '')) <> '' then concat(' – ', left(btrim(p_note), 200)) else '' end) end);
  return v_row;
end;
$$;
revoke execute on function public.tt_gate_away(uuid, text, text, text) from public, anon;
grant execute on function public.tt_gate_away(uuid, text, text, text) to authenticated;

-- „Ist zurück“ hebt den Vermerk auf (die Person ist doch gekommen).
create or replace function public.tt_gate_return(p_id uuid, p_back boolean default true, p_by text default null) returns public.tt_gate
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.tt_gate;
  v_name text;
begin
  if not (public.tt_is_gate() or public.tt_is_staff()) then
    raise exception 'Das darf nur die Pforte oder die Einsatzleitung.';
  end if;
  v_name := public.tt_gate_who(p_by);
  update public.tt_gate
     set in_at = case when p_back then coalesce(in_at, now()) else null end,
         in_by = case when p_back then coalesce(nullif(in_by, ''), v_name) else '' end,
         final = case when p_back then final else false end,
         out_confirmed_at = case when p_back then coalesce(out_confirmed_at, out_at) else out_confirmed_at end,
         out_by = case when p_back then coalesce(nullif(out_by, ''), v_name) else out_by end,
         away_reason = case when p_back then '' else away_reason end,
         away_note = case when p_back then '' else away_note end,
         away_at = case when p_back then null else away_at end,
         away_by = case when p_back then '' else away_by end
   where id = p_id
   returning * into v_row;
  if v_row.id is null then
    raise exception 'Diese Meldung gibt es nicht (mehr).';
  end if;
  perform public.tt_gate_log_write(v_row, p_by, case when p_back then 'zurueck' else 'zurueckgenommen' end, case when p_back then 'Rückkehr eingetragen' else 'Rückkehr zurückgenommen (wieder draußen)' end);
  return v_row;
end;
$$;

-- Offen ist eine Ausfahrt nur, wenn die Person weder zurück ist noch „kommt nicht zurück“ eingetragen hat.
create or replace function public.tt_gate_again(p_id uuid, p_stops jsonb default '[]'::jsonb, p_by text default null) returns public.tt_gate
language plpgsql security definer set search_path = '' as $$
declare
  v_old public.tt_gate;
  v_row public.tt_gate;
  v_name text;
  v_first jsonb;
begin
  if not (public.tt_is_gate() or public.tt_is_staff()) then
    raise exception 'Das darf nur die Pforte oder die Einsatzleitung.';
  end if;
  select * into v_old from public.tt_gate where id = p_id;
  if v_old.id is null then
    raise exception 'Diese Meldung gibt es nicht (mehr).';
  end if;
  if v_old.in_at is null and v_old.away_reason = '' then
    raise exception 'Die Person ist noch draußen – bitte zuerst „Ist zurück“ eintragen.';
  end if;
  if exists (select 1 from public.tt_gate where profile_id = v_old.profile_id and in_at is null and away_reason = '') then
    raise exception 'Für diese Person ist schon eine neue Ausfahrt angemeldet.';
  end if;
  if jsonb_typeof(p_stops) <> 'array' then p_stops := '[]'::jsonb; end if;
  v_name := public.tt_gate_who(p_by);
  v_first := coalesce(p_stops -> 0, '{}'::jsonb);
  perform set_config('tt.gate_again', '1', true);
  insert into public.tt_gate (date, profile_id, driver_name, assignment_id, plate, vehicle, appointment_time, doctor, city, patient_name, patient_nr, note, stops,
                              out_at, in_at, in_by, out_confirmed_at, out_by)
  values ((now() at time zone 'Europe/Berlin')::date, v_old.profile_id, v_old.driver_name, null, v_old.plate, v_old.vehicle,
          coalesce(v_first ->> 'time', ''), coalesce(v_first ->> 'doctor', ''), coalesce(v_first ->> 'city', ''), coalesce(v_first ->> 'patient_name', ''), coalesce(v_first ->> 'patient_nr', ''),
          'Weiterfahrt zum nächsten Termin', p_stops, now(), null, '', now(), v_name)
  returning * into v_row;
  perform set_config('tt.gate_again', '', true);
  perform public.tt_gate_log_write(v_row, p_by, 'wieder_raus', 'Fährt wieder raus (nächste Ausfahrt eingetragen)');
  return v_row;
end;
$$;

create or replace function public.tt_gate_manual(p_profile uuid, p_plate text default '', p_vehicle text default '', p_note text default '', p_stops jsonb default '[]'::jsonb,
                                                 p_out_at timestamptz default now(), p_in_at timestamptz default null, p_by text default null) returns public.tt_gate
language plpgsql security definer set search_path = '' as $$
declare
  v_person public.tt_profiles;
  v_row public.tt_gate;
  v_name text;
  v_first jsonb;
  v_out timestamptz := coalesce(p_out_at, now());
begin
  if not (public.tt_is_gate() or public.tt_is_staff()) then
    raise exception 'Das darf nur die Pforte oder die Einsatzleitung.';
  end if;
  select * into v_person from public.tt_profiles where id = p_profile and active;
  if v_person.id is null then
    raise exception 'Diese Person gibt es nicht (mehr).';
  end if;
  if v_out > now() + interval '5 minutes' then
    raise exception 'Die Ausfahrt liegt in der Zukunft – bitte Datum und Uhrzeit prüfen.';
  end if;
  if v_out < now() - interval '60 days' then
    raise exception 'Die Ausfahrt liegt zu weit zurück.';
  end if;
  if p_in_at is not null and p_in_at < v_out then
    raise exception 'Die Rückkehr liegt vor der Ausfahrt – bitte Zeiten prüfen.';
  end if;
  if p_in_at is not null and p_in_at > now() + interval '5 minutes' then
    raise exception 'Die Rückkehr liegt in der Zukunft – bitte Datum und Uhrzeit prüfen.';
  end if;
  if p_in_at is null and exists (select 1 from public.tt_gate where profile_id = p_profile and in_at is null and away_reason = '') then
    raise exception 'Für % ist schon eine Ausfahrt offen – bitte zuerst dort „Ist zurück“ eintragen.', v_person.full_name;
  end if;
  if jsonb_typeof(p_stops) <> 'array' then p_stops := '[]'::jsonb; end if;
  v_name := public.tt_gate_who(p_by);
  v_first := coalesce(p_stops -> 0, '{}'::jsonb);
  perform set_config('tt.gate_again', '1', true);
  insert into public.tt_gate (date, profile_id, driver_name, assignment_id, plate, vehicle, appointment_time, doctor, city, patient_name, patient_nr, note, stops,
                              out_at, in_at, in_by, out_confirmed_at, out_by, by_gate, entered_by, final)
  values ((v_out at time zone 'Europe/Berlin')::date, v_person.id, coalesce(v_person.full_name, ''), null, left(coalesce(p_plate, ''), 24), left(coalesce(p_vehicle, ''), 80),
          coalesce(v_first ->> 'time', ''), coalesce(v_first ->> 'doctor', ''), coalesce(v_first ->> 'city', ''), '', '',
          left(coalesce(p_note, ''), 300), p_stops, v_out, p_in_at, case when p_in_at is null then '' else v_name end, v_out, v_name, true, v_name, p_in_at is not null)
  returning * into v_row;
  perform set_config('tt.gate_again', '', true);
  perform public.tt_gate_log_write(v_row, p_by, 'nachtrag', concat('Von der Pforte nachgetragen: raus ', to_char(v_out at time zone 'Europe/Berlin', 'DD.MM. HH24:MI'),
                                   case when p_in_at is null then '' else concat(', zurück ', to_char(p_in_at at time zone 'Europe/Berlin', 'DD.MM. HH24:MI')) end), null, to_jsonb(v_row));
  return v_row;
end;
$$;

create or replace function public.tt_gate_fix(p_id uuid, p_out_at timestamptz, p_in_at timestamptz default null, p_reason text default '', p_by text default null) returns public.tt_gate
language plpgsql security definer set search_path = '' as $$
declare
  v_old public.tt_gate;
  v_row public.tt_gate;
  v_name text;
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
  if p_out_at is null or p_out_at > now() + interval '5 minutes' then
    raise exception 'Die Ausfahrt liegt in der Zukunft – bitte Datum und Uhrzeit prüfen.';
  end if;
  if p_in_at is not null and p_in_at < p_out_at then
    raise exception 'Die Rückkehr liegt vor der Ausfahrt – bitte Zeiten prüfen.';
  end if;
  if p_in_at is not null and p_in_at > now() + interval '5 minutes' then
    raise exception 'Die Rückkehr liegt in der Zukunft – bitte Datum und Uhrzeit prüfen.';
  end if;
  if p_in_at is null and v_old.away_reason = '' and exists (select 1 from public.tt_gate where profile_id = v_old.profile_id and in_at is null and away_reason = '' and id <> p_id) then
    raise exception 'Für diese Person ist schon eine andere Ausfahrt offen.';
  end if;
  v_name := public.tt_gate_who(p_by);
  update public.tt_gate
     set out_at = least(out_at, p_out_at), out_confirmed_at = p_out_at, out_by = coalesce(nullif(out_by, ''), v_name),
         date = (p_out_at at time zone 'Europe/Berlin')::date,
         in_at = p_in_at, in_by = case when p_in_at is null then '' else coalesce(nullif(in_by, ''), v_name) end,
         final = case when p_in_at is null then away_reason <> '' else final end,
         away_reason = case when p_in_at is null then away_reason else '' end,
         away_note = case when p_in_at is null then away_note else '' end,
         away_at = case when p_in_at is null then away_at else null end,
         away_by = case when p_in_at is null then away_by else '' end,
         fixed_at = now(), fixed_by = v_name
   where id = p_id
   returning * into v_row;
  perform public.tt_gate_log_write(v_row, p_by, 'korrektur', concat('Korrektur: raus ', to_char(coalesce(v_old.out_confirmed_at, v_old.out_at) at time zone 'Europe/Berlin', 'DD.MM. HH24:MI'), ' → ', to_char(p_out_at at time zone 'Europe/Berlin', 'DD.MM. HH24:MI'),
                                   ', zurück ', coalesce(to_char(v_old.in_at at time zone 'Europe/Berlin', 'DD.MM. HH24:MI'), '–'), ' → ', coalesce(to_char(p_in_at at time zone 'Europe/Berlin', 'DD.MM. HH24:MI'), '–'),
                                   ' · Grund: ', left(btrim(p_reason), 200)),
                                   jsonb_build_object('out_at', coalesce(v_old.out_confirmed_at, v_old.out_at), 'in_at', v_old.in_at), jsonb_build_object('out_at', p_out_at, 'in_at', p_in_at));
  return v_row;
end;
$$;

create or replace function public.tt_gate_unreported(p_date date)
returns table (profile_id uuid, full_name text, plate text, vehicle text, since timestamptz, source text, jobs text)
language sql stable security definer set search_path = '' as $$
  with people as (
    select p.id, coalesce(p.full_name, '') as full_name
      from public.tt_profiles p
     where p.active and p.role = 'dolmetscher' and p.employment = 'fest'
  ),
  cars as (
    select h.driver_id, v.plate, btrim(concat_ws(' ', v.brand, v.body)) as vehicle, (h.date::text || 'T' || coalesce(h.start_time::text, '00:00:00'))::timestamp at time zone 'Europe/Berlin' as since
      from public.tt_handovers h join public.tt_vehicles v on v.id = h.vehicle_id
     where h.end_time is null and h.date = p_date
  ),
  started as (
    select a.interpreter_id, min(a.started_at) as since,
           string_agg(concat(left(coalesce(a.time, ''), 5), ' ', coalesce(a.title, '')), ' · ' order by a.time) as jobs
      from public.tt_assignments a
     where a.date = p_date and not a.cancelled and a.response <> 'abgesagt' and a.started_at is not null and a.finished_at is null and a.storno_at is null
     group by a.interpreter_id
  )
  select pp.id, pp.full_name, coalesce(c.plate, ''), coalesce(c.vehicle, ''), coalesce(c.since, s.since),
         case when c.driver_id is not null and s.interpreter_id is not null then 'beides' when c.driver_id is not null then 'fahrzeug' else 'auftrag' end,
         coalesce(s.jobs, '')
    from people pp
    left join cars c on c.driver_id = pp.id
    left join started s on s.interpreter_id = pp.id
   where (public.tt_is_gate() or public.tt_is_staff())
     and (c.driver_id is not null or s.interpreter_id is not null)
     and not exists (select 1 from public.tt_gate g where g.profile_id = pp.id and (g.date = p_date or (g.in_at is null and g.away_reason = '')))
   order by coalesce(c.since, s.since);
$$;
