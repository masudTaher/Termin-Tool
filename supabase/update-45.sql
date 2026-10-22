-- Update 45: Pforte – Name des Pförtners, Nachträge und Korrekturen mit Protokoll, nicht gemeldete Fahrten erkennen.
--   • Das Pforten-Konto teilen sich mehrere Personen. Darum trägt die Pforte oben ihren Namen ein; jede Bestätigung, Rückkehr,
--     jeder Nachtrag und jede Korrektur wird mit diesem Namen gespeichert (p_by in allen Pforten-Funktionen; ohne Namen zählt
--     wie bisher der Name des Kontos).
--   • tt_gate_manual: Die Pforte (oder das Büro) trägt eine Ausfahrt selbst ein – wer, welches Auto, wohin, raus wann (Datum und
--     Uhrzeit, auch rückwirkend) und falls schon bekannt: zurück wann.
--   • tt_gate_fix: Zeiten einer Fahrt korrigieren (raus / zurück), mit Grund.
--   • tt_gate_log: das Protokoll – jede Änderung mit Name, Zeitpunkt, vorher und nachher. Steht im Tagesbericht.
--   • tt_gate_people / tt_gate_vehicles: Personen und Fahrzeuge für die Auswahl beim Nachtrag (nur Pforte und Büro, keine Akten).
--   • tt_gate_unreported: Wer laut App unterwegs ist (Fahrzeug übernommen oder „Losgefahren“), aber an der Pforte nicht gemeldet.
-- Braucht Update 38. Kann beliebig oft ausgeführt werden.

alter table public.tt_gate add column if not exists by_gate boolean not null default false;      -- von der Pforte nachgetragen
alter table public.tt_gate add column if not exists entered_by text not null default '';          -- wer nachgetragen hat
alter table public.tt_gate add column if not exists fixed_at timestamptz;                          -- zuletzt korrigiert
alter table public.tt_gate add column if not exists fixed_by text not null default '';

create table if not exists public.tt_gate_log (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  date date not null default ((now() at time zone 'Europe/Berlin')::date),
  gate_id uuid references public.tt_gate (id) on delete set null,
  driver_name text not null default '',
  plate text not null default '',
  by_name text not null default '',
  action text not null,                       -- bestaetigt, zurueck, nachtrag, korrektur, wieder_raus, fertig, nicht_gefahren, zurueckgenommen
  detail text not null default '',
  before jsonb,
  after jsonb
);
create index if not exists tt_gate_log_date_idx on public.tt_gate_log (date, at);
alter table public.tt_gate_log enable row level security;
revoke all on public.tt_gate_log from anon, authenticated;
grant select on public.tt_gate_log to authenticated;
drop policy if exists tt_gate_log_select on public.tt_gate_log;
create policy tt_gate_log_select on public.tt_gate_log for select to authenticated
  using (public.tt_is_gate() or public.tt_is_staff());
-- Schreiben nur über die Funktionen unten (security definer) – nie direkt.

-- Name für das Protokoll: der eingetragene Name der Pforte, sonst der Name des Kontos.
create or replace function public.tt_gate_who(p_by text) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(left(btrim(coalesce(p_by, '')), 80), ''), (select full_name from public.tt_profiles where id = (select auth.uid())), 'Pforte');
$$;
revoke execute on function public.tt_gate_who(text) from public, anon;
grant execute on function public.tt_gate_who(text) to authenticated;

