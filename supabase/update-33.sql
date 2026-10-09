-- Update 33: Nachweis über zurückgezogene Aufträge.
-- Wird ein Auftrag zurückgezogen – oder geht der Termin an jemand anderen –, bleibt das als Nachweis stehen:
-- welcher Auftrag (Tag, Uhrzeit, Arzt/Ort), bei wem, wann zurückgezogen, von wem, und was bis dahin geantwortet war.
-- Bisher ging dieser Nachweis verloren, sobald derselbe Termin neu vergeben wurde (je Termin gibt es nur eine Auftragszeile).
--   • Die Datenbank schreibt den Nachweis selbst (Auslöser an tt_assignments) – unabhängig davon, von welcher Seite zurückgezogen wird.
--   • Der Dolmetscher sieht seine eigenen Einträge im Archiv der App, das Büro alle. Ändern kann sie niemand; löschen nur der Admin.
--   • „Rückgängig“ gleich nach dem Zurückziehen nimmt auch den Nachweis wieder heraus (innerhalb von 10 Minuten).
--   • Im Nachweis stehen keine Patientendaten – nur das, was auch in der Zeile des Auftrags steht.
-- Kann beliebig oft ausgeführt werden.

create table if not exists public.tt_withdrawals (
  id uuid primary key default gen_random_uuid(),
  withdrawn_at timestamptz not null default now(),
  withdrawn_by text not null default '',
  reason text not null default 'zurückgezogen' check (reason in ('zurückgezogen', 'neu vergeben', 'gelöscht')),
  assignment_id uuid,
  appointment_id uuid,
  interpreter_id uuid not null references public.tt_profiles (id) on delete cascade,
  interpreter_name text not null default '',
  date date not null,
  time text not null default '',
  title text not null default '',
  response text not null default 'offen',
  responded_at timestamptz,
  started_at timestamptz,
  sent_at timestamptz,
  sent_by text not null default '',
  new_interpreter_name text not null default '',
  work_status text not null default '',        -- Stand des Termins in dem Moment (z. B. storniert, alleine)
  storno_note text not null default ''
);
alter table public.tt_withdrawals add column if not exists work_status text not null default '';
alter table public.tt_withdrawals add column if not exists storno_note text not null default '';
create index if not exists tt_withdrawals_interpreter_idx on public.tt_withdrawals (interpreter_id, date desc);
alter table public.tt_withdrawals enable row level security;
revoke all on public.tt_withdrawals from anon, authenticated;
grant select, delete on public.tt_withdrawals to authenticated;
drop policy if exists tt_withdrawals_select on public.tt_withdrawals;
create policy tt_withdrawals_select on public.tt_withdrawals for select to authenticated
  using (interpreter_id = (select auth.uid()) or public.tt_is_staff());
drop policy if exists tt_withdrawals_delete on public.tt_withdrawals;
create policy tt_withdrawals_delete on public.tt_withdrawals for delete to authenticated
  using (public.tt_is_admin());

create or replace function public.tt_log_withdrawal() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_by text;
  v_reason text;
  v_new text := '';
begin
  if tg_op = 'UPDATE' then
    -- „Rückgängig“: derselbe Auftrag gilt wieder – der eben geschriebene Nachweis fällt weg.
    if old.cancelled and not new.cancelled and new.interpreter_id = old.interpreter_id then
      delete from public.tt_withdrawals
       where appointment_id = old.appointment_id and interpreter_id = old.interpreter_id
         and reason = 'zurückgezogen' and withdrawn_at > now() - interval '10 minutes';
      return new;
    end if;
    if old.cancelled then
      return new;                                   -- war schon zurückgezogen: der Nachweis steht bereits
    end if;
    if new.cancelled then
      v_reason := 'zurückgezogen';
    elsif new.interpreter_id is distinct from old.interpreter_id then
      v_reason := 'neu vergeben';
      v_new := coalesce(new.interpreter_name, '');
    else
      return new;
    end if;
  else                                              -- DELETE
    if old.cancelled then
      return old;
    end if;
    v_reason := 'gelöscht';
  end if;
  select full_name into v_by from public.tt_profiles where id = (select auth.uid());
  -- Wird ein Konto gelöscht, verschwinden seine Aufträge mit ihm – dann gibt es niemanden mehr, für den der Nachweis wäre.
  if exists (select 1 from public.tt_profiles where id = old.interpreter_id) then
    insert into public.tt_withdrawals (withdrawn_by, reason, assignment_id, appointment_id, interpreter_id, interpreter_name, date, time, title,
                                       response, responded_at, started_at, sent_at, sent_by, new_interpreter_name, work_status, storno_note)
    values (coalesce(v_by, ''), v_reason, old.id, old.appointment_id, old.interpreter_id, old.interpreter_name, old.date, old.time, old.title,
            old.response, old.responded_at, old.started_at, old.sent_at, old.sent_by, v_new, coalesce(old.work_status, ''), coalesce(old.storno_note, ''));
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
drop trigger if exists tt_log_withdrawal on public.tt_assignments;
create trigger tt_log_withdrawal after update or delete on public.tt_assignments
  for each row execute function public.tt_log_withdrawal();
