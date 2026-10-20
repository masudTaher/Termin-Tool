-- Update 44: Fuhrpark – Fahrzeugtausch (Mietwagen), Reifen und Hinweise für die Werkstatt (ATU).
--   • Tausch / Rückgabe: Ein Fahrzeug (meist ein Mietwagen) wird gegen ein anderes getauscht oder zurückgegeben. Das alte verschwindet
--     aus der Liste („Nicht mehr im Fuhrpark“), das neue kommt mit Standort und festem Fahrer dazu – und beide wissen voneinander
--     (replaced_by / replaces). tt_vehicle_events hält den Verlauf fest: wann, wer, gegen was, Vermerk.
--   • Reifen: welche Reifen gerade drauf sind (Sommer / Winter / Ganzjahr) und seit wann. Hakt die Werkstatt ein Fahrzeug auf einer
--     Reifenliste ab, deren Ziel „Winterreifen“ oder „Sommerreifen“ ist, wird das am Fahrzeug gleich eingetragen.
--   • Extras für ATU: ein Vermerk je Fahrzeug (atu_note), der auf der Werkstatt-Liste je Fahrzeug steht (tt_tyre_items.extra),
--     z. B. „Bremsen quietschen, bitte prüfen“.
-- Kann beliebig oft ausgeführt werden.

alter table public.tt_vehicles
  add column if not exists tyres text not null default '',
  add column if not exists tyres_since date,
  add column if not exists atu_note text not null default '',
  add column if not exists retired_at timestamptz,
  add column if not exists retired_kind text not null default '',
  add column if not exists retired_note text not null default '',
  add column if not exists replaced_by uuid references public.tt_vehicles (id) on delete set null,
  add column if not exists replaces uuid references public.tt_vehicles (id) on delete set null;
alter table public.tt_vehicles drop constraint if exists tt_vehicles_tyres_check;
alter table public.tt_vehicles add constraint tt_vehicles_tyres_check check (tyres in ('', 'sommer', 'winter', 'ganzjahr'));
alter table public.tt_vehicles drop constraint if exists tt_vehicles_retired_kind_check;
alter table public.tt_vehicles add constraint tt_vehicles_retired_kind_check check (retired_kind in ('', 'tausch', 'rueckgabe', 'sonstiges'));

-- Verlauf je Fahrzeug: aufgenommen, getauscht, ersetzt, zurückgegeben, sonstiges, wieder aufgenommen.
create table if not exists public.tt_vehicle_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by text not null default '',
  vehicle_id uuid not null references public.tt_vehicles (id) on delete cascade,
  kind text not null check (kind in ('aufnahme', 'tausch', 'ersetzt', 'rueckgabe', 'sonstiges', 'wieder')),
  other_vehicle_id uuid references public.tt_vehicles (id) on delete set null,
  other_plate text not null default '',
  note text not null default '',
  mileage integer
);
create index if not exists tt_vehicle_events_vehicle_idx on public.tt_vehicle_events (vehicle_id, created_at);
alter table public.tt_vehicle_events enable row level security;
revoke all on public.tt_vehicle_events from anon, authenticated;
grant select, insert, update, delete on public.tt_vehicle_events to authenticated;
drop policy if exists tt_vehicle_events_staff on public.tt_vehicle_events;
create policy tt_vehicle_events_staff on public.tt_vehicle_events for all to authenticated
  using (public.tt_is_staff()) with check (public.tt_is_staff());

create or replace function public.tt_vehicle_event_stamp() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.created_at := now();
  if btrim(coalesce(new.created_by, '')) = '' then
    select coalesce(nullif(full_name, ''), 'Einsatzleitung') into new.created_by from public.tt_profiles where id = (select auth.uid());
  end if;
  new.note := left(coalesce(new.note, ''), 400);
  if new.other_vehicle_id is not null and btrim(coalesce(new.other_plate, '')) = '' then
    select plate into new.other_plate from public.tt_vehicles where id = new.other_vehicle_id;
  end if;
  return new;
end;
$$;
drop trigger if exists tt_vehicle_event_stamp on public.tt_vehicle_events;
create trigger tt_vehicle_event_stamp before insert on public.tt_vehicle_events for each row execute function public.tt_vehicle_event_stamp();

