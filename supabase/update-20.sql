-- Update 20: „Termin fällt aus“ (Stornierung durch den Dolmetscher, mit Grund).
-- Der Dolmetscher meldet im Portal, dass ein Termin nicht stattfindet (Patient nicht erschienen, Praxis hat abgesagt …).
-- Der Auftrag ist damit abgeschlossen – auch wenn er schon losgefahren war – und im Live-Tracking steht der Termin
-- von selbst auf „Storniert“. Zurücknehmen bleibt möglich. Kann beliebig oft ausgeführt werden.
alter table public.tt_assignments add column if not exists storno_at timestamptz;                    -- wann der Dolmetscher storniert hat
alter table public.tt_assignments add column if not exists storno_note text not null default '';      -- Grund

-- p_undo = true nimmt die Stornierung zurück. Antwort: Status und Zeiten.
create or replace function public.tt_assignment_storno(p_id uuid, p_note text default '', p_undo boolean default false)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.tt_assignments;
  v_ts timestamptz := now();
  v_note text := btrim(coalesce(p_note, ''));
begin
  if not public.tt_is_member() then
    raise exception 'Dein Konto ist noch nicht freigeschaltet.';
  end if;
  select * into v_job from public.tt_assignments where id = p_id and interpreter_id = auth.uid() and not cancelled;
  if not found then
    raise exception 'Dieser Auftrag ist nicht (mehr) für dich bestimmt.';
  end if;

  if coalesce(p_undo, false) then
    if v_job.storno_at is not null then
      -- War der Auftrag durch die Stornierung beendet worden, läuft er wieder; ein vorher gemeldetes „Fertig“ bleibt.
      update public.tt_assignments
         set finished_at = case when finished_at = storno_at then null else finished_at end,
             work_status = case when finished_at is not null and finished_at <> storno_at then 'beendet'
                                when started_at is not null then 'losgefahren' else 'offen' end,
             storno_at = null, storno_note = ''
       where id = p_id returning * into v_job;
    end if;
  else
    if char_length(v_note) < 3 then
      raise exception 'Bitte schreib kurz, warum der Termin ausfällt.';
    end if;
    if v_job.response = 'abgesagt' then
      raise exception 'Du hast diesen Auftrag abgesagt – er muss nicht storniert werden.';
    end if;
    if v_job.finished_at is not null and v_job.storno_at is null then
      raise exception 'Dieser Auftrag ist bereits beendet.';
    end if;
    update public.tt_assignments
       set storno_at = coalesce(storno_at, v_ts), storno_note = left(v_note, 300), work_status = 'storniert',
           finished_at = case when started_at is not null then coalesce(finished_at, v_ts) else finished_at end,
           reminded_at = null, reminder_count = 0
     where id = p_id returning * into v_job;
  end if;

  return jsonb_build_object('status', v_job.work_status, 'storno_at', v_job.storno_at, 'storno_note', v_job.storno_note,
                            'started_at', v_job.started_at, 'finished_at', v_job.finished_at);
end;
$$;
revoke execute on function public.tt_assignment_storno(uuid, text, boolean) from public, anon;
grant execute on function public.tt_assignment_storno(uuid, text, boolean) to authenticated;
