-- Update 43: Zusätzliche Arbeitstage in der Abrechnung.
-- Ein Arbeitstag zählt bisher nur, wenn im Tagesplan ein beendeter Termin steht. Jetzt kann die Einsatzleitung einzelne Tage
-- (mit Datum und Vermerk) von Hand hinzufügen, und die Dolmetscher können einen fehlenden Tag melden – nach der Bestätigung
-- durch die Einsatzleitung zählt er wie ein normaler Arbeitstag (× Tagessatz).
--   • tt_extra_days: eine Zeile je Person und Tag. status: bestätigt (zählt), gemeldet (wartet), abgelehnt.
--     Dolmetscher legen nur „gemeldet“ für sich selbst an und dürfen eine gemeldete Zeile wieder zurückziehen (löschen).
--   • tt_my_month (Update 27) zählt bestätigte Zusatztage mit und liefert gemeldete/abgelehnte zur Anzeige („extra“).
-- Kann beliebig oft ausgeführt werden.

create table if not exists public.tt_extra_days (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  date date not null,
  month text not null default '',
  profile_id uuid references public.tt_profiles (id) on delete set null,
  person_name text not null default '',
  note text not null default '',
  source text not null default 'büro' check (source in ('büro', 'dolmetscher')),
  status text not null default 'bestätigt' check (status in ('bestätigt', 'gemeldet', 'abgelehnt')),
  created_by text not null default '',
  decided_at timestamptz,
  decided_by text not null default '',
  office_note text not null default ''
);
create index if not exists tt_extra_days_month_idx on public.tt_extra_days (month);
create index if not exists tt_extra_days_profile_idx on public.tt_extra_days (profile_id, date);
alter table public.tt_extra_days enable row level security;
revoke all on public.tt_extra_days from anon, authenticated;
grant select, insert, update, delete on public.tt_extra_days to authenticated;

-- Wer anlegt, steht fest: Dolmetscher nur für sich selbst und nur als „gemeldet“; das Büro trägt bestätigte Tage ein.
create or replace function public.tt_extra_day_stamp() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
begin
  select coalesce(nullif(full_name, ''), 'Unbekannt') into v_name from public.tt_profiles where id = (select auth.uid());
  new.created_at := now();
  new.month := to_char(new.date, 'YYYY-MM');
  new.created_by := coalesce(v_name, '');
  new.note := left(coalesce(new.note, ''), 300);
  if not public.tt_is_staff() then
    new.profile_id := (select auth.uid());
    new.person_name := coalesce(v_name, '');
    new.source := 'dolmetscher';
    new.status := 'gemeldet';
    new.decided_at := null; new.decided_by := ''; new.office_note := '';
  else
    if new.profile_id is not null and btrim(coalesce(new.person_name, '')) = '' then
      select coalesce(full_name, '') into new.person_name from public.tt_profiles where id = new.profile_id;
    end if;
    if btrim(coalesce(new.person_name, '')) = '' then
      raise exception 'Bitte den Namen der Person angeben.';
    end if;
    if new.source is null then new.source := 'büro'; end if;
    if new.status is null then new.status := 'bestätigt'; end if;
    if new.status <> 'gemeldet' then new.decided_at := now(); new.decided_by := coalesce(v_name, ''); end if;
  end if;
  if exists (select 1 from public.tt_extra_days e where e.date = new.date
               and ((e.profile_id is not null and e.profile_id = new.profile_id)
                    or lower(regexp_replace(btrim(e.person_name), '\s+', ' ', 'g')) = lower(regexp_replace(btrim(new.person_name), '\s+', ' ', 'g')))) then
    raise exception 'Für diesen Tag gibt es schon einen Eintrag.';
  end if;
  return new;
end;
$$;
drop trigger if exists tt_extra_day_stamp on public.tt_extra_days;
create trigger tt_extra_day_stamp before insert on public.tt_extra_days for each row execute function public.tt_extra_day_stamp();

-- Entscheidet das Büro (bestätigt / abgelehnt), wird festgehalten, wer und wann.
create or replace function public.tt_extra_day_keep() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.id := old.id; new.created_at := old.created_at; new.created_by := old.created_by; new.source := old.source;
  new.month := to_char(new.date, 'YYYY-MM');
  if new.status is distinct from old.status then
    if new.status = 'gemeldet' then new.decided_at := null; new.decided_by := '';
    else
      new.decided_at := now();
      select coalesce(nullif(full_name, ''), 'Unbekannt') into new.decided_by from public.tt_profiles where id = (select auth.uid());
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists tt_extra_day_keep on public.tt_extra_days;
create trigger tt_extra_day_keep before update on public.tt_extra_days for each row execute function public.tt_extra_day_keep();

