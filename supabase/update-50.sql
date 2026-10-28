-- Update 50 (R77): Meldung über den Vorfahrer ohne Zuordnung archivieren.
-- Ist ein gemeldeter Schaden alt (war schon vorher da) oder weist der Vorfahrer nach, dass er es nicht war,
-- nimmt die Einsatzleitung die Meldung aus seiner Fahrerakte heraus. Sie bleibt mit Fotos in der
-- „Schadenakte – ohne Zuordnung“ des Fahrzeugs erhalten. Zurückholen ist jederzeit möglich.
-- Im SQL-Editor von Supabase einfügen und „Run“ drücken.

alter table public.tt_driver_notes
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by text not null default '',
  add column if not exists archive_reason text not null default '',   -- 'alt' = alter Schaden · 'entlastet' = Fahrer hat es nachweislich nicht verursacht · 'sonstiges'
  add column if not exists archive_note text not null default '';

alter table public.tt_driver_notes drop constraint if exists tt_driver_notes_archive_reason_check;
alter table public.tt_driver_notes add constraint tt_driver_notes_archive_reason_check
  check (archive_reason in ('', 'alt', 'entlastet', 'sonstiges'));

create index if not exists tt_driver_notes_archived_idx on public.tt_driver_notes (vehicle_id, archived_at desc) where archived_at is not null;

comment on column public.tt_driver_notes.archived_at is 'Update 50: ohne Zuordnung archiviert – zählt nicht mehr für den Fahrer, bleibt in der Schadenakte des Fahrzeugs';
