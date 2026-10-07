-- Update 22: Bemerkung und Anhang (PDF) zu einem Auftrag.
-- Die Einsatzleitung schreibt beim Senden eines Auftrags eine Bemerkung für den Dolmetscher („CD mitnehmen“,
-- „Bericht mitbringen“ …) und kann eine PDF-Datei anhängen. Kann beliebig oft ausgeführt werden.
alter table public.tt_assignments add column if not exists office_note text not null default '';        -- Bemerkung der Einsatzleitung
alter table public.tt_assignments add column if not exists attachment_path text;                        -- Datei im Speicher "dokumente" (Ordner auftraege/)
alter table public.tt_assignments add column if not exists attachment_name text not null default '';    -- Dateiname für die Anzeige

-- Speicher: Die Einsatzleitung darf Anhänge hochladen; lesen darf sie der Dolmetscher, dem der Auftrag gerade gehört.
drop policy if exists dokumente_insert_staff on storage.objects;
create policy dokumente_insert_staff on storage.objects for insert to authenticated
  with check (bucket_id = 'dokumente' and public.tt_is_staff());
drop policy if exists dokumente_select_auftrag on storage.objects;
create policy dokumente_select_auftrag on storage.objects for select to authenticated
  using (
    bucket_id = 'dokumente' and public.tt_is_member()
    and exists (
      select 1 from public.tt_assignments a
       where a.attachment_path = storage.objects.name and a.interpreter_id = (select auth.uid()) and not a.cancelled
    )
  );
