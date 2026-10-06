-- Update 17: Geburtsdatum des Patienten bei Unterlagen und Berichten (für die Suche in den Patientenakten).
-- Kann beliebig oft ausgeführt werden.
alter table public.tt_documents add column if not exists patient_birth text not null default '';
