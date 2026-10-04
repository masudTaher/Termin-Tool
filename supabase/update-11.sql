-- Medical Office Bonn · Transport und Dolmetscher · Update 11
-- 1) Schäden: Schadensart (Kratzer, Schramme, Unfall …). Dolmetscher müssen mindestens ein Foto mitschicken.
-- 2) Fehlerhafte Schäden und Meldungen löscht nur der Admin. Einsatzleitung und Sekretariat
--    tragen weiterhin ein und bearbeiten (Altschaden, in Reparatur, repariert, erledigt).
-- 3) Überstunden werden auf volle 10 Minuten aufgerundet (1 Std 13 Min → 1 Std 20 Min).
-- Im Supabase-Menü "SQL Editor" einfügen und mit "Run" ausführen. Kann erneut ausgeführt werden.
-- Voraussetzung: schema.sql sowie update-2 bis update-10 wurden bereits ausgeführt.

-- ---------------------------------------------------------------------------
-- 1 Schadensart und Pflichtfoto
-- ---------------------------------------------------------------------------
alter table public.tt_damages add column if not exists category text not null default '';

-- Dolmetscher: nur für das übernommene Fahrzeug und nur mit Foto.
-- Einsatzleitung und Sekretariat dürfen auch Altschäden ohne Foto nachtragen.
drop policy if exists tt_damages_insert on public.tt_damages;
create policy tt_damages_insert on public.tt_damages for insert to authenticated
  with check (
    public.tt_is_member() and reporter_id = (select auth.uid())
    and (
      public.tt_is_staff()
      or (public.tt_holds_vehicle(vehicle_id) and cardinality(photo_paths) >= 1)
    )
  );

-- ---------------------------------------------------------------------------
-- 2 Löschen nur durch den Admin
-- ---------------------------------------------------------------------------
drop policy if exists tt_damages_admin on public.tt_damages;
drop policy if exists tt_damages_staff_insert on public.tt_damages;
create policy tt_damages_staff_insert on public.tt_damages for insert to authenticated
  with check (public.tt_is_staff());
drop policy if exists tt_damages_staff_update on public.tt_damages;
create policy tt_damages_staff_update on public.tt_damages for update to authenticated
  using (public.tt_is_staff()) with check (public.tt_is_staff());
drop policy if exists tt_damages_admin_delete on public.tt_damages;
create policy tt_damages_admin_delete on public.tt_damages for delete to authenticated
  using (public.tt_is_admin());

drop policy if exists tt_alerts_admin on public.tt_alerts;
drop policy if exists tt_alerts_staff_insert on public.tt_alerts;
create policy tt_alerts_staff_insert on public.tt_alerts for insert to authenticated
  with check (public.tt_is_staff());
drop policy if exists tt_alerts_staff_update on public.tt_alerts;
create policy tt_alerts_staff_update on public.tt_alerts for update to authenticated
  using (public.tt_is_staff()) with check (public.tt_is_staff());
drop policy if exists tt_alerts_admin_delete on public.tt_alerts;
create policy tt_alerts_admin_delete on public.tt_alerts for delete to authenticated
  using (public.tt_is_admin());

-- ---------------------------------------------------------------------------
-- 3 Überstunden: auf volle 10 Minuten aufrunden
-- ---------------------------------------------------------------------------
-- Gilt für neue und geänderte Einträge; bereits gespeicherte Überstunden bleiben, wie sie sind.
create or replace function public.tt_overtime_minutes() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_start time := '09:00';
  v_end time := '16:00';
  v_setting jsonb;
begin
  select value into v_setting from public.tt_settings where key = 'arbeitszeit';
  if v_setting ? 'start' then v_start := (v_setting ->> 'start')::time; end if;
  if v_setting ? 'ende' then v_end := (v_setting ->> 'ende')::time; end if;
  new.minutes_before := case when new.start_time is not null and new.start_time < v_start
    then (ceil(extract(epoch from (v_start - new.start_time)) / 600.0) * 10)::integer else 0 end;
  new.minutes_after := case when new.end_time is not null and new.end_time > v_end
    then (ceil(extract(epoch from (new.end_time - v_end)) / 600.0) * 10)::integer else 0 end;
  if new.minutes_before + new.minutes_after <= 0 then
    raise exception 'Keine Überstunden: Die Zeiten liegen innerhalb der Arbeitszeit (% bis % Uhr).', to_char(v_start, 'HH24:MI'), to_char(v_end, 'HH24:MI');
  end if;
  return new;
end;
$$;
