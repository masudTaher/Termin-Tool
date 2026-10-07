-- Update 24: Gemeldete Termine nachträglich korrigieren – auch wenn das Büro sie schon eingetragen hat –
-- und den Terminzettel nachreichen. Die Meldung wandert dann wieder unter „Neu“, mit dem Vermerk, was sich
-- geändert hat (alter Wert → neuer Wert), damit das Büro FileMaker anpassen kann. Kann beliebig oft ausgeführt werden.
alter table public.tt_new_appointments add column if not exists correction jsonb;   -- { at, note, before: { feld: alter Wert }, entered_at, entered_by }

-- Eine Meldung, die schon einmal eingetragen war, darf der Dolmetscher nicht mehr selbst löschen.
drop policy if exists tt_new_appointments_delete_own on public.tt_new_appointments;
create policy tt_new_appointments_delete_own on public.tt_new_appointments for delete to authenticated
  using (public.tt_is_member() and reporter_id = (select auth.uid()) and status = 'neu' and correction is null);

create or replace function public.tt_appointment_correct(p_id uuid, p_fields jsonb, p_note text default '')
returns public.tt_new_appointments
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.tt_new_appointments;
  v_new public.tt_new_appointments;
  v_allowed jsonb;
  v_before jsonb;
  v_note text := left(btrim(coalesce(p_note, '')), 300);
  v_entered boolean;
begin
  if not public.tt_is_member() then
    raise exception 'Dein Konto ist nicht freigeschaltet.';
  end if;
  select * into v_row from public.tt_new_appointments where id = p_id for update;
  if v_row.id is null or v_row.reporter_id is distinct from (select auth.uid()) then
    raise exception 'Diese Meldung gehört nicht zu dir.';
  end if;
  -- Nur diese Angaben lassen sich ändern.
  select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) into v_allowed
    from jsonb_each(coalesce(p_fields, '{}'::jsonb)) e
   where e.key = any (array['patient_nr', 'patient_name', 'date', 'time', 'place', 'city', 'doctor', 'description', 'payer', 'file_path', 'no_slip']);
  v_new := jsonb_populate_record(v_row, v_allowed);
  if v_new.date is null then
    raise exception 'Bitte gib das Datum des Termins an.';
  end if;
  if v_new.file_path is not null and v_new.file_path is distinct from v_row.file_path
     and split_part(v_new.file_path, '/', 1) <> (select auth.uid())::text then
    raise exception 'Der Terminzettel muss in deinem eigenen Ordner liegen.';
  end if;
  -- Was hat sich geändert? (alter Wert je Feld)
  select coalesce(jsonb_object_agg(e.key, to_jsonb(v_row) -> e.key), '{}'::jsonb) into v_before
    from jsonb_each(to_jsonb(v_new)) e
   where v_allowed ? e.key and (to_jsonb(v_row) -> e.key) is distinct from e.value;
  if v_before = '{}'::jsonb and v_note = '' then
    return v_row;
  end if;
  v_entered := v_row.status = 'eingetragen';
  update public.tt_new_appointments set
    patient_nr = btrim(v_new.patient_nr), patient_name = btrim(v_new.patient_name), date = v_new.date, time = v_new.time,
    place = btrim(v_new.place), city = btrim(v_new.city), doctor = btrim(v_new.doctor), description = btrim(v_new.description),
    payer = v_new.payer, file_path = v_new.file_path, no_slip = coalesce(v_new.no_slip, false) and v_new.file_path is null,
    status = 'neu', handled_at = null, handled_by = '',
    correction = case
      -- Das Büro hatte den Termin eingetragen: Vermerk neu beginnen (FileMaker kennt den Stand von eben).
      when v_entered then jsonb_build_object('at', now(), 'note', v_note, 'before', v_before,
                                             'entered_at', v_row.handled_at, 'entered_by', v_row.handled_by)
      -- Schon wieder offen und noch nicht neu eingetragen: Die ältesten „alten Werte“ bleiben gültig.
      when v_row.correction is not null then v_row.correction
           || jsonb_build_object('at', now(), 'note', case when v_note <> '' then v_note else coalesce(v_row.correction ->> 'note', '') end,
                                 'before', v_before || coalesce(v_row.correction -> 'before', '{}'::jsonb))
      else null
    end
  where id = p_id
  returning * into v_row;
  return v_row;
end;
$$;
revoke execute on function public.tt_appointment_correct(uuid, jsonb, text) from public, anon;
grant execute on function public.tt_appointment_correct(uuid, jsonb, text) to authenticated;
