-- Update 27: „Meine Tage“ im Dolmetscher-Portal. Jeder Dolmetscher sieht jederzeit seine eigene Monatsübersicht:
-- die Arbeitstage (jeder Tag mit einem beendeten Termin zählt von selbst – ohne Bestätigung), die Termine je Tag
-- (Uhrzeit, Arzt, Ort – keine Patientendaten), Sondertage mit Betrag und den Tagessatz.
-- Die Funktion liefert nur die eigenen Angaben der angemeldeten Person. Kann beliebig oft ausgeführt werden.
create or replace function public.tt_my_month(p_month text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_me uuid := (select auth.uid());
  v_from date;
  v_to date;
  v_names text[];
  v_rate numeric := 80;
  v_days jsonb;
  v_special jsonb;
  v_manual integer;
begin
  if not public.tt_is_member() then
    raise exception 'Dein Konto ist nicht freigeschaltet.';
  end if;
  if p_month !~ '^\d{4}-\d{2}$' then
    raise exception 'Unbekannter Monat.';
  end if;
  v_from := (p_month || '-01')::date;
  v_to := (v_from + interval '1 month' - interval '1 day')::date;
  -- Unter diesen Namen steht die Person im Tagesplan: Name des Kontos und – falls verknüpft – der Name in der Abrechnung.
  select array_agg(distinct n) into v_names from (
    select lower(regexp_replace(btrim(full_name), '\s+', ' ', 'g')) n from public.tt_profiles where id = v_me
    union
    select lower(regexp_replace(btrim(person_name), '\s+', ' ', 'g')) from public.tt_payroll where profile_id = v_me and month = p_month
  ) s where n <> '';
  select daily_rate into v_rate from public.tt_payroll_months where month = p_month;
  v_rate := coalesce(v_rate, 80);
  -- Hat das Büro die Zahl der Arbeitstage von Hand eingetragen, gilt diese.
  select workdays into v_manual from public.tt_payroll where profile_id = v_me and month = p_month and workdays is not null limit 1;

  select coalesce(jsonb_agg(jsonb_build_object('date', t.date, 'jobs', t.jobs) order by t.date), '[]'::jsonb) into v_days from (
    select d.date, jsonb_agg(concat_ws(' · ', nullif(left(coalesce(r ->> 'Termin_Uhrzeit', ''), 5), ''), nullif(btrim(coalesce(r ->> 'Arzt Nr::Name', '')), ''),
                                       nullif(btrim(coalesce(nullif(r ->> 'Arzt Nr::Ort', ''), r ->> 'Ort', '')), '')) order by r ->> 'Termin_Uhrzeit') as jobs
      from public.tt_days d, jsonb_array_elements(d.records) r
     where d.date between v_from and v_to
       and lower(regexp_replace(btrim(coalesce(r ->> 'Übersetzer', '')), '\s+', ' ', 'g')) = any (v_names)
       and lower(btrim(coalesce(r ->> 'Status', ''))) = 'beendet'
     group by d.date
  ) t;

  -- Sondertage: von Hand eingetragene (zählt = Ja) haben Vorrang vor dem Sonderbetrag eines Termins.
  select coalesce(jsonb_agg(jsonb_build_object('date', x.date, 'amount', x.amount) order by x.date), '[]'::jsonb) into v_special from (
    select distinct on (date) date, amount from (
      select s.date, s.amount::numeric as amount, 0 as rank from public.tt_special_days s
       where s.date between v_from and v_to and s.counts = 'Ja' and lower(regexp_replace(btrim(s.person_name), '\s+', ' ', 'g')) = any (v_names)
      union all
      select d.date, max((r ->> 'Sonderbetrag')::numeric), 1 from public.tt_days d, jsonb_array_elements(d.records) r
       where d.date between v_from and v_to
         and lower(regexp_replace(btrim(coalesce(r ->> 'Übersetzer', '')), '\s+', ' ', 'g')) = any (v_names)
         and lower(btrim(coalesce(r ->> 'Status', ''))) <> 'storniert'
         and coalesce(r ->> 'Sonderbetrag', '') ~ '^\d+(\.\d+)?$' and (r ->> 'Sonderbetrag')::numeric > 0
         and not exists (select 1 from public.tt_special_days m where m.date = d.date and lower(regexp_replace(btrim(m.person_name), '\s+', ' ', 'g')) = any (v_names))
       group by d.date
    ) u order by date, rank
  ) x;

  return jsonb_build_object('month', p_month, 'rate', v_rate, 'days', v_days, 'special', v_special, 'workdays', v_manual);
end;
$$;
revoke execute on function public.tt_my_month(text) from public, anon;
grant execute on function public.tt_my_month(text) to authenticated;
