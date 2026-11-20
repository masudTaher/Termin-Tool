-- Update 59 (R97): Tankkarte zurückmelden.
-- Ein Dolmetscher meldet in der App, dass er seine Tankkarte abgegeben hat (im Büro, an der Pforte, an einen Kollegen).
-- Das geht als Chat-Nachricht mit kind = 'tankkarte' an die Einsatzleitung: Sie erscheint beim Start im Pop-up „Was wartet“,
-- und der Admin nimmt die Karte dort mit einem Klick von seinem Namen (tt_fuel_card_set).
-- Kann beliebig oft ausgeführt werden.

alter table public.tt_chat drop constraint if exists tt_chat_kind_check;
alter table public.tt_chat add constraint tt_chat_kind_check check (kind in ('', 'hilfe', 'korrektur', 'tankkarte'));
alter table public.tt_chat add column if not exists ref_id uuid;      -- z. B. die Tankkarte, um die es geht
comment on column public.tt_chat.ref_id is 'Update 59: Bezug der Nachricht (bei kind tankkarte: id der Tankkarte)';

notify pgrst, 'reload schema';
