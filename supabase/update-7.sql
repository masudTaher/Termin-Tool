-- Botschaft Dolmetscher und Transport-App · Update 7: Schäden nur mit übernommenem Fahrzeug
-- Dolmetscher können Schäden und Meldungen nur noch für das Fahrzeug eintragen,
-- das sie gerade übernommen haben. Einsatzleitung und Sekretariat dürfen weiterhin alles.
-- Im Supabase-Menü "SQL Editor" einfügen und mit "Run" ausführen. Kann erneut ausgeführt werden.
-- Voraussetzung: schema.sql sowie update-2 bis update-6 wurden bereits ausgeführt.

-- Hat die angemeldete Person dieses Fahrzeug gerade übernommen (noch nicht zurückgegeben)?
create or replace function public.tt_holds_vehicle(p_vehicle uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.tt_handovers
    where vehicle_id = p_vehicle and driver_id = (select auth.uid()) and end_time is null
  );
$$;
grant execute on function public.tt_holds_vehicle(uuid) to authenticated;

drop policy if exists tt_damages_insert on public.tt_damages;
create policy tt_damages_insert on public.tt_damages for insert to authenticated
  with check (
    public.tt_is_member() and reporter_id = (select auth.uid())
    and (public.tt_is_staff() or public.tt_holds_vehicle(vehicle_id))
  );

drop policy if exists tt_alerts_insert on public.tt_alerts;
create policy tt_alerts_insert on public.tt_alerts for insert to authenticated
  with check (
    public.tt_is_member() and reporter_id = (select auth.uid())
    and (public.tt_is_staff() or public.tt_holds_vehicle(vehicle_id))
  );
