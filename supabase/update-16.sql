-- Medical Office Bonn · Transport und Dolmetscher · Update 16
-- Antwort auf einen Auftrag zurücknehmen und Hinweise ohne Antwort senden.
--   Bisher konnte ein Dolmetscher nur zwischen Zusage, Unter Vorbehalt und Absage wechseln. Hat er sich vertippt,
--   kann er die Antwort jetzt ganz zurücknehmen (der Auftrag steht dann wieder auf „Antwort offen“) – solange er
--   noch nicht losgefahren ist. Außerdem kann er der Einsatzleitung einen Hinweis schicken, ohne schon zu antworten.
-- Im Supabase-Menü "SQL Editor" einfügen und mit "Run" ausführen. Kann erneut ausgeführt werden.
-- Voraussetzung: schema.sql sowie update-2 bis update-15 wurden bereits ausgeführt.

create or replace function public.tt_respond_assignment(p_id uuid, p_response text, p_note text default '')
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.tt_assignments;
begin
  if p_response not in ('zugesagt', 'vorbehalt', 'abgesagt', 'offen') then
    raise exception 'Unbekannte Antwort.';
  end if;
  select * into v_job from public.tt_assignments where id = p_id and interpreter_id = auth.uid() and not cancelled;
  if not found then
    raise exception 'Dieser Auftrag ist nicht (mehr) für dich bestimmt.';
  end if;
  if p_response = 'offen' then
    -- Antwort zurücknehmen (oder nur einen Hinweis schicken, solange noch nicht geantwortet wurde).
    if v_job.response <> 'offen' and (v_job.started_at is not null or v_job.finished_at is not null) then
      raise exception 'Der Auftrag läuft schon oder ist beendet – die Antwort lässt sich nicht mehr zurücknehmen.';
    end if;
    update public.tt_assignments
       set response = 'offen', response_note = left(coalesce(p_note, ''), 300), responded_at = null
     where id = p_id;
  else
    update public.tt_assignments
       set response = p_response, response_note = left(coalesce(p_note, ''), 300), responded_at = now()
     where id = p_id;
  end if;
end;
$$;

revoke execute on function public.tt_respond_assignment(uuid, text, text) from public, anon;
grant execute on function public.tt_respond_assignment(uuid, text, text) to authenticated;
