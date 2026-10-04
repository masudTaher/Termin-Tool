-- Botschaft Dolmetscher und Transport-App · Update 8
-- Nachrichten an Dolmetscher, Überstunden für Festangestellte, Mitteilungen aufs Handy,
-- Passwort vergessen, Speicheranzeige und gemeinsame Stammdaten (Dolmetscherliste, Filterregeln).
-- Im Supabase-Menü "SQL Editor" einfügen und mit "Run" ausführen. Kann erneut ausgeführt werden.
-- Voraussetzung: schema.sql sowie update-2 bis update-7 wurden bereits ausgeführt.

-- ---------------------------------------------------------------------------
-- 1 Gemeinsame Stammdaten: Dolmetscherliste und Filterregeln für Einsatzleitung und Sekretariat
-- ---------------------------------------------------------------------------
create table if not exists public.tt_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text not null default ''
);
alter table public.tt_settings enable row level security;
revoke all on public.tt_settings from anon;
grant select, insert, update, delete on public.tt_settings to authenticated;
drop policy if exists tt_settings_staff on public.tt_settings;
create policy tt_settings_staff on public.tt_settings for all to authenticated
  using (public.tt_is_staff()) with check (public.tt_is_staff());

-- ---------------------------------------------------------------------------
-- 2 Nachrichten der Einsatzleitung an alle oder an einzelne Dolmetscher
-- ---------------------------------------------------------------------------
create or replace function public.tt_my_employment() returns text
language sql stable security definer set search_path = '' as $$
  select employment from public.tt_profiles where id = (select auth.uid()) and active;
$$;
grant execute on function public.tt_my_employment() to authenticated;

create table if not exists public.tt_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid references public.tt_profiles (id) on delete set null,
  sender_name text not null default '',
  audience text not null default 'alle' check (audience in ('alle', 'fest', 'temporär', 'einzeln')),
  recipient_ids uuid[] not null default '{}',                  -- nur bei "einzeln"
  body text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index if not exists tt_messages_created_idx on public.tt_messages (created_at desc);
alter table public.tt_messages enable row level security;
revoke all on public.tt_messages from anon;
grant select, insert, update, delete on public.tt_messages to authenticated;

drop policy if exists tt_messages_select on public.tt_messages;
create policy tt_messages_select on public.tt_messages for select to authenticated
  using (
    public.tt_is_staff()
    or (public.tt_is_member() and (
      audience = 'alle'
      or (audience in ('fest', 'temporär') and audience = public.tt_my_employment())
      or (select auth.uid()) = any (recipient_ids)
    ))
  );
drop policy if exists tt_messages_staff on public.tt_messages;
create policy tt_messages_staff on public.tt_messages for all to authenticated
  using (public.tt_is_staff()) with check (public.tt_is_staff());

