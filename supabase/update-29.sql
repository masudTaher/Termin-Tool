-- Update 29: Papierakte einlesen.
-- Das Büro liest die ganze Papierakte eines Patienten als Scan-Datei ein. Jedes Schriftstück wird ein eigenes PDF in der Akte –
-- mit Überschrift („Arztbericht · Prof. Dr. … · Neurochirurgie“), Fachrichtung und dem Datum des Schriftstücks.
--   • title, specialty        Überschrift und Fachrichtung (zum Ordnen nach Datum, Fachrichtung oder Arzt)
--   • import_id               alle Schriftstücke, die zusammen eingelesen wurden (ein Einlesen lässt sich im Ganzen zurücknehmen)
--   • status 'archiv'         aus der Papierakte: erscheint nur in der Akte – nicht im Eingang „Neue Berichte / Neue Rezepte“
--   • original_path, enhanced_at   „Scan verbessern“: die frühere Datei bleibt erhalten und lässt sich wiederherstellen
--   • Die Dolmetscher sehen beim zugesagten Auftrag die ganze Akte (bis 400 Schriftstücke, mit Überschrift und Fachrichtung).
--   • Suche im Text der Unterlagen läuft in der Datenbank – die Seiten laden nicht mehr den ganzen Text aller Unterlagen.
-- Kann beliebig oft ausgeführt werden.

alter table public.tt_documents add column if not exists title text not null default '';
alter table public.tt_documents add column if not exists specialty text not null default '';
alter table public.tt_documents add column if not exists import_id uuid;
alter table public.tt_documents add column if not exists original_path text;
alter table public.tt_documents add column if not exists enhanced_at timestamptz;

alter table public.tt_documents drop constraint if exists tt_documents_status_check;
alter table public.tt_documents add constraint tt_documents_status_check check (status in ('neu', 'geprüft', 'weitergeleitet', 'archiv'));
create index if not exists tt_documents_import_idx on public.tt_documents (import_id) where import_id is not null;

-- Die Liste für die Dolmetscher-App: wie bisher (nur beim zugesagten Auftrag, rund um den Termin, jeder Abruf wird festgehalten) –
-- jetzt mit Überschrift und Fachrichtung und mit Platz für eine ganze Akte.
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
  -- Neueste zuerst. Ein Schriftstück aus der Papierakte ohne Datum hat keinen Tag (der Tag des Einlesens sagt nichts) – es steht am Ende.
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.sort_day desc nulls last, t.created_at desc), '[]'::jsonb) into v_docs
    from (
      select d.id, d.created_at, d.date, coalesce(d.date, case when d.status = 'archiv' then null else d.created_at::date end) as sort_day,
             d.doctor, d.kind, d.title, d.specialty, d.note, d.body, d.pages,
             d.file_path, d.file_bytes, d.uploader_name, d.status, (d.uploader_id = (select auth.uid())) as mine
        from public.tt_documents d
       where lower(btrim(d.patient_nr)) = lower(v_nr) and d.replaced_by is null
       order by coalesce(d.date, case when d.status = 'archiv' then null else d.created_at::date end) desc nulls last, d.created_at desc
       limit 400
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

-- Suche im erkannten Text der Unterlagen (nur Einsatzleitung und Sekretariat). Antwort: je Treffer Nummer und Name des Patienten.
create or replace function public.tt_document_search(p_query text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when public.tt_is_staff() and char_length(btrim(coalesce(p_query, ''))) >= 3 then
    coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'patient_nr', d.patient_nr, 'patient_name', d.patient_name))
                from (select id, patient_nr, patient_name from public.tt_documents
                       where position(lower(btrim(p_query)) in lower(text_content)) > 0
                       order by created_at desc limit 300) d), '[]'::jsonb)
  else '[]'::jsonb end;
$$;
revoke execute on function public.tt_document_search(text) from public, anon;
grant execute on function public.tt_document_search(text) to authenticated;
