-- Medical Office Bonn · Transport und Dolmetscher · Update 14
-- „Foto neu anfordern“: Die Einsatzleitung bittet eine Dolmetscherin oder einen Dolmetscher um ein neues Foto
-- (Schaden, Meldung, Unterlage, Beleg). Die Person sieht im Portal das alte Foto mit dem Hinweis und nimmt ein neues auf.
-- Im Supabase-Menü "SQL Editor" einfügen und mit "Run" ausführen. Kann erneut ausgeführt werden.
-- Voraussetzung: schema.sql sowie update-2 bis update-13 wurden bereits ausgeführt.

create table if not exists public.tt_requests (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by uuid references public.tt_profiles (id) on delete set null,
  created_by_name text not null default '',
  profile_id uuid not null references public.tt_profiles (id) on delete cascade,     -- an wen die Bitte geht
  profile_name text not null default '',
  kind text not null check (kind in ('schaden', 'meldung', 'unterlage', 'beleg')),
  ref_id uuid not null,                         -- Schaden, Meldung, Unterlage oder Beleg, um den es geht
  title text not null default '',               -- z. B. „Schaden · Stoßstange hinten · 0 140-300“
  message text not null default '',             -- „Das Foto ist unscharf. Bitte nimm ein neues auf.“
  photo_bucket text not null default 'schaeden' check (photo_bucket in ('schaeden', 'dokumente')),
  photo_paths text[] not null default '{}',     -- die bisherigen Fotos bzw. das bisherige PDF (zur Ansicht)
  context jsonb not null default '{}'::jsonb,   -- Angaben zum Vorausfüllen (Patient, Arzt, Datum, Art der Unterlage …)
  status text not null default 'offen' check (status in ('offen', 'erledigt', 'zurückgezogen')),
  answer_note text not null default '',
  answer_paths text[] not null default '{}',
  answer_ref uuid,                              -- bei Unterlagen: die neu gesendete Unterlage
  answered_at timestamptz,
  seen_at timestamptz                           -- die Einsatzleitung hat die Antwort gesehen
);
create index if not exists tt_requests_profile_idx on public.tt_requests (profile_id, status);
create index if not exists tt_requests_ref_idx on public.tt_requests (ref_id);

alter table public.tt_requests enable row level security;
revoke all on public.tt_requests from anon;
grant select, insert, update, delete on public.tt_requests to authenticated;

drop policy if exists tt_requests_select on public.tt_requests;
create policy tt_requests_select on public.tt_requests for select to authenticated
  using (public.tt_is_staff() or (public.tt_is_member() and profile_id = (select auth.uid())));
drop policy if exists tt_requests_staff_insert on public.tt_requests;
create policy tt_requests_staff_insert on public.tt_requests for insert to authenticated
  with check (public.tt_is_staff() and created_by = (select auth.uid()));
drop policy if exists tt_requests_staff_update on public.tt_requests;
create policy tt_requests_staff_update on public.tt_requests for update to authenticated
  using (public.tt_is_staff()) with check (public.tt_is_staff());
drop policy if exists tt_requests_staff_delete on public.tt_requests;
create policy tt_requests_staff_delete on public.tt_requests for delete to authenticated
  using (public.tt_is_staff());

-- Unterlagen: Wurde eine Unterlage neu fotografiert, zeigt die alte auf die neue.
alter table public.tt_documents add column if not exists replaced_by uuid references public.tt_documents (id) on delete set null;

-- Die Person antwortet: neue Fotos (p_paths) bzw. die neu gesendete Unterlage (p_new_ref).
-- Die Fotos landen direkt beim Schaden, bei der Meldung oder beim Beleg.
create or replace function public.tt_request_answer(p_id uuid, p_paths text[] default '{}', p_note text default '', p_new_ref uuid default null)
returns public.tt_requests
language plpgsql security definer set search_path = '' as $$
declare
  v_request public.tt_requests;
  v_paths text[] := coalesce(array(select path from unnest(coalesce(p_paths, '{}')) as path where coalesce(path, '') <> ''), '{}');
begin
  if not public.tt_is_member() then
    raise exception 'Dein Konto ist noch nicht freigeschaltet.';
  end if;
  select * into v_request from public.tt_requests where id = p_id and profile_id = auth.uid();
  if not found then
    raise exception 'Diese Bitte gibt es nicht (mehr).';
  end if;
  if v_request.status <> 'offen' then
    raise exception 'Diese Bitte ist bereits erledigt.';
  end if;

  if v_request.kind = 'unterlage' then
    if p_new_ref is null or not exists (select 1 from public.tt_documents where id = p_new_ref and uploader_id = auth.uid()) then
      raise exception 'Bitte sende zuerst die neu fotografierte Unterlage.';
    end if;
    update public.tt_documents set replaced_by = p_new_ref where id = v_request.ref_id;
  else
    if cardinality(v_paths) = 0 then
      raise exception 'Bitte nimm zuerst ein neues Foto auf.';
    end if;
    if exists (select 1 from unnest(v_paths) as path where path not like auth.uid()::text || '/%') then
      raise exception 'Die Fotos müssen aus deinem eigenen Ordner stammen.';
    end if;
    if v_request.kind = 'schaden' then
      update public.tt_damages set photo_paths = v_paths || photo_paths where id = v_request.ref_id;     -- neue Fotos zuerst
    elsif v_request.kind = 'meldung' then
      update public.tt_alerts set photo_path = v_paths[1] where id = v_request.ref_id;
    elsif v_request.kind = 'beleg' then
      update public.tt_receipts set photo_path = v_paths[1] where id = v_request.ref_id;
    end if;
  end if;

  update public.tt_requests
     set status = 'erledigt', answered_at = now(), answer_paths = v_paths, answer_ref = p_new_ref,
         answer_note = left(coalesce(p_note, ''), 500), seen_at = null
   where id = p_id returning * into v_request;
  return v_request;
end;
$$;
revoke execute on function public.tt_request_answer(uuid, text[], text, uuid) from public, anon;
grant execute on function public.tt_request_answer(uuid, text[], text, uuid) to authenticated;
