-- Update 52 (R82): Werkstatt-Liste (ATU) – Prüfpunkte je Fahrzeug.
-- Beim Reifenwechsel kontrolliert und ergänzt die Werkstatt oft noch etwas. Das hakt sie jetzt je Fahrzeug ab und es steht im
-- Protokoll (mit Name und Zeit): AdBlue nachgefüllt, Wischwasser nachgefüllt, Check-up gemacht, Bremsen in Ordnung oder
-- Bremsen müssen gewechselt werden – dazu wie bisher die freie Bemerkung.
--   • tt_tyre_items.checks (jsonb): { adblue, wischwasser, checkup: true/false, bremsen: '' | 'ok' | 'wechsel', at, by }
--   • Meldet die Werkstatt „Bremsen wechseln“, entsteht am Fahrzeug eine offene Meldung (tt_alerts, Art „Bremsen“) – die
--     Einsatzleitung sieht sie im Fuhrpark wie jede Meldung eines Fahrers.
--   • „AdBlue nachgefüllt“ / „Wischwasser nachgefüllt“ erledigen offene Meldungen dieser Art am Fahrzeug.
-- Braucht Update 39 und 44. Kann beliebig oft ausgeführt werden.

alter table public.tt_tyre_items add column if not exists checks jsonb not null default '{}'::jsonb;

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
                                                           'done', i.done, 'done_at', i.done_at, 'done_by', i.done_by, 'note', i.note, 'extra', i.extra, 'checks', i.checks) order by i.position, i.plate)
                       from public.tt_tyre_items i where i.campaign_id = v_c.id), '[]'::jsonb));
end;
$$;
revoke execute on function public.tt_tyre_list(text) from public;
grant execute on function public.tt_tyre_list(text) to anon, authenticated;

-- Abhaken wie bisher – jetzt mit Prüfpunkten (p_checks). Die alte Funktion mit fünf Parametern wird ersetzt
-- (sonst wären beide Aufrufe mehrdeutig); Aufrufe ohne p_checks laufen weiter.
drop function if exists public.tt_tyre_mark(text, uuid, boolean, text, text);
create or replace function public.tt_tyre_mark(p_token text, p_item uuid, p_done boolean, p_by text default '', p_note text default null, p_checks jsonb default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_c public.tt_tyre_campaigns;
  v_i public.tt_tyre_items;
  v_was boolean;
  v_old jsonb;
  v_new jsonb;
  v_by text;
  v_alert uuid;
begin
  select * into v_c from public.tt_tyre_campaigns where token = p_token and active and char_length(coalesce(p_token, '')) >= 20;
  if v_c.id is null then
    raise exception 'Dieser Link ist nicht (mehr) gültig.';
  end if;
  select done, checks into v_was, v_old from public.tt_tyre_items where id = p_item and campaign_id = v_c.id;
  if v_old is null then
    raise exception 'Dieses Fahrzeug steht nicht (mehr) auf der Liste.';
  end if;
  v_by := left(coalesce(nullif(btrim(p_by), ''), 'Werkstatt'), 80);
  -- Prüfpunkte: nur bekannte Felder, Zeit und Name aus der Datenbank
  if p_checks is not null then
    v_new := jsonb_build_object(
      'adblue', coalesce((p_checks->>'adblue')::boolean, false),
      'wischwasser', coalesce((p_checks->>'wischwasser')::boolean, false),
      'checkup', coalesce((p_checks->>'checkup')::boolean, false),
      'bremsen', case when p_checks->>'bremsen' in ('ok', 'wechsel') then p_checks->>'bremsen' else '' end,
      'at', now(), 'by', v_by,
      'alert_id', v_old->>'alert_id');
  else
    v_new := v_old;
  end if;
  update public.tt_tyre_items
     set done = coalesce(p_done, done),
         done_at = case when coalesce(p_done, done) then coalesce(case when done then done_at else null end, now()) else null end,
         done_by = case when coalesce(p_done, done) then left(coalesce(nullif(btrim(p_by), ''), done_by), 80) else '' end,
         note = case when p_note is null then note else left(btrim(p_note), 300) end,
         checks = v_new,
         updated_at = now()
   where id = p_item and campaign_id = v_c.id
   returning * into v_i;
  if v_i.done and not coalesce(v_was, false) and v_c.tyres_to <> '' and v_i.vehicle_id is not null then
    update public.tt_vehicles set tyres = v_c.tyres_to, tyres_since = current_date where id = v_i.vehicle_id;
  end if;
  if p_checks is not null and v_i.vehicle_id is not null then
    -- Bremsen wechseln: eine offene Meldung am Fahrzeug (einmal je Listeneintrag)
    if v_new->>'bremsen' = 'wechsel' and (v_new->>'alert_id') is null then
      insert into public.tt_alerts (vehicle_id, reporter_id, reporter_name, kind, note, status)
      values (v_i.vehicle_id, null, 'Werkstatt · ' || v_by, 'Bremsen', 'Werkstatt beim Reifenwechsel (' || v_c.title || '): Bremsen sind nicht in Ordnung und müssen gewechselt werden.' || case when coalesce(v_i.note, '') <> '' then ' Bemerkung: ' || v_i.note else '' end, 'offen')
      returning id into v_alert;
      v_new := v_new || jsonb_build_object('alert_id', v_alert);
      update public.tt_tyre_items set checks = v_new where id = v_i.id;
      v_i.checks := v_new;
    end if;
    -- Nachgefüllt: offene Meldungen dieser Art am Fahrzeug sind erledigt
    if coalesce((v_new->>'adblue')::boolean, false) then
      update public.tt_alerts set status = 'erledigt', resolved_at = now(), resolved_by = 'Werkstatt · ' || v_by
       where vehicle_id = v_i.vehicle_id and status = 'offen' and kind ilike '%adblue%';
    end if;
    if coalesce((v_new->>'wischwasser')::boolean, false) then
      update public.tt_alerts set status = 'erledigt', resolved_at = now(), resolved_by = 'Werkstatt · ' || v_by
       where vehicle_id = v_i.vehicle_id and status = 'offen' and kind ilike '%wischwasser%';
    end if;
  end if;
  return jsonb_build_object('id', v_i.id, 'plate', v_i.plate, 'vehicle', v_i.vehicle, 'vehicle_type', v_i.vehicle_type, 'mileage', v_i.mileage,
                            'done', v_i.done, 'done_at', v_i.done_at, 'done_by', v_i.done_by, 'note', v_i.note, 'extra', v_i.extra, 'checks', v_i.checks);
end;
$$;
revoke execute on function public.tt_tyre_mark(text, uuid, boolean, text, text, jsonb) from public;
grant execute on function public.tt_tyre_mark(text, uuid, boolean, text, text, jsonb) to anon, authenticated;

comment on column public.tt_tyre_items.checks is 'Update 52: Prüfpunkte der Werkstatt – adblue, wischwasser, checkup (true/false), bremsen (ok/wechsel), at, by, alert_id';
