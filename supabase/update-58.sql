-- Update 58 (R96): Stellungnahme des Fahrers zu einer Meldung – und Entscheidung der Einsatzleitung.
-- Wird ein Schaden (oder „nicht sauber“, „Tank leer“) über den Vorfahrer gemeldet, bekommt er die Meldung in der App.
-- Neu: Er kann antworten (Text und Fotos) – seine Stellungnahme steht bei der Meldung. In seine Akte „zählt“ die Meldung
-- erst, wenn die Einsatzleitung sie bestätigt (decision = 'bestaetigt'); verwirft sie sie, zählt sie nicht.
-- Der Fahrer darf nur: „gesehen“ setzen und – solange nicht entschieden – seine Stellungnahme schreiben/ändern.
-- Kann beliebig oft ausgeführt werden.

alter table public.tt_driver_notes add column if not exists reply text not null default '';
alter table public.tt_driver_notes add column if not exists reply_at timestamptz;
alter table public.tt_driver_notes add column if not exists reply_photo_paths jsonb not null default '[]'::jsonb;
alter table public.tt_driver_notes add column if not exists decision text not null default '';
alter table public.tt_driver_notes drop constraint if exists tt_driver_notes_decision_check;
alter table public.tt_driver_notes add constraint tt_driver_notes_decision_check check (decision in ('', 'bestaetigt', 'verworfen'));
alter table public.tt_driver_notes add column if not exists decided_at timestamptz;
alter table public.tt_driver_notes add column if not exists decided_by text not null default '';
alter table public.tt_driver_notes add column if not exists decision_note text not null default '';

comment on column public.tt_driver_notes.reply is 'Update 58: Stellungnahme des Fahrers (Text)';
comment on column public.tt_driver_notes.reply_photo_paths is 'Update 58: Fotos zur Stellungnahme (Bucket schaeden, Ordner des Fahrers)';
comment on column public.tt_driver_notes.decision is 'Update 58: Entscheidung der Einsatzleitung – leer = offen, bestaetigt = zählt in der Fahrerakte, verworfen = zählt nicht';

-- Der Fahrer darf „gesehen“ setzen und – solange nicht entschieden und nicht archiviert – seine Stellungnahme schreiben.
-- Eine neue Stellungnahme setzt die Meldung im Büro wieder auf „neu“ (office_seen_at leer), damit sie dort auffällt.
create or replace function public.tt_driver_note_keep() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_reply text;
  v_photos jsonb;
begin
  if not public.tt_is_staff() then
    v_reply := left(coalesce(new.reply, ''), 2000);
    v_photos := case when jsonb_typeof(new.reply_photo_paths) = 'array' then new.reply_photo_paths else '[]'::jsonb end;
    new := old;
    new.seen_at := coalesce(old.seen_at, now());
    if old.driver_id = (select auth.uid()) and coalesce(old.decision, '') = '' and old.archived_at is null
       and (v_reply is distinct from coalesce(old.reply, '') or v_photos is distinct from coalesce(old.reply_photo_paths, '[]'::jsonb)) then
      new.reply := v_reply;
      new.reply_photo_paths := v_photos;
      new.reply_at := now();
      new.office_seen_at := null;
      new.office_seen_by := '';
    end if;
  else
    if coalesce(new.decision, '') <> coalesce(old.decision, '') then
      new.decided_at := case when coalesce(new.decision, '') = '' then null else now() end;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists tt_driver_note_keep on public.tt_driver_notes;
create trigger tt_driver_note_keep before update on public.tt_driver_notes for each row execute function public.tt_driver_note_keep();

-- Fotos der Stellungnahme liegen im Ordner des Fahrers – das Büro sieht sie über schaeden_select (Mitglieder).

notify pgrst, 'reload schema';
