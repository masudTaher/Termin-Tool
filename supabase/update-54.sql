-- Update 54 (R86): Kontrolle – Nachverfolgung fehlender Berichte, Unterlagen und nicht zurückgegebener Fahrzeuge.
-- Die neue Seite „Kontrolle“ zeigt der Einsatzleitung, wer in einem Termin war und keinen Bericht geschrieben hat, bei
-- welchem Termin keine Unterlagen (Arztbericht, Rezept, Überweisung) hochgeladen wurden und wer sein Fahrzeug nach
-- Dienstschluss nicht zurückgegeben hat. Was das Büro dazu unternimmt, steht hier:
--   • tt_followups: ein Eintrag je Vorgang (kind = bericht / unterlagen / fahrzeug, ref_id = Auftrag bzw. Übernahme):
--     erinnert (wann, wie oft), entschuldigt (mit Grund) oder erledigt. Ohne Eintrag gilt der Vorgang als offen.
--   • Nur Einsatzleitung und Sekretariat lesen und schreiben die Tabelle; Dolmetscher sehen nur die Nachricht, die
--     beim Erinnern in ihren Chat geht (tt_messages) – wie bisher.
-- Kann beliebig oft ausgeführt werden.

create table if not exists public.tt_followups (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  kind text not null check (kind in ('bericht', 'unterlagen', 'fahrzeug')),
  ref_id uuid not null,                                   -- tt_assignments.id (bericht, unterlagen) oder tt_handovers.id (fahrzeug)
  profile_id uuid references public.tt_profiles (id) on delete set null,
  profile_name text not null default '',
  status text not null default 'offen' check (status in ('offen', 'erinnert', 'entschuldigt', 'erledigt')),
  reminded_at timestamptz,
  reminded_count integer not null default 0,
  note text not null default '',                          -- Grund bei „entschuldigt“ oder Bemerkung des Büros
  resolved_at timestamptz,
  resolved_by text not null default '',
  updated_at timestamptz not null default now(),
  unique (kind, ref_id)
);
create index if not exists tt_followups_profile_idx on public.tt_followups (profile_id, created_at desc);
alter table public.tt_followups enable row level security;
revoke all on public.tt_followups from anon, authenticated;
grant select, insert, update, delete on public.tt_followups to authenticated;
drop policy if exists tt_followups_staff on public.tt_followups;
create policy tt_followups_staff on public.tt_followups for all to authenticated
  using (public.tt_is_staff()) with check (public.tt_is_staff());

comment on table public.tt_followups is 'Update 54: Nachverfolgung der Einsatzleitung – fehlende Berichte/Unterlagen je Auftrag, nicht zurückgegebene Fahrzeuge je Übernahme';
