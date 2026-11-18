-- Update 55 (R88): Bericht für eine Begleitperson
-- Ein Dolmetscherbericht kann für eine Begleitperson des Patienten sein (Ehefrau, Mutter, Kind …), die unter der
-- Aktennummer des Hauptpatienten mitläuft. Der Dolmetscher gibt das beim Schreiben an; das Büro sieht
-- „Bericht für Begleitperson: Name“ in der Akte, in der Liste und auf dem PDF.
-- Der Name steht in der Bemerkung des Termins; die App erkennt ihn und fragt beim Berichtschreiben nach.

alter table public.tt_documents add column if not exists companion_name text not null default '';

comment on column public.tt_documents.companion_name is 'Update 55: Name der Begleitperson, wenn die Unterlage/der Bericht nicht für den Hauptpatienten selbst ist (leer = Patient selbst)';

notify pgrst, 'reload schema';
