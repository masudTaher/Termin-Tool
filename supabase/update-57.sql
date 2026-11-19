-- Update 57 (R93): Stammfahrzeug – bevorzugt, aber nicht reserviert.
-- Jeder Festangestellte bekommt ein Auto zugeordnet, das in seiner App ganz oben steht („Dein Stammfahrzeug“) und das er
-- mit einem Tipp wieder übernimmt, wenn er selbst der letzte Fahrer war (Schnellübernahme aus R91). Anders als
-- „Reserviert für“ (assigned_to) dürfen andere Dolmetscher das Auto weiterhin übernehmen.

alter table public.tt_vehicles add column if not exists preferred_driver uuid references public.tt_profiles(id) on delete set null;
create index if not exists tt_vehicles_preferred_driver_idx on public.tt_vehicles (preferred_driver) where preferred_driver is not null;

comment on column public.tt_vehicles.preferred_driver is 'Update 57: Stammfahrer – bei dieser Person steht das Auto in der App ganz oben und lässt sich mit einem Tipp übernehmen; nicht reserviert (andere dürfen es nehmen)';

notify pgrst, 'reload schema';
