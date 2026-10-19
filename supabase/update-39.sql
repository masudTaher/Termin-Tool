-- Update 39: Reifenwechsel-Liste für die Werkstatt (ATU) – ein Link ohne Zugangsdaten.
-- Die Einsatzleitung stellt im Fuhrpark eine Liste zusammen (standardmäßig alle diplomatischen Fahrzeuge) und schickt der Werkstatt
-- einen Link (reifen.html?k=…). Die Werkstatt sieht nur Kennzeichen, Modell und Kilometerstand – keine Fahrer, keine Akten – und
-- hakt ab, was fertig ist (mit Name und Bemerkung). Beide sehen denselben Stand. Die Einsatzleitung schließt die Liste; dann
-- geht der Link nicht mehr.
--   • tt_tyre_campaigns: eine Liste je Aktion, mit geheimem Schlüssel (token) – nur das Büro liest und schreibt die Tabelle direkt.
--   • tt_tyre_items: ein Eintrag je Fahrzeug der Liste.
--   • tt_tyre_list(p_token) / tt_tyre_mark(…): die Werkstatt arbeitet nur über diese zwei Funktionen (ohne Anmeldung),
--     und nur mit gültigem Schlüssel einer offenen Liste.
-- Kann beliebig oft ausgeführt werden.

create table if not exists public.tt_tyre_campaigns (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by uuid references public.tt_profiles (id) on delete set null,
  created_by_name text not null default '',
  title text not null default 'Reifenwechsel',
  note text not null default '',               -- Hinweis für die Werkstatt (z. B. Winterreifen, Termin)
  token text not null unique check (char_length(token) >= 20),
  active boolean not null default true,
  closed_at timestamptz
);
create table if not exists public.tt_tyre_items (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.tt_tyre_campaigns (id) on delete cascade,
  vehicle_id uuid references public.tt_vehicles (id) on delete set null,
  plate text not null default '',
  vehicle text not null default '',            -- Marke und Modell
  vehicle_type text not null default '',
  mileage integer,
  position integer not null default 0,
  done boolean not null default false,
  done_at timestamptz,
  done_by text not null default '',
  note text not null default '',
  updated_at timestamptz not null default now()
);
create index if not exists tt_tyre_items_campaign_idx on public.tt_tyre_items (campaign_id, position);
alter table public.tt_tyre_campaigns enable row level security;
alter table public.tt_tyre_items enable row level security;
revoke all on public.tt_tyre_campaigns from anon, authenticated;
revoke all on public.tt_tyre_items from anon, authenticated;
grant select, insert, update, delete on public.tt_tyre_campaigns to authenticated;
grant select, insert, update, delete on public.tt_tyre_items to authenticated;
drop policy if exists tt_tyre_campaigns_staff on public.tt_tyre_campaigns;
create policy tt_tyre_campaigns_staff on public.tt_tyre_campaigns for all to authenticated
  using (public.tt_is_staff()) with check (public.tt_is_staff());
drop policy if exists tt_tyre_items_staff on public.tt_tyre_items;
create policy tt_tyre_items_staff on public.tt_tyre_items for all to authenticated
  using (public.tt_is_staff()) with check (public.tt_is_staff());

-- Die Werkstatt: Liste lesen (nur mit Schlüssel einer offenen Liste).
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
    'title', v_c.title, 'note', v_c.note, 'created_at', v_c.created_at, 'created_by', v_c.created_by_name,
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'plate', i.plate, 'vehicle', i.vehicle, 'vehicle_type', i.vehicle_type, 'mileage', i.mileage,
                                                           'done', i.done, 'done_at', i.done_at, 'done_by', i.done_by, 'note', i.note) order by i.position, i.plate)
                       from public.tt_tyre_items i where i.campaign_id = v_c.id), '[]'::jsonb));
end;
$$;
revoke execute on function public.tt_tyre_list(text) from public;
grant execute on function public.tt_tyre_list(text) to anon, authenticated;

-- Die Werkstatt: ein Fahrzeug abhaken (oder den Haken zurücknehmen), mit Name und Bemerkung.
create or replace function public.tt_tyre_mark(p_token text, p_item uuid, p_done boolean, p_by text default '', p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_c public.tt_tyre_campaigns;
  v_i public.tt_tyre_items;
begin
  select * into v_c from public.tt_tyre_campaigns where token = p_token and active and char_length(coalesce(p_token, '')) >= 20;
  if v_c.id is null then
    raise exception 'Dieser Link ist nicht (mehr) gültig.';
  end if;
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
  return jsonb_build_object('id', v_i.id, 'plate', v_i.plate, 'vehicle', v_i.vehicle, 'vehicle_type', v_i.vehicle_type, 'mileage', v_i.mileage,
                            'done', v_i.done, 'done_at', v_i.done_at, 'done_by', v_i.done_by, 'note', v_i.note);
end;
$$;
revoke execute on function public.tt_tyre_mark(text, uuid, boolean, text, text) from public;
grant execute on function public.tt_tyre_mark(text, uuid, boolean, text, text) to anon, authenticated;
