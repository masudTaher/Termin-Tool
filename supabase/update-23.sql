-- Update 23: Frühere Unterlagen zum Patienten – zur Vorbereitung auf einen zugesagten Auftrag.
-- Wer einen Auftrag zugesagt hat (oder „unter Vorbehalt“), sieht im Portal die archivierten Unterlagen zu genau diesem
-- Patienten: Arztberichte, Rezepte, Überweisungen und die Dolmetscherberichte der Kolleginnen und Kollegen.
--   • nur für den Dolmetscher, dem der Auftrag gerade gehört (nicht zurückgezogen, nicht abgesagt, nicht ausgefallen)
--   • nur rund um den Termin: ab der Zusage, frühestens 14 Tage vorher, bis einen Tag nach dem Termin
--   • nur Unterlagen mit derselben Aktennummer wie im Auftrag
--   • jeder Abruf wird festgehalten (wer, wann, zu welchem Auftrag) – sichtbar nur für die Einsatzleitung
-- Kann beliebig oft ausgeführt werden.

-- Aktennummer aus dem Auftragstext („*Aktennummer: 12345*“). Den Text schreibt nur die Einsatzleitung.
create or replace function public.tt_message_patient_nr(p_message text) returns text
language sql immutable set search_path = '' as $$
  select coalesce(nullif(btrim((regexp_match(coalesce(p_message, ''), 'Aktennummer:\s*([^*\r\n]+)'))[1]), ''), '');
$$;
revoke execute on function public.tt_message_patient_nr(text) from public, anon;
grant execute on function public.tt_message_patient_nr(text) to authenticated;

-- Gilt der Auftrag (noch) als „zugesagt und aktuell“ für die angemeldete Person?
create or replace function public.tt_assignment_gives_history(p_job public.tt_assignments) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.tt_is_member()
     and p_job.interpreter_id = (select auth.uid())
     and not p_job.cancelled
     and p_job.response in ('zugesagt', 'vorbehalt')
     and p_job.storno_at is null
     and coalesce(p_job.work_status, '') not in ('storniert')
     and p_job.date between current_date - 1 and current_date + 14;
$$;
revoke execute on function public.tt_assignment_gives_history(public.tt_assignments) from public, anon;
grant execute on function public.tt_assignment_gives_history(public.tt_assignments) to authenticated;

-- Protokoll der Abrufe: je Person, Auftrag und Tag eine Zeile.
create table if not exists public.tt_document_access (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  day date not null default current_date,
  viewer_id uuid references public.tt_profiles (id) on delete set null,
  viewer_name text not null default '',
  assignment_id uuid references public.tt_assignments (id) on delete set null,
  patient_nr text not null default '',
  documents integer not null default 0
);
create unique index if not exists tt_document_access_once_idx on public.tt_document_access (viewer_id, assignment_id, day);
create index if not exists tt_document_access_patient_idx on public.tt_document_access (patient_nr, at desc);
alter table public.tt_document_access enable row level security;
revoke all on public.tt_document_access from anon, authenticated;
grant select on public.tt_document_access to authenticated;
drop policy if exists tt_document_access_staff on public.tt_document_access;
create policy tt_document_access_staff on public.tt_document_access for select to authenticated
  using (public.tt_is_staff());

-- Die Liste für das Portal.
create or replace function public.tt_patient_history(p_assignment uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.tt_assignments;
  v_nr text;
  v_docs jsonb;
  v_name text;
begin
  if not public.tt_is_member() then
    raise exception 'Dein Konto ist nicht freigeschaltet.';
  end if;
  select * into v_job from public.tt_assignments where id = p_assignment;
  if v_job.id is null or v_job.interpreter_id <> (select auth.uid()) or v_job.cancelled then
    raise exception 'Dieser Auftrag ist nicht (mehr) für dich bestimmt.';
  end if;
  if not public.tt_assignment_gives_history(v_job) then
    return jsonb_build_object('allowed', false, 'patient_nr', '', 'documents', '[]'::jsonb);
  end if;
  v_nr := public.tt_message_patient_nr(v_job.message);
  if v_nr = '' then
    return jsonb_build_object('allowed', true, 'patient_nr', '', 'documents', '[]'::jsonb);
  end if;
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.sort_day desc, t.created_at desc), '[]'::jsonb) into v_docs
    from (
      select d.id, d.created_at, d.date, coalesce(d.date, d.created_at::date) as sort_day, d.doctor, d.kind, d.note, d.body, d.pages,
             d.file_path, d.uploader_name, d.status, (d.uploader_id = (select auth.uid())) as mine
        from public.tt_documents d
       where lower(btrim(d.patient_nr)) = lower(v_nr) and d.replaced_by is null
       order by coalesce(d.date, d.created_at::date) desc, d.created_at desc
       limit 40
    ) t;
  select full_name into v_name from public.tt_profiles where id = (select auth.uid());
  insert into public.tt_document_access (viewer_id, viewer_name, assignment_id, patient_nr, documents)
  values ((select auth.uid()), coalesce(v_name, ''), v_job.id, v_nr, jsonb_array_length(v_docs))
  on conflict (viewer_id, assignment_id, day) do update set at = now(), documents = excluded.documents;
  return jsonb_build_object('allowed', true, 'patient_nr', v_nr, 'documents', v_docs);
end;
$$;
revoke execute on function public.tt_patient_history(uuid) from public, anon;
grant execute on function public.tt_patient_history(uuid) to authenticated;

-- Speicher: Die Datei einer solchen Unterlage darf öffnen, wer gerade einen passenden zugesagten Auftrag hat.
create or replace function public.tt_can_read_patient_file(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
      from public.tt_documents d
      join public.tt_assignments a on a.interpreter_id = (select auth.uid())
     where d.file_path = p_name and d.replaced_by is null and btrim(d.patient_nr) <> ''
       and public.tt_assignment_gives_history(a)
       and lower(btrim(d.patient_nr)) = lower(public.tt_message_patient_nr(a.message))
  );
$$;
revoke execute on function public.tt_can_read_patient_file(text) from public, anon;
grant execute on function public.tt_can_read_patient_file(text) to authenticated;

drop policy if exists dokumente_select_patient on storage.objects;
create policy dokumente_select_patient on storage.objects for select to authenticated
  using (bucket_id = 'dokumente' and public.tt_can_read_patient_file(name));