-- Wer hat welche Nachricht gelesen?
create table if not exists public.tt_message_reads (
  message_id uuid not null references public.tt_messages (id) on delete cascade,
  profile_id uuid not null references public.tt_profiles (id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (message_id, profile_id)
);
alter table public.tt_message_reads enable row level security;
revoke all on public.tt_message_reads from anon;
grant select, insert, delete on public.tt_message_reads to authenticated;
drop policy if exists tt_message_reads_select on public.tt_message_reads;
create policy tt_message_reads_select on public.tt_message_reads for select to authenticated
  using (profile_id = (select auth.uid()) or public.tt_is_staff());
drop policy if exists tt_message_reads_insert on public.tt_message_reads;
create policy tt_message_reads_insert on public.tt_message_reads for insert to authenticated
  with check (public.tt_is_member() and profile_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 3 Überstunden der Festangestellten (Arbeitszeit 9–16 Uhr), verknüpft mit dem Termin
-- ---------------------------------------------------------------------------
create table if not exists public.tt_overtime (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.tt_profiles (id) on delete cascade,
  person_name text not null default '',
  date date not null,
  start_time time,                                              -- Beginn, wenn vor der Arbeitszeit
  end_time time,                                                -- Ende, wenn nach der Arbeitszeit
  minutes_before integer not null default 0,
  minutes_after integer not null default 0,
  assignment_id uuid references public.tt_assignments (id) on delete set null,
  appointment text not null default '',                         -- Termin, wegen dem länger gearbeitet wurde
  note text not null default '',
  status text not null default 'eingereicht' check (status in ('eingereicht', 'bestätigt', 'abgelehnt')),
  review_note text not null default '',
  reviewed_by text not null default '',
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists tt_overtime_date_idx on public.tt_overtime (date);
create index if not exists tt_overtime_profile_idx on public.tt_overtime (profile_id, date);

-- Die Minuten rechnet die Datenbank selbst aus – so stimmen sie immer mit den Uhrzeiten überein.
-- Die Arbeitszeit lässt sich in tt_settings unter "arbeitszeit" ändern: {"start":"09:00","ende":"16:00"}.
create or replace function public.tt_overtime_minutes() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_start time := '09:00';
  v_end time := '16:00';
  v_setting jsonb;
begin
  select value into v_setting from public.tt_settings where key = 'arbeitszeit';
  if v_setting ? 'start' then v_start := (v_setting ->> 'start')::time; end if;
  if v_setting ? 'ende' then v_end := (v_setting ->> 'ende')::time; end if;
  new.minutes_before := case when new.start_time is not null and new.start_time < v_start
    then (extract(epoch from (v_start - new.start_time)) / 60)::integer else 0 end;
  new.minutes_after := case when new.end_time is not null and new.end_time > v_end
    then (extract(epoch from (new.end_time - v_end)) / 60)::integer else 0 end;
  if new.minutes_before + new.minutes_after <= 0 then
    raise exception 'Keine Überstunden: Die Zeiten liegen innerhalb der Arbeitszeit (% bis % Uhr).', to_char(v_start, 'HH24:MI'), to_char(v_end, 'HH24:MI');
  end if;
  return new;
end;
$$;
drop trigger if exists tt_overtime_minutes on public.tt_overtime;
create trigger tt_overtime_minutes before insert or update of start_time, end_time on public.tt_overtime
  for each row execute function public.tt_overtime_minutes();

alter table public.tt_overtime enable row level security;
revoke all on public.tt_overtime from anon;
grant select, insert, update, delete on public.tt_overtime to authenticated;
drop policy if exists tt_overtime_select_own on public.tt_overtime;
create policy tt_overtime_select_own on public.tt_overtime for select to authenticated
  using (public.tt_is_member() and profile_id = (select auth.uid()));
drop policy if exists tt_overtime_insert_own on public.tt_overtime;
create policy tt_overtime_insert_own on public.tt_overtime for insert to authenticated
  with check (public.tt_is_member() and profile_id = (select auth.uid()) and status = 'eingereicht' and date <= current_date + 1);
drop policy if exists tt_overtime_delete_own on public.tt_overtime;
create policy tt_overtime_delete_own on public.tt_overtime for delete to authenticated
  using (profile_id = (select auth.uid()) and status = 'eingereicht');
drop policy if exists tt_overtime_staff on public.tt_overtime;
create policy tt_overtime_staff on public.tt_overtime for all to authenticated
  using (public.tt_is_staff()) with check (public.tt_is_staff());

-- ---------------------------------------------------------------------------
-- 4 Mitteilungen aufs Handy (Web-Push)
-- ---------------------------------------------------------------------------
-- Jedes Handy, auf dem "Mitteilungen einschalten" getippt wurde, steht hier.
create table if not exists public.tt_push_subscriptions (
  endpoint text primary key,
  profile_id uuid not null references public.tt_profiles (id) on delete cascade,
  p256dh text not null,
  auth text not null,
  user_agent text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists tt_push_subscriptions_profile_idx on public.tt_push_subscriptions (profile_id);
alter table public.tt_push_subscriptions enable row level security;
revoke all on public.tt_push_subscriptions from anon;
grant select, insert, update, delete on public.tt_push_subscriptions to authenticated;
drop policy if exists tt_push_subscriptions_own on public.tt_push_subscriptions;
create policy tt_push_subscriptions_own on public.tt_push_subscriptions for all to authenticated
  using (profile_id = (select auth.uid())) with check (public.tt_is_member() and profile_id = (select auth.uid()));

-- Schlüssel für den Versand. Die Tabelle ist für niemanden lesbar – nur die Funktion "tt-push"
-- (läuft mit Sonderrechten auf dem Server) legt den Schlüssel einmal an und benutzt ihn.
create table if not exists public.tt_push_config (
  id integer primary key default 1 check (id = 1),
  public_key text not null,
  private_key text not null,
  created_at timestamptz not null default now()
);
alter table public.tt_push_config enable row level security;
revoke all on public.tt_push_config from anon, authenticated;

-- Merkt sich, wann an die Rückgabe erinnert wurde (höchstens einmal pro Tag).
alter table public.tt_handovers add column if not exists reminded_at timestamptz;

-- ---------------------------------------------------------------------------
-- 5 Passwort vergessen: Die Person meldet sich, der Admin vergibt ein neues Passwort
-- ---------------------------------------------------------------------------
alter table public.tt_profiles add column if not exists must_change_password boolean not null default false;

create table if not exists public.tt_reset_requests (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.tt_profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  done_at timestamptz,
  done_by text not null default ''
);
alter table public.tt_reset_requests enable row level security;
revoke all on public.tt_reset_requests from anon;
grant select, update, delete on public.tt_reset_requests to authenticated;
drop policy if exists tt_reset_requests_admin on public.tt_reset_requests;
create policy tt_reset_requests_admin on public.tt_reset_requests for all to authenticated
  using (public.tt_is_admin()) with check (public.tt_is_admin());

-- Aufrufbar ohne Anmeldung. Antwortet immer gleich, damit niemand herausfinden kann, welche E-Mail ein Konto hat.
create or replace function public.tt_request_password_reset(p_email text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  select u.id into v_id from auth.users u
    join public.tt_profiles p on p.id = u.id
   where lower(u.email) = lower(trim(p_email)) limit 1;
  if v_id is null then
    return;
  end if;
  if exists (select 1 from public.tt_reset_requests where profile_id = v_id and done_at is null) then
    return;
  end if;
  insert into public.tt_reset_requests (profile_id) values (v_id);
end;
$$;
revoke execute on function public.tt_request_password_reset(text) from public;
grant execute on function public.tt_request_password_reset(text) to anon, authenticated;

-- Nach dem Setzen eines eigenen Passworts verschwindet der Hinweis "Passwort ändern".
create or replace function public.tt_password_changed() returns void
language sql security definer set search_path = '' as $$
  update public.tt_profiles set must_change_password = false where id = (select auth.uid());
$$;
revoke execute on function public.tt_password_changed() from public, anon;
grant execute on function public.tt_password_changed() to authenticated;

-- ---------------------------------------------------------------------------
-- 6 Speicheranzeige: Wie viel Platz belegen Datenbank und Fotos?
-- ---------------------------------------------------------------------------
create or replace function public.tt_usage() returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when public.tt_is_staff() then jsonb_build_object(
    'database_bytes', pg_database_size(current_database()),
    'storage_bytes', coalesce((select sum(coalesce((o.metadata ->> 'size')::bigint, 0)) from storage.objects o where o.bucket_id = 'schaeden'), 0),
    'photos', (select count(*) from storage.objects o where o.bucket_id = 'schaeden')
  ) else null end;
$$;
revoke execute on function public.tt_usage() from public, anon;
grant execute on function public.tt_usage() to authenticated;