drop policy if exists tt_extra_days_select on public.tt_extra_days;
create policy tt_extra_days_select on public.tt_extra_days for select to authenticated
  using (public.tt_is_staff() or profile_id = (select auth.uid()));
drop policy if exists tt_extra_days_insert on public.tt_extra_days;
create policy tt_extra_days_insert on public.tt_extra_days for insert to authenticated
  with check (public.tt_is_staff() or public.tt_is_member());
drop policy if exists tt_extra_days_update on public.tt_extra_days;
create policy tt_extra_days_update on public.tt_extra_days for update to authenticated
  using (public.tt_is_staff()) with check (public.tt_is_staff());
drop policy if exists tt_extra_days_delete on public.tt_extra_days;
create policy tt_extra_days_delete on public.tt_extra_days for delete to authenticated
  using (public.tt_is_staff() or (profile_id = (select auth.uid()) and status = 'gemeldet'));

-- „Meine Tage“ im Portal: bestätigte Zusatztage zählen mit; gemeldete und abgelehnte werden gezeigt.
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
  v_extra jsonb;
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
  select array_agg(distinct n) into v_names from (
    select lower(regexp_replace(btrim(full_name), '\s+', ' ', 'g')) n from public.tt_profiles where id = v_me
    union
    select lower(regexp_replace(btrim(person_name), '\s+', ' ', 'g')) from public.tt_payroll where profile_id = v_me and month = p_month
  ) s where n <> '';
  select daily_rate into v_rate from public.tt_payroll_months where month = p_month;
  v_rate := coalesce(v_rate, 80);
  select workdays into v_manual from public.tt_payroll where profile_id = v_me and month = p_month and workdays is not null limit 1;

  -- Tage mit beendeten Terminen – und bestätigte Zusatztage (ein Tag zählt nur einmal).
  select coalesce(jsonb_agg(jsonb_build_object('date', t.date, 'jobs', t.jobs) order by t.date), '[]'::jsonb) into v_days from (
    select d.date, jsonb_agg(concat_ws(' · ', nullif(left(coalesce(r ->> 'Termin_Uhrzeit', ''), 5), ''), nullif(btrim(coalesce(r ->> 'Arzt Nr::Name', '')), ''),
                                       nullif(btrim(coalesce(nullif(r ->> 'Arzt Nr::Ort', ''), r ->> 'Ort', '')), '')) order by r ->> 'Termin_Uhrzeit') as jobs
      from public.tt_days d, jsonb_array_elements(d.records) r
     where d.date between v_from and v_to
       and lower(regexp_replace(btrim(coalesce(r ->> 'Übersetzer', '')), '\s+', ' ', 'g')) = any (v_names)
       and lower(btrim(coalesce(r ->> 'Status', ''))) = 'beendet'
     group by d.date
    union all
    select e.date, jsonb_build_array(concat('Zusätzlicher Tag – vom Büro bestätigt', case when e.note <> '' then ' · ' || e.note else '' end))
      from public.tt_extra_days e
     where e.date between v_from and v_to and e.status = 'bestätigt'
       and (e.profile_id = v_me or lower(regexp_replace(btrim(e.person_name), '\s+', ' ', 'g')) = any (v_names))
       and not exists (select 1 from public.tt_days d2, jsonb_array_elements(d2.records) r2 where d2.date = e.date
                         and lower(regexp_replace(btrim(coalesce(r2 ->> 'Übersetzer', '')), '\s+', ' ', 'g')) = any (v_names)
                         and lower(btrim(coalesce(r2 ->> 'Status', ''))) = 'beendet')
  ) t;

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

  -- Gemeldete und abgelehnte Zusatztage – zur Anzeige im Portal (mit Vermerk des Büros).
  select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'date', e.date, 'status', e.status, 'note', e.note, 'office_note', e.office_note) order by e.date), '[]'::jsonb) into v_extra
    from public.tt_extra_days e
   where e.date between v_from and v_to and e.status <> 'bestätigt'
     and (e.profile_id = v_me or lower(regexp_replace(btrim(e.person_name), '\s+', ' ', 'g')) = any (v_names));

  return jsonb_build_object('month', p_month, 'rate', v_rate, 'days', v_days, 'special', v_special, 'workdays', v_manual, 'extra', v_extra);
end;
$$;
revoke execute on function public.tt_my_month(text) from public, anon;
grant execute on function public.tt_my_month(text) to authenticated;
