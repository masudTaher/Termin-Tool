-- Update 32: Die Akte bleibt im Archiv der Dolmetscher-App offen.
-- Bisher sah ein Dolmetscher die Unterlagen seines Patienten nur rund um den Termin (bis einen Tag danach). Jetzt bleiben sie
-- für seine eigenen früheren Aufträge ohne Frist offen – er kann im Archiv die Akte öffnen: letzte Berichte, Rezepte,
-- Überweisungen, Aktennummer. Unverändert gilt:
--   • nur für den Dolmetscher, dem der Auftrag gehört (zugesagt oder unter Vorbehalt; nicht zurückgezogen, abgesagt oder ausgefallen)
--   • nur Unterlagen mit derselben Aktennummer wie im Auftrag
--   • für kommende Aufträge frühestens 14 Tage vorher
--   • jeder Abruf wird festgehalten (wer, wann, zu welchem Auftrag) – sichtbar nur für die Einsatzleitung
-- Braucht Update 23. Kann beliebig oft ausgeführt werden.

create or replace function public.tt_assignment_gives_history(p_job public.tt_assignments) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.tt_is_member()
     and p_job.interpreter_id = (select auth.uid())
     and not p_job.cancelled
     and p_job.response in ('zugesagt', 'vorbehalt')
     and p_job.storno_at is null
     and coalesce(p_job.work_status, '') not in ('storniert')
     and p_job.date <= current_date + 14;
$$;
revoke execute on function public.tt_assignment_gives_history(public.tt_assignments) from public, anon;
grant execute on function public.tt_assignment_gives_history(public.tt_assignments) to authenticated;