-- Tausch (p_kind 'tausch', mit p_new: Daten des neuen Fahrzeugs), Rückgabe ('rueckgabe') oder sonstiger Abgang ('sonstiges').
-- Das alte Fahrzeug geht aus der Liste; ein neues wird angelegt (oder ein früher entferntes Kennzeichen wieder aufgenommen)
-- und übernimmt Standort und festen Fahrer. Beides steht im Verlauf.
create or replace function public.tt_vehicle_swap(p_vehicle uuid, p_kind text, p_note text default '', p_new jsonb default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_old public.tt_vehicles;
  v_new public.tt_vehicles;
  v_me text;
  v_plate text;
  v_key text;
  v_holder text;
begin
  if not public.tt_is_staff() then
    raise exception 'Das darf nur die Einsatzleitung.';
  end if;
  if p_kind not in ('tausch', 'rueckgabe', 'sonstiges') then
    raise exception 'Unbekannte Art: %', p_kind;
  end if;
  select coalesce(nullif(full_name, ''), 'Einsatzleitung') into v_me from public.tt_profiles where id = (select auth.uid());
  select * into v_old from public.tt_vehicles where id = p_vehicle and active;
  if v_old.id is null then
    raise exception 'Dieses Fahrzeug gibt es nicht (mehr) im Fuhrpark.';
  end if;
  select driver_name into v_holder from public.tt_handovers where vehicle_id = p_vehicle and end_time is null limit 1;
  if v_holder is not null then
    raise exception 'Das Fahrzeug ist gerade bei %. Bitte zuerst die Rückgabe eintragen.', v_holder;
  end if;

  if p_kind = 'tausch' then
    v_plate := upper(regexp_replace(btrim(coalesce(p_new ->> 'plate', '')), '\s+', ' ', 'g'));
    v_key := regexp_replace(v_plate, '[\s-]', '', 'g');
    if v_key = '' then
      raise exception 'Bitte das Kennzeichen des neuen Fahrzeugs eintragen.';
    end if;
    if v_key = v_old.plate_key then
      raise exception 'Das neue Fahrzeug hat dasselbe Kennzeichen wie das alte.';
    end if;
    select * into v_new from public.tt_vehicles where plate_key = v_key;
    if v_new.id is not null and v_new.active then
      raise exception 'Das Kennzeichen % gibt es schon im Fuhrpark.', v_new.plate;
    end if;
    if v_new.id is not null then
      -- früher aus dem Fuhrpark genommen: wieder aufnehmen, mit den neuen Angaben
      update public.tt_vehicles
         set active = true, plate = v_plate,
             brand = coalesce(nullif(btrim(p_new ->> 'brand'), ''), brand), body = coalesce(nullif(p_new ->> 'body', ''), body),
             type = coalesce(nullif(p_new ->> 'type', ''), 'Mietwagen'), label = coalesce(p_new ->> 'label', ''),
             station = v_old.station, driver_note = v_old.driver_note, assigned_to = v_old.assigned_to,
             mileage = case when (p_new ->> 'mileage') ~ '^\d+$' then (p_new ->> 'mileage')::integer else null end,
             fuel = null, parking = v_old.parking, clean_inside = null, clean_outside = null,
             state_updated_at = now(), state_updated_by = v_me,
             service_status = '', service_note = '', service_since = null, service_until = null,
             tyres = coalesce(nullif(p_new ->> 'tyres', ''), ''), tyres_since = case when nullif(p_new ->> 'tyres', '') is not null then current_date else null end,
             atu_note = '', retired_at = null, retired_kind = '', retired_note = '', replaced_by = null, replaces = v_old.id
       where id = v_new.id
       returning * into v_new;
    else
      insert into public.tt_vehicles (plate, plate_key, brand, body, type, label, station, driver_note, assigned_to, mileage, parking,
                                      state_updated_at, state_updated_by, tyres, tyres_since, replaces)
      values (v_plate, v_key, coalesce(nullif(btrim(p_new ->> 'brand'), ''), 'Mietwagen'), coalesce(p_new ->> 'body', ''),
              coalesce(nullif(p_new ->> 'type', ''), 'Mietwagen'), coalesce(p_new ->> 'label', ''), v_old.station, v_old.driver_note, v_old.assigned_to,
              case when (p_new ->> 'mileage') ~ '^\d+$' then (p_new ->> 'mileage')::integer else null end, v_old.parking,
              now(), v_me, coalesce(nullif(p_new ->> 'tyres', ''), ''), case when nullif(p_new ->> 'tyres', '') is not null then current_date else null end, v_old.id)
      returning * into v_new;
    end if;
  end if;

  update public.tt_vehicles
     set active = false, assigned_to = null, service_status = '', service_note = '', service_since = null, service_until = null,
         retired_at = now(), retired_kind = p_kind, retired_note = left(coalesce(p_note, ''), 400), replaced_by = v_new.id
   where id = v_old.id;

  insert into public.tt_vehicle_events (vehicle_id, kind, other_vehicle_id, other_plate, note, mileage, created_by)
  values (v_old.id, p_kind, v_new.id, coalesce(v_new.plate, ''), coalesce(p_note, ''), v_old.mileage, v_me);
  if v_new.id is not null then
    insert into public.tt_vehicle_events (vehicle_id, kind, other_vehicle_id, other_plate, note, mileage, created_by)
    values (v_new.id, 'ersetzt', v_old.id, v_old.plate, coalesce(p_note, ''), v_new.mileage, v_me);
  end if;
  return jsonb_build_object('old_id', v_old.id, 'old_plate', v_old.plate, 'new_id', v_new.id, 'new_plate', v_new.plate, 'kind', p_kind);
end;
$$;
revoke execute on function public.tt_vehicle_swap(uuid, text, text, jsonb) from public, anon;
grant execute on function public.tt_vehicle_swap(uuid, text, text, jsonb) to authenticated;

-- Werkstatt-Listen (Update 39): Ziel der Liste (welche Reifen danach drauf sind) und Extras je Fahrzeug vom Büro.
alter table public.tt_tyre_campaigns add column if not exists tyres_to text not null default '';
alter table public.tt_tyre_campaigns drop constraint if exists tt_tyre_campaigns_tyres_to_check;
alter table public.tt_tyre_campaigns add constraint tt_tyre_campaigns_tyres_to_check check (tyres_to in ('', 'sommer', 'winter', 'ganzjahr'));
alter table public.tt_tyre_items add column if not exists extra text not null default '';

create or replace function public.tt_tyre_list(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_c public.tt_tyre_campaigns;
begin
  select * into v_c from public.tt_tyre_campaigns where token = p_token and active and char_length(coalesce(p_token, '')) >= 20;
  if v_c.id is null then
    raise exception 'Dieser Link ist nicht (mehr) gültig.';
  end if;
  return jsonb_build_object(
    'title', v_c.title, 'note', v_c.note, 'tyres_to', v_c.tyres_to, 'created_at', v_c.created_at, 'created_by', v_c.created_by_name,
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'plate', i.plate, 'vehicle', i.vehicle, 'vehicle_type', i.vehicle_type, 'mileage', i.mileage,
                                                           'done', i.done, 'done_at', i.done_at, 'done_by', i.done_by, 'note', i.note, 'extra', i.extra) order by i.position, i.plate)
                       from public.tt_tyre_items i where i.campaign_id = v_c.id), '[]'::jsonb));