create or replace function public.tt_gate_log_write(p_row public.tt_gate, p_by text, p_action text, p_detail text, p_before jsonb default null, p_after jsonb default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.tt_gate_log (gate_id, date, driver_name, plate, by_name, action, detail, before, after)
  values (p_row.id, coalesce(p_row.date, (now() at time zone 'Europe/Berlin')::date), coalesce(p_row.driver_name, ''), coalesce(p_row.plate, ''), public.tt_gate_who(p_by), p_action, left(coalesce(p_detail, ''), 400), p_before, p_after);
end;
$$;
revoke execute on function public.tt_gate_log_write(public.tt_gate, text, text, text, jsonb, jsonb) from public, anon, authenticated;

-- Die bisherigen Funktionen bekommen den Namen der Pforte (p_by) und schreiben ins Protokoll.
drop function if exists public.tt_gate_out(uuid, boolean);
create or replace function public.tt_gate_out(p_id uuid, p_ok boolean default true, p_by text default null) returns public.tt_gate
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
     set out_confirmed_at = case when p_ok then coalesce(out_confirmed_at, now()) else null end,
         out_by = case when p_ok then coalesce(nullif(out_by, ''), v_name) else '' end
   where id = p_id and (p_ok or in_at is null)
   returning * into v_row;
  if v_row.id is null then
    raise exception 'Diese Meldung gibt es nicht (mehr) oder die Person ist schon zurück.';
  end if;
  perform public.tt_gate_log_write(v_row, p_by, case when p_ok then 'bestaetigt' else 'zurueckgenommen' end, case when p_ok then 'Ausfahrt bestätigt' else 'Bestätigung der Ausfahrt zurückgenommen' end);
  return v_row;
end;
$$;
revoke execute on function public.tt_gate_out(uuid, boolean, text) from public, anon;
grant execute on function public.tt_gate_out(uuid, boolean, text) to authenticated;

drop function if exists public.tt_gate_return(uuid, boolean);
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
         out_by = case when p_back then coalesce(nullif(out_by, ''), v_name) else out_by end
   where id = p_id
   returning * into v_row;
  if v_row.id is null then
    raise exception 'Diese Meldung gibt es nicht (mehr).';
  end if;
  perform public.tt_gate_log_write(v_row, p_by, case when p_back then 'zurueck' else 'zurueckgenommen' end, case when p_back then 'Rückkehr eingetragen' else 'Rückkehr zurückgenommen (wieder draußen)' end);
  return v_row;
end;
$$;
revoke execute on function public.tt_gate_return(uuid, boolean, text) from public, anon;
grant execute on function public.tt_gate_return(uuid, boolean, text) to authenticated;

drop function if exists public.tt_gate_drop(uuid);
create or replace function public.tt_gate_drop(p_id uuid, p_by text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.tt_gate;
begin
  if not (public.tt_is_gate() or public.tt_is_staff()) then
    raise exception 'Das darf nur die Pforte oder die Einsatzleitung.';
  end if;
  delete from public.tt_gate where id = p_id and out_confirmed_at is null and in_at is null returning * into v_row;
  if v_row.id is null then
    raise exception 'Diese Meldung ist schon bestätigt oder es gibt sie nicht mehr.';
  end if;
  v_row.id := null;   -- die Zeile ist weg; das Protokoll behält Name und Fahrzeug
  perform public.tt_gate_log_write(v_row, p_by, 'nicht_gefahren', 'Meldung herausgenommen (nicht gefahren)');
end;
$$;
revoke execute on function public.tt_gate_drop(uuid, text) from public, anon;
grant execute on function public.tt_gate_drop(uuid, text) to authenticated;

drop function if exists public.tt_gate_done(uuid, boolean);
create or replace function public.tt_gate_done(p_id uuid, p_done boolean default true, p_by text default null) returns public.tt_gate
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.tt_gate;
begin
  if not (public.tt_is_gate() or public.tt_is_staff()) then
    raise exception 'Das darf nur die Pforte oder die Einsatzleitung.';
  end if;
  update public.tt_gate set final = p_done where id = p_id and in_at is not null returning * into v_row;
  if v_row.id is null then
    raise exception 'Diese Meldung gibt es nicht (mehr) oder die Person ist noch draußen.';
  end if;
  perform public.tt_gate_log_write(v_row, p_by, 'fertig', case when p_done then 'Heute fertig' else 'Fährt doch wieder raus' end);
  return v_row;
end;
$$;
revoke execute on function public.tt_gate_done(uuid, boolean, text) from public, anon;
grant execute on function public.tt_gate_done(uuid, boolean, text) to authenticated;

drop function if exists public.tt_gate_again(uuid, jsonb);
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
  if v_old.in_at is null then
    raise exception 'Die Person ist noch draußen – bitte zuerst „Ist zurück“ eintragen.';
  end if;
  if exists (select 1 from public.tt_gate where profile_id = v_old.profile_id and in_at is null) then
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
revoke execute on function public.tt_gate_again(uuid, jsonb, text) from public, anon;
grant execute on function public.tt_gate_again(uuid, jsonb, text) to authenticated;

-- Nachtrag durch die Pforte: wer, welches Auto, wohin, raus wann (auch rückwirkend), und falls schon zurück: wann.
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
  if p_in_at is null and exists (select 1 from public.tt_gate where profile_id = p_profile and in_at is null) then
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
revoke execute on function public.tt_gate_manual(uuid, text, text, text, jsonb, timestamptz, timestamptz, text) from public, anon;
grant execute on function public.tt_gate_manual(uuid, text, text, text, jsonb, timestamptz, timestamptz, text) to authenticated;

-- Zeiten korrigieren: raus (Datum und Uhrzeit) und zurück (oder leer = noch draußen), mit Grund.
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
  if p_in_at is null and exists (select 1 from public.tt_gate where profile_id = v_old.profile_id and in_at is null and id <> p_id) then
    raise exception 'Für diese Person ist schon eine andere Ausfahrt offen.';
  end if;
  v_name := public.tt_gate_who(p_by);
  update public.tt_gate
     set out_at = least(out_at, p_out_at), out_confirmed_at = p_out_at, out_by = coalesce(nullif(out_by, ''), v_name),
         date = (p_out_at at time zone 'Europe/Berlin')::date,
         in_at = p_in_at, in_by = case when p_in_at is null then '' else coalesce(nullif(in_by, ''), v_name) end,
         final = case when p_in_at is null then false else final end,
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
revoke execute on function public.tt_gate_fix(uuid, timestamptz, timestamptz, text, text) from public, anon;
grant execute on function public.tt_gate_fix(uuid, timestamptz, timestamptz, text, text) to authenticated;

-- Auswahl beim Nachtrag: fest angestellte Dolmetscher und das Büro (nur Name) – keine Akten, keine Nummern.
create or replace function public.tt_gate_people()
returns table (id uuid, full_name text, employment text, role text)
language sql stable security definer set search_path = '' as $$
  select p.id, coalesce(p.full_name, ''), coalesce(p.employment, ''), p.role
    from public.tt_profiles p
   where (public.tt_is_gate() or public.tt_is_staff())
     and p.active and ((p.role = 'dolmetscher' and p.employment = 'fest') or p.role in ('admin', 'sekretariat'))
   order by p.full_name;
$$;
revoke execute on function public.tt_gate_people() from public, anon;
grant execute on function public.tt_gate_people() to authenticated;

-- Fahrzeuge in Bonn für die Auswahl – mit der Person, die das Auto laut App gerade hat.
create or replace function public.tt_gate_vehicles()
returns table (id uuid, plate text, vehicle text, type text, holder text, holder_id uuid)
language sql stable security definer set search_path = '' as $$
  select v.id, v.plate, btrim(concat_ws(' ', v.brand, v.body)), coalesce(v.type, ''),
         coalesce((select h.driver_name from public.tt_handovers h where h.vehicle_id = v.id and h.end_time is null order by h.created_at desc limit 1), ''),
         (select h.driver_id from public.tt_handovers h where h.vehicle_id = v.id and h.end_time is null order by h.created_at desc limit 1)
    from public.tt_vehicles v
   where (public.tt_is_gate() or public.tt_is_staff())
     and v.active and coalesce(v.station, 'Bonn') = 'Bonn'
   order by v.plate;
$$;
revoke execute on function public.tt_gate_vehicles() from public, anon;
grant execute on function public.tt_gate_vehicles() to authenticated;

-- Laut App unterwegs, aber an der Pforte nicht gemeldet (heute): Fahrzeug übernommen oder „Losgefahren“ gedrückt.
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
     and not exists (select 1 from public.tt_gate g where g.profile_id = pp.id and (g.date = p_date or g.in_at is null))
   order by coalesce(c.since, s.since);
$$;
revoke execute on function public.tt_gate_unreported(date) from public, anon;
grant execute on function public.tt_gate_unreported(date) to authenticated;
