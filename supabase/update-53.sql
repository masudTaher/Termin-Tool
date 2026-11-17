-- Update 53 (R85): Werkstatt-Liste (ATU) – drei Abschnitte, Bremsen vorne/hinten, Fahrzeuge nachträglich dazu.
-- Die Werkstatt meldet jetzt je Fahrzeug, wo es steht: „noch nicht bearbeitet“ → „gerade in der Werkstatt“ (gelb) →
-- „fertig und zurückgebracht“ (grün). Die Einsatzleitung sieht dieselben drei Abschnitte im Fuhrpark.
--   • tt_tyre_items.in_shop_at / in_shop_by: seit wann (und von wem gemeldet) das Fahrzeug in der Werkstatt steht.
--   • tt_tyre_shop(p_token, p_item, p_in, p_by): die Werkstatt meldet „ist jetzt bei uns“ bzw. „doch nicht“. Steht das Fahrzeug
--     in der Werkstatt, wird es im Fuhrpark automatisch als „Bei ATU / Werkstatt“ geführt (niemand kann es im Portal übernehmen);
--     meldet die Werkstatt es fertig/zurück, ist es wieder einsatzbereit – nur wenn der Eintrag von dieser Liste stammt.
--   • Bremsen: zusätzlich zu „in Ordnung“ / „müssen gewechselt werden“ gibt es „wurden gewechselt“, jeweils mit vorne/hinten
--     (checks.bremsen_vorne / checks.bremsen_hinten). Die Meldung „Bremsen“ am Fahrzeug nennt vorne/hinten; „wurden gewechselt“
--     erledigt offene Bremsen-Meldungen am Fahrzeug.
--   • Fahrzeuge nachträglich auf eine offene Liste setzen und geschlossene Listen wieder öffnen macht das Büro direkt in den
--     Tabellen (Rechte aus Update 39) – dafür ist keine Datenbankänderung nötig.
-- Braucht Update 39, 44 und 52. Kann beliebig oft ausgeführt werden.

alter table public.tt_tyre_items add column if not exists in_shop_at timestamptz;
alter table public.tt_tyre_items add column if not exists in_shop_by text not null default '';

-- Ein Listeneintrag als JSON – einmal definiert, von allen drei Funktionen benutzt.
create or replace function public.tt_tyre_item_json(i public.tt_tyre_items) returns jsonb
language sql immutable as $$
  select jsonb_build_object('id', i.id, 'plate', i.plate, 'vehicle', i.vehicle, 'vehicle_type', i.vehicle_type, 'mileage', i.mileage,
                            'done', i.done, 'done_at', i.done_at, 'done_by', i.done_by, 'note', i.note, 'extra', i.extra, 'checks', i.checks,
                            'in_shop_at', i.in_shop_at, 'in_shop_by', i.in_shop_by);
$$;

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
    'items', coalesce((select jsonb_agg(public.tt_tyre_item_json(i) order by i.position, i.plate)
                       from public.tt_tyre_items i where i.campaign_id = v_c.id), '[]'::jsonb));
end;
$$;
revoke execute on function public.tt_tyre_list(text) from public;
grant execute on function public.tt_tyre_list(text) to anon, authenticated;

