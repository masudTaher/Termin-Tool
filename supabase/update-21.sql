-- Update 21: Chat zwischen Einsatzleitung und Dolmetschern (wie ein Messenger).
-- Je Dolmetscher gibt es ein Gespräch (thread_id = sein Konto). Einsatzleitung und Sekretariat schreiben gemeinsam
-- hinein, der Dolmetscher antwortet. „Gelesen“ wird in beide Richtungen vermerkt. Kann beliebig oft ausgeführt werden.
create table if not exists public.tt_chat (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  thread_id uuid not null references public.tt_profiles (id) on delete cascade,   -- Gespräch mit diesem Dolmetscher
  sender_id uuid references public.tt_profiles (id) on delete set null,
  sender_name text not null default '',
  from_staff boolean not null default false,                                     -- true: von Einsatzleitung/Sekretariat
  body text not null check (char_length(body) between 1 and 2000),
  read_at timestamptz,                                                            -- wann die andere Seite es gesehen hat
  read_by text not null default '',
  edited_at timestamptz
);
create index if not exists tt_chat_thread_idx on public.tt_chat (thread_id, created_at desc);
create index if not exists tt_chat_unread_idx on public.tt_chat (from_staff, thread_id) where read_at is null;

alter table public.tt_chat enable row level security;
revoke all on public.tt_chat from anon;
grant select, insert, update, delete on public.tt_chat to authenticated;

-- Lesen: Einsatzleitung alles, der Dolmetscher nur sein eigenes Gespräch.
drop policy if exists tt_chat_select on public.tt_chat;
create policy tt_chat_select on public.tt_chat for select to authenticated
  using (public.tt_is_staff() or (public.tt_is_member() and thread_id = (select auth.uid())));
-- Schreiben: jeder nur unter eigenem Namen; der Dolmetscher nur in sein eigenes Gespräch.
drop policy if exists tt_chat_insert on public.tt_chat;
create policy tt_chat_insert on public.tt_chat for insert to authenticated
  with check (
    sender_id = (select auth.uid()) and read_at is null and (
      (public.tt_is_staff() and from_staff)
      or (public.tt_is_member() and not public.tt_is_staff() and not from_staff and thread_id = (select auth.uid()))
    )
  );
-- Korrigieren: nur die Einsatzleitung (das „Gelesen“ setzt die Funktion unten).
drop policy if exists tt_chat_update on public.tt_chat;
create policy tt_chat_update on public.tt_chat for update to authenticated
  using (public.tt_is_staff()) with check (public.tt_is_staff());
-- Löschen: die Einsatzleitung alles, der Dolmetscher seine eigenen Nachrichten.
drop policy if exists tt_chat_delete on public.tt_chat;
create policy tt_chat_delete on public.tt_chat for delete to authenticated
  using (public.tt_is_staff() or (public.tt_is_member() and thread_id = (select auth.uid()) and sender_id = (select auth.uid()) and not from_staff));

-- „Gelesen“ setzen: Die Einsatzleitung für die Nachrichten des Dolmetschers in einem Gespräch (p_thread),
-- der Dolmetscher für die Nachrichten der Einsatzleitung in seinem eigenen Gespräch. Antwort: Anzahl.
create or replace function public.tt_chat_read(p_thread uuid default null)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer := 0;
  v_name text;
begin
  if not public.tt_is_member() then
    return 0;
  end if;
  select coalesce(full_name, '') into v_name from public.tt_profiles where id = auth.uid();
  if public.tt_is_staff() then
    if p_thread is null then
      return 0;
    end if;
    update public.tt_chat set read_at = now(), read_by = v_name
     where thread_id = p_thread and not from_staff and read_at is null;
  else
    update public.tt_chat set read_at = now(), read_by = v_name
     where thread_id = auth.uid() and from_staff and read_at is null;
  end if;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke execute on function public.tt_chat_read(uuid) from public, anon;
grant execute on function public.tt_chat_read(uuid) to authenticated;