end;
$$;
revoke execute on function public.tt_tyre_list(text) from public;
grant execute on function public.tt_tyre_list(text) to anon, authenticated;

-- Abhaken: wie bisher – und hat die Liste ein Reifen-Ziel, steht es danach am Fahrzeug (Reifen seit heute).
create or replace function public.tt_tyre_mark(p_token text, p_item uuid, p_done boolean, p_by text default '', p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_c public.tt_tyre_campaigns;
  v_i public.tt_tyre_items;
  v_was boolean;
begin
  select * into v_c from public.tt_tyre_campaigns where token = p_token and active and char_length(coalesce(p_token, '')) >= 20;
  if v_c.id is null then
    raise exception 'Dieser Link ist nicht (mehr) gültig.';
  end if;
  select done into v_was from public.tt_tyre_items where id = p_item and campaign_id = v_c.id;
  update public.tt_tyre_items
     set done = coalesce(p_done, done),
         done_at = case when coalesce(p_done, done) then coalesce(case when done then done_at else null end, now()) else null end,
         done_by = case when coalesce(p_done, done) then left(coalesce(nullif(btrim(p_by), ''), done_by), 80) else '' end,
         note = case when p_note is null then note else left(btrim(p_note), 300) end,
         updated_at = now()
   where id = p_item and campaign_id = v_c.id
   returning * into v_i;
  if v_i.id is null then
    raise exception 'Dieses Fahrzeug steht nicht (mehr) auf der Liste.';
  end if;
  if v_i.done and not coalesce(v_was, false) and v_c.tyres_to <> '' and v_i.vehicle_id is not null then
    update public.tt_vehicles set tyres = v_c.tyres_to, tyres_since = current_date where id = v_i.vehicle_id;
  end if;
  return jsonb_build_object('id', v_i.id, 'plate', v_i.plate, 'vehicle', v_i.vehicle, 'vehicle_type', v_i.vehicle_type, 'mileage', v_i.mileage,
                            'done', v_i.done, 'done_at', v_i.done_at, 'done_by', v_i.done_by, 'note', v_i.note, 'extra', v_i.extra);
end;
$$;
revoke execute on function public.tt_tyre_mark(text, uuid, boolean, text, text) from public;
grant execute on function public.tt_tyre_mark(text, uuid, boolean, text, text) to anon, authenticated;
