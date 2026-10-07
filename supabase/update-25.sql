-- Update 25: Dolmetscher dürfen ihren eigenen Bericht auch dann noch bearbeiten, wenn das Büro ihn schon geprüft
-- oder weitergeleitet hat. Der Bericht steht danach wieder auf „neu“ – das Büro sieht, dass er geändert wurde.
-- Kann beliebig oft ausgeführt werden.
alter table public.tt_documents add column if not exists edited_at timestamptz;   -- zuletzt vom Dolmetscher geändert

drop policy if exists tt_documents_update_own on public.tt_documents;
create policy tt_documents_update_own on public.tt_documents for update to authenticated
  using (public.tt_is_member() and uploader_id = (select auth.uid()) and (status = 'neu' or kind = 'Dolmetscherbericht'))
  with check (uploader_id = (select auth.uid()) and status = 'neu');
