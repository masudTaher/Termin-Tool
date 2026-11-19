-- Update 56 (R91): Standort Düsseldorf – wie Heidelberg.
-- Die Kollegen in Düsseldorf haben eigene Fahrzeuge und Tankkarten. Sie stehen im Fuhrpark unter „Düsseldorf“ und
-- erscheinen den Dolmetschern in Bonn nicht zur Übernahme (die Auswahl-Regel aus Update 47 zeigt nur station = 'Bonn').
-- Tankkarten lassen sich seit Update 47 an jeden Namen ausgeben – „Düsseldorf“ braucht dafür nichts Neues.

alter table public.tt_vehicles drop constraint if exists tt_vehicles_station_check;
alter table public.tt_vehicles add constraint tt_vehicles_station_check check (station in ('Bonn', 'Heidelberg', 'Düsseldorf'));

comment on column public.tt_vehicles.station is 'Standort: Bonn (Standard), Heidelberg oder Düsseldorf (Update 41/56) – nur Bonner Fahrzeuge werden in der App übernommen';

notify pgrst, 'reload schema';
