-- Update 19: „Auto über Nacht behalten“. Wer schon ein Fahrzeug hat, kann es über Nacht behalten:
--   • früher Termin (alle): nur diese Nacht – am nächsten Tag ab 16 Uhr erinnert das Portal wieder an die Rückgabe.
--   • Notdienst / Bereitschaft (nur Festangestellte): bis zur Rückgabe, ohne Erinnerung.
-- Kann beliebig oft ausgeführt werden.
alter table public.tt_handovers add column if not exists keep_until date;                       -- bis zu diesem Tag (früher Termin) darf das Auto bleiben
alter table public.tt_handovers add column if not exists keep_reason text not null default '';   -- '' | 'frueh' | 'notdienst'

-- p_reason: 'frueh' = früher Termin morgen · 'notdienst' = Notdienst/Bereitschaft (nur fest) · '' = doch nicht über Nacht
create or replace function public.tt_keep_vehicle(p_reason text default 'frueh')
returns public.tt_handovers
language plpgsql security definer set search_path = '' as $$
declare
  v_today date := (now() at time zone 'Europe/Berlin')::date;
  v_reason text := lower(btrim(coalesce(p_reason, '')));
  v_profile public.tt_profiles;
  v_row public.tt_handovers;
begin
  if not public.tt_is_member() then
    raise exception 'Dein Konto ist noch nicht freigeschaltet.';
  end if;
  if v_reason not in ('frueh', 'notdienst', '') then
    raise exception 'Unbekannter Grund.';
  end if;
  select * into v_profile from public.tt_profiles where id = auth.uid();
  if v_reason = 'notdienst' and v_profile.employment <> 'fest' then
    raise exception 'Notdienst können nur fest angestellte Dolmetscher eintragen.';
  end if;
  select * into v_row from public.tt_handovers
   where driver_id = auth.uid() and end_time is null
   order by created_at desc limit 1;
  if not found then
    raise exception 'Du hast gerade kein Fahrzeug.';
  end if;
  update public.tt_handovers
     set emergency = (v_reason = 'notdienst'),
         keep_until = case when v_reason = 'frueh' then v_today + 1 else null end,
         keep_reason = v_reason
   where id = v_row.id
  returning * into v_row;
  return v_row;
end;
$$;
revoke execute on function public.tt_keep_vehicle(text) from public, anon;
grant execute on function public.tt_keep_vehicle(text) to authenticated;
