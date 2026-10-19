-- Update 41: Heidelberg – Fahrzeuge und Tankkarten der Kollegen dort.
-- Die Kollegen in Heidelberg haben feste Fahrzeuge und Tankkarten. Damit die Einsatzleitung den Überblick behält:
--   • tt_vehicles.station: 'Bonn' (Standard) oder 'Heidelberg'. Heidelberger Fahrzeuge stehen im Fuhrpark unter „Heidelberg“
--     und erscheinen in der Dolmetscher-App in Bonn nicht zur Übernahme. driver_note: fester Fahrer dort (nur als Text).
--   • tt_fuel_cards: „Heidelberg“ lässt sich als Inhaber wählen (holder_name, ohne Konto) – statt eines Fahrernamens.
--     tt_fuel_card_set bekommt dafür einen dritten Parameter p_place.
-- Kann beliebig oft ausgeführt werden.

alter table public.tt_vehicles add column if not exists station text not null default 'Bonn';
alter table public.tt_vehicles drop constraint if exists tt_vehicles_station_check;
alter table public.tt_vehicles add constraint tt_vehicles_station_check check (station in ('Bonn', 'Heidelberg'));
alter table public.tt_vehicles add column if not exists driver_note text not null default '';

-- Heidelberger Fahrzeuge sieht in der Dolmetscher-App niemand (nur das Büro) – sie werden in Bonn nicht übernommen.
drop policy if exists tt_vehicles_select on public.tt_vehicles;
create policy tt_vehicles_select on public.tt_vehicles for select to authenticated
  using (
    public.tt_is_member()
    and (
      public.tt_is_staff()
      or (station = 'Bonn' and (assigned_to is null or assigned_to = (select auth.uid())))
      or public.tt_holds_vehicle(id)
    )
  );

drop function if exists public.tt_fuel_card_set(uuid, uuid);
create or replace function public.tt_fuel_card_set(p_card uuid, p_profile uuid default null, p_place text default '')
returns public.tt_fuel_cards
language plpgsql security definer set search_path = '' as $$
declare
  v_card public.tt_fuel_cards;
  v_person public.tt_profiles;
  v_admin text;
  v_place text := nullif(btrim(coalesce(p_place, '')), '');
begin
  if not public.tt_is_admin() then
    raise exception 'Tankkarten darf nur der Admin ausgeben und zurücknehmen.';
  end if;
  if v_place is not null and v_place not in ('Heidelberg') then
    raise exception 'Unbekannter Standort.';
  end if;
  select * into v_card from public.tt_fuel_cards where id = p_card and active;
  if not found then
    raise exception 'Diese Tankkarte gibt es nicht (mehr).';
  end if;
  select coalesce(nullif(full_name, ''), 'Admin') into v_admin from public.tt_profiles where id = auth.uid();

  -- Zuerst die bisherige Ausgabe beenden (Person oder Standort)
  if (v_card.holder_id is not null or v_card.holder_name <> '') and (v_card.holder_id is distinct from p_profile or v_place is not null or (v_card.holder_id is null and p_profile is null)) then
    if not (v_card.holder_id is null and v_place is not null and v_card.holder_name = v_place) then
      insert into public.tt_fuel_card_log (card_id, card_number, profile_id, profile_name, action, by_name)
      values (v_card.id, v_card.number, v_card.holder_id, v_card.holder_name, 'zurück', v_admin);
    end if;
  end if;

  -- An einen Standort (Heidelberg) statt an eine Person
  if v_place is not null then
    if v_card.holder_id is null and v_card.holder_name = v_place then
      return v_card;
    end if;
    update public.tt_fuel_cards
       set holder_id = null, holder_name = v_place, assigned_at = now(), assigned_by = v_admin
     where id = p_card returning * into v_card;
    insert into public.tt_fuel_card_log (created_at, card_id, card_number, profile_id, profile_name, action, by_name)
    values (clock_timestamp(), v_card.id, v_card.number, null, v_place, 'ausgegeben', v_admin);
    return v_card;
  end if;

  if p_profile is null then
    update public.tt_fuel_cards set holder_id = null, holder_name = '', assigned_at = null, assigned_by = ''
     where id = p_card returning * into v_card;
    return v_card;
  end if;

  if v_card.holder_id = p_profile then
    return v_card;
  end if;
  select * into v_person from public.tt_profiles where id = p_profile and active;
  if not found then
    raise exception 'Diese Person hat kein freigeschaltetes Konto.';
  end if;
  update public.tt_fuel_cards
     set holder_id = v_person.id, holder_name = coalesce(nullif(v_person.full_name, ''), 'Unbekannt'),
         assigned_at = now(), assigned_by = v_admin
   where id = p_card returning * into v_card;
  insert into public.tt_fuel_card_log (created_at, card_id, card_number, profile_id, profile_name, action, by_name)
  values (clock_timestamp(), v_card.id, v_card.number, v_person.id, v_card.holder_name, 'ausgegeben', v_admin);
  return v_card;
end;
$$;
revoke execute on function public.tt_fuel_card_set(uuid, uuid, text) from public, anon;
grant execute on function public.tt_fuel_card_set(uuid, uuid, text) to authenticated;

-- ---------- Belege: ausgedruckt? ----------
-- Druckt ein Dolmetscher seine Belege selbst (Sammel-PDF), markiert er sie als „ausgedruckt“ – die Einsatzleitung sieht in der
-- Abrechnung, was schon gedruckt ist und was noch nicht, und druckt nichts doppelt. Das Büro kann es ebenfalls markieren.
alter table public.tt_receipts add column if not exists printed_at timestamptz;
alter table public.tt_receipts add column if not exists printed_by text not null default '';

create or replace function public.tt_receipts_printed(p_ids uuid[], p_done boolean default true) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
  v_count integer;
begin
  if not public.tt_is_member() then
    raise exception 'Dein Konto ist noch nicht freigeschaltet.';
  end if;
  select coalesce(nullif(full_name, ''), 'Unbekannt') into v_name from public.tt_profiles where id = auth.uid();
  update public.tt_receipts
     set printed_at = case when p_done then coalesce(printed_at, now()) else null end,
         printed_by = case when p_done then coalesce(nullif(printed_by, ''), v_name) else '' end
   where id = any(p_ids) and (public.tt_is_staff() or profile_id = auth.uid());
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke execute on function public.tt_receipts_printed(uuid[], boolean) from public, anon;
grant execute on function public.tt_receipts_printed(uuid[], boolean) to authenticated;