-- „Das Auto steht jetzt bei uns in der Werkstatt“ (p_in = true) bzw. „doch nicht“ (p_in = false).
create or replace function public.tt_tyre_shop(p_token text, p_item uuid, p_in boolean, p_by text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_c public.tt_tyre_campaigns;
  v_i public.tt_tyre_items;
  v_by text;
begin
  select * into v_c from public.tt_tyre_campaigns where token = p_token and active and char_length(coalesce(p_token, '')) >= 20;
  if v_c.id is null then
    raise exception 'Dieser Link ist nicht (mehr) gültig.';
  end if;
  v_by := left(coalesce(nullif(btrim(p_by), ''), 'Werkstatt'), 80);
  update public.tt_tyre_items
     set in_shop_at = case when p_in then coalesce(in_shop_at, now()) else null end,
         in_shop_by = case when p_in then v_by else '' end,
         updated_at = now()
   where id = p_item and campaign_id = v_c.id
   returning * into v_i;
  if v_i.id is null then
    raise exception 'Dieses Fahrzeug steht nicht (mehr) auf der Liste.';
  end if;
  if v_i.vehicle_id is not null then
    if p_in then
      -- Im Fuhrpark als „Bei ATU / Werkstatt“ führen – nur, wenn das Fahrzeug nicht schon gesperrt oder anders in der Werkstatt ist.
      update public.tt_vehicles
         set service_status = 'werkstatt', service_note = 'Werkstatt-Liste: ' || v_c.title, service_since = now(), service_until = null
       where id = v_i.vehicle_id and service_status = '';
    else
      update public.tt_vehicles
         set service_status = '', service_note = '', service_since = null, service_until = null
       where id = v_i.vehicle_id and service_status = 'werkstatt' and service_note = 'Werkstatt-Liste: ' || v_c.title;
    end if;
  end if;
  return public.tt_tyre_item_json(v_i);
end;
$$;
revoke execute on function public.tt_tyre_shop(text, uuid, boolean, text) from public;
grant execute on function public.tt_tyre_shop(text, uuid, boolean, text) to anon, authenticated;

-- Abhaken (fertig und zurückgebracht) – wie Update 52, jetzt mit Bremsen vorne/hinten und „wurden gewechselt“.
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
  v_where text;
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
  if p_checks is not null then
    v_new := jsonb_build_object(
      'adblue', coalesce((p_checks->>'adblue')::boolean, false),
      'wischwasser', coalesce((p_checks->>'wischwasser')::boolean, false),
      'checkup', coalesce((p_checks->>'checkup')::boolean, false),
      'bremsen', case when p_checks->>'bremsen' in ('ok', 'wechsel', 'gewechselt') then p_checks->>'bremsen' else '' end,
      'bremsen_vorne', coalesce((p_checks->>'bremsen_vorne')::boolean, false),
      'bremsen_hinten', coalesce((p_checks->>'bremsen_hinten')::boolean, false),
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
  if v_i.vehicle_id is not null then
    if v_i.done and not coalesce(v_was, false) then
      if v_c.tyres_to <> '' then
        update public.tt_vehicles set tyres = v_c.tyres_to, tyres_since = current_date where id = v_i.vehicle_id;
      end if;
      -- Fertig und zurückgebracht: der Werkstatt-Eintrag dieser Liste am Fahrzeug ist damit beendet.
      update public.tt_vehicles
         set service_status = '', service_note = '', service_since = null, service_until = null
       where id = v_i.vehicle_id and service_status = 'werkstatt' and service_note = 'Werkstatt-Liste: ' || v_c.title;
    end if;
    if p_checks is not null then
      v_where := case when coalesce((v_new->>'bremsen_vorne')::boolean, false) and coalesce((v_new->>'bremsen_hinten')::boolean, false) then ' vorne und hinten'
                      when coalesce((v_new->>'bremsen_vorne')::boolean, false) then ' vorne'
                      when coalesce((v_new->>'bremsen_hinten')::boolean, false) then ' hinten' else '' end;
      -- Bremsen müssen gewechselt werden: eine offene Meldung am Fahrzeug (einmal je Listeneintrag)
      if v_new->>'bremsen' = 'wechsel' and (v_new->>'alert_id') is null then
        insert into public.tt_alerts (vehicle_id, reporter_id, reporter_name, kind, note, status)
        values (v_i.vehicle_id, null, 'Werkstatt · ' || v_by, 'Bremsen', 'Werkstatt (' || v_c.title || '): Bremsen' || v_where || ' sind nicht in Ordnung und müssen gewechselt werden.' || case when coalesce(v_i.note, '') <> '' then ' Bemerkung: ' || v_i.note else '' end, 'offen')
        returning id into v_alert;
        v_new := v_new || jsonb_build_object('alert_id', v_alert);
        update public.tt_tyre_items set checks = v_new where id = v_i.id;
        v_i.checks := v_new;
      end if;
      -- Bremsen wurden gewechselt: offene Bremsen-Meldungen am Fahrzeug sind erledigt
      if v_new->>'bremsen' = 'gewechselt' then
        update public.tt_alerts set status = 'erledigt', resolved_at = now(), resolved_by = 'Werkstatt · ' || v_by
         where vehicle_id = v_i.vehicle_id and status = 'offen' and kind ilike '%brems%';
      end if;
      if coalesce((v_new->>'adblue')::boolean, false) then
        update public.tt_alerts set status = 'erledigt', resolved_at = now(), resolved_by = 'Werkstatt · ' || v_by
         where vehicle_id = v_i.vehicle_id and status = 'offen' and kind ilike '%adblue%';
      end if;
      if coalesce((v_new->>'wischwasser')::boolean, false) then
        update public.tt_alerts set status = 'erledigt', resolved_at = now(), resolved_by = 'Werkstatt · ' || v_by
         where vehicle_id = v_i.vehicle_id and status = 'offen' and kind ilike '%wischwasser%';
      end if;
    end if;
  end if;
  return public.tt_tyre_item_json(v_i);
end;
$$;
revoke execute on function public.tt_tyre_mark(text, uuid, boolean, text, text, jsonb) from public;
grant execute on function public.tt_tyre_mark(text, uuid, boolean, text, text, jsonb) to anon, authenticated;

comment on column public.tt_tyre_items.in_shop_at is 'Update 53: seit wann das Fahrzeug laut Werkstatt bei ihr steht (null = noch nicht bearbeitet oder schon fertig)';
comment on column public.tt_tyre_items.checks is 'Update 53: adblue, wischwasser, checkup (true/false), bremsen (ok/wechsel/gewechselt), bremsen_vorne, bremsen_hinten, at, by, alert_id';
