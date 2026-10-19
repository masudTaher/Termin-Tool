-- Update 42: Fahrerakte – Meldungen über den Vorfahrer.
-- Übernimmt jemand ein Fahrzeug und stellt fest, dass es nicht sauber ist, der Tank leer ist oder ein neuer Schaden da ist,
-- geht die Meldung (mit Fotos) sofort an den vorherigen Fahrer und an die Einsatzleitung. Jede Meldung bleibt in der Akte
-- des Vorfahrers stehen (wie viele, wann, was) – die Einsatzleitung sieht sie, hakt sie ab und vermerkt eine Ermahnung.
--   • tt_driver_notes: eine Zeile je Meldung. Wer gemeldet hat und wer der Vorfahrer war, setzt die Datenbank aus der
--     Übergabe (handover_id) – nicht die App. Der Vorfahrer darf nur „gesehen“ setzen; das Büro alles.
--   • tt_doctor_feedback: Meldungen des Arztes an die Einsatzleitung (zu Berichten, Terminen, Patienten – Rückmeldung).
--     Die Einsatzleitung sieht sie auf der Startseite, hakt sie ab und kann antworten; der Arzt sieht die Antwort.
-- Kann beliebig oft ausgeführt werden.

create table if not exists public.tt_driver_notes (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  handover_id uuid references public.tt_handovers (id) on delete set null,
  damage_id uuid references public.tt_damages (id) on delete set null,
  vehicle_id uuid references public.tt_vehicles (id) on delete set null,
  plate text not null default '',
  driver_id uuid references public.tt_profiles (id) on delete cascade,      -- der Vorfahrer, um den es geht
  driver_name text not null default '',
  reporter_id uuid references public.tt_profiles (id) on delete set null,
  reporter_name text not null default '',
  kind text not null default 'hinweis' check (kind in ('unsauber', 'tank', 'schaden', 'hinweis')),
  text text not null default '',
  photo_paths jsonb not null default '[]'::jsonb,
  seen_at timestamptz,                 -- der Vorfahrer hat die Meldung gesehen
  office_seen_at timestamptz,
  office_seen_by text not null default '',
  admonished_at timestamptz,           -- Ermahnung durch die Einsatzleitung
  admonished_by text not null default '',
  office_note text not null default ''
);
create index if not exists tt_driver_notes_driver_idx on public.tt_driver_notes (driver_id, created_at desc);
create index if not exists tt_driver_notes_at_idx on public.tt_driver_notes (created_at desc);
alter table public.tt_driver_notes enable row level security;
revoke all on public.tt_driver_notes from anon, authenticated;
grant select, insert, update, delete on public.tt_driver_notes to authenticated;

-- Wer meldet und wer der Vorfahrer ist, kommt aus der Übergabe des Melders (oder aus dem Schaden, den er gemeldet hat).
create or replace function public.tt_driver_note_stamp() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_h public.tt_handovers;
  v_d public.tt_damages;
  v_v public.tt_vehicles;
begin
  new.created_at := now();
  new.seen_at := null; new.office_seen_at := null; new.office_seen_by := ''; new.admonished_at := null; new.admonished_by := ''; new.office_note := '';
  if not public.tt_is_staff() then
    new.reporter_id := (select auth.uid());
    new.reporter_name := coalesce((select full_name from public.tt_profiles where id = (select auth.uid())), '');
    if new.handover_id is null then
      select * into v_h from public.tt_handovers where driver_id = (select auth.uid()) and end_time is null order by created_at desc limit 1;
    else
      select * into v_h from public.tt_handovers where id = new.handover_id and driver_id = (select auth.uid());
    end if;
    if v_h.id is null then
      raise exception 'Eine Meldung über den Vorfahrer geht nur zu dem Fahrzeug, das du gerade übernommen hast.';
    end if;
    if v_h.previous_driver_id is null then
      raise exception 'Für dieses Fahrzeug ist kein vorheriger Fahrer bekannt.';
    end if;
    new.handover_id := v_h.id;
    new.vehicle_id := v_h.vehicle_id;
    new.driver_id := v_h.previous_driver_id;
    new.driver_name := coalesce(nullif(v_h.previous_driver_name, ''), (select full_name from public.tt_profiles where id = v_h.previous_driver_id), '');
    if new.damage_id is not null then
      select * into v_d from public.tt_damages where id = new.damage_id and reporter_id = (select auth.uid());
      if v_d.id is null then new.damage_id := null; end if;
    end if;
  end if;
  if new.vehicle_id is not null then
    select * into v_v from public.tt_vehicles where id = new.vehicle_id;
    new.plate := coalesce(v_v.plate, new.plate, '');
  end if;
  if jsonb_typeof(new.photo_paths) <> 'array' then new.photo_paths := '[]'::jsonb; end if;
  new.text := left(coalesce(new.text, ''), 1000);
  return new;
end;
$$;
drop trigger if exists tt_driver_note_stamp on public.tt_driver_notes;
create trigger tt_driver_note_stamp before insert on public.tt_driver_notes for each row execute function public.tt_driver_note_stamp();

-- Der Vorfahrer darf nur „gesehen“ setzen; der Melder nichts; das Büro alles.
create or replace function public.tt_driver_note_keep() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not public.tt_is_staff() then
    new := old;
    new.seen_at := coalesce(old.seen_at, now());
  end if;
  return new;
end;
$$;
drop trigger if exists tt_driver_note_keep on public.tt_driver_notes;
create trigger tt_driver_note_keep before update on public.tt_driver_notes for each row execute function public.tt_driver_note_keep();

drop policy if exists tt_driver_notes_select on public.tt_driver_notes;
create policy tt_driver_notes_select on public.tt_driver_notes for select to authenticated
  using (public.tt_is_staff() or driver_id = (select auth.uid()) or reporter_id = (select auth.uid()));
drop policy if exists tt_driver_notes_insert on public.tt_driver_notes;
create policy tt_driver_notes_insert on public.tt_driver_notes for insert to authenticated
  with check (public.tt_is_member());
drop policy if exists tt_driver_notes_update on public.tt_driver_notes;
create policy tt_driver_notes_update on public.tt_driver_notes for update to authenticated
  using (public.tt_is_staff() or driver_id = (select auth.uid())) with check (public.tt_is_staff() or driver_id = (select auth.uid()));
drop policy if exists tt_driver_notes_delete on public.tt_driver_notes;
create policy tt_driver_notes_delete on public.tt_driver_notes for delete to authenticated
  using (public.tt_is_admin());

-- Fotos der Meldung liegen im Ordner des Melders (Bucket schaeden) – der Vorfahrer darf sie sehen.
drop policy if exists schaeden_select_driver_note on storage.objects;
create policy schaeden_select_driver_note on storage.objects for select to authenticated
  using (bucket_id = 'schaeden' and exists (
    select 1 from public.tt_driver_notes n where n.driver_id = (select auth.uid()) and n.photo_paths ? storage.objects.name));

-- ---------- Meldungen des Arztes an die Einsatzleitung ----------
create table if not exists public.tt_doctor_feedback (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  doctor_id uuid references public.tt_profiles (id) on delete set null,
  doctor_name text not null default '',
  topic text not null default 'sonstiges' check (topic in ('bericht', 'termin', 'patient', 'sonstiges')),
  document_id uuid references public.tt_documents (id) on delete set null,
  document_title text not null default '',
  document_date date,
  interpreter_name text not null default '',
  patient_nr text not null default '',
  patient_name text not null default '',
  text text not null default '',
  seen_at timestamptz,
  seen_by text not null default '',
  answer text not null default '',
  answered_at timestamptz,
  answered_by text not null default '',
  doctor_seen_at timestamptz             -- der Arzt hat die Antwort gesehen
);
create index if not exists tt_doctor_feedback_at_idx on public.tt_doctor_feedback (created_at desc);
alter table public.tt_doctor_feedback enable row level security;
revoke all on public.tt_doctor_feedback from anon, authenticated;
grant select, insert, update, delete on public.tt_doctor_feedback to authenticated;

-- Wer schreibt, steht fest; Angaben zur Unterlage holt die Datenbank selbst.
create or replace function public.tt_doctor_feedback_stamp() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_doc public.tt_documents;
begin
  new.doctor_id := (select auth.uid());
  new.doctor_name := coalesce((select full_name from public.tt_profiles where id = (select auth.uid())), '');
  new.created_at := now();
  new.seen_at := null; new.seen_by := ''; new.answer := ''; new.answered_at := null; new.answered_by := ''; new.doctor_seen_at := null;
  if new.topic is null or new.topic not in ('bericht', 'termin', 'patient', 'sonstiges') then new.topic := 'sonstiges'; end if;
  new.document_title := ''; new.document_date := null; new.interpreter_name := '';
  if new.document_id is not null then
    select * into v_doc from public.tt_documents where id = new.document_id;
    if v_doc.id is null then
      new.document_id := null;
    else
      new.document_title := coalesce(nullif(v_doc.title, ''), v_doc.kind, '');
      new.document_date := coalesce(v_doc.date, v_doc.created_at::date);
      new.interpreter_name := coalesce(v_doc.uploader_name, '');
      new.patient_nr := coalesce(nullif(new.patient_nr, ''), v_doc.patient_nr, '');
      new.patient_name := coalesce(nullif(new.patient_name, ''), v_doc.patient_name, '');
    end if;
  end if;
  new.text := left(coalesce(new.text, ''), 2000);
  new.patient_nr := left(coalesce(new.patient_nr, ''), 60);
  new.patient_name := left(coalesce(new.patient_name, ''), 120);
  return new;
end;
$$;
drop trigger if exists tt_doctor_feedback_stamp on public.tt_doctor_feedback;
create trigger tt_doctor_feedback_stamp before insert on public.tt_doctor_feedback for each row execute function public.tt_doctor_feedback_stamp();

-- Der Arzt setzt nur „Antwort gesehen“; die Einsatzleitung hakt ab und antwortet.
create or replace function public.tt_doctor_feedback_keep() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not public.tt_is_staff() then
    new := old;
    new.doctor_seen_at := coalesce(old.doctor_seen_at, now());
  else
    new.id := old.id; new.created_at := old.created_at; new.doctor_id := old.doctor_id; new.doctor_name := old.doctor_name; new.text := old.text;
    if new.answer is distinct from old.answer then
      new.answered_at := case when btrim(new.answer) = '' then null else now() end;
      new.answered_by := case when btrim(new.answer) = '' then '' else coalesce((select full_name from public.tt_profiles where id = (select auth.uid())), '') end;
      new.doctor_seen_at := null;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists tt_doctor_feedback_keep on public.tt_doctor_feedback;
create trigger tt_doctor_feedback_keep before update on public.tt_doctor_feedback for each row execute function public.tt_doctor_feedback_keep();

drop policy if exists tt_doctor_feedback_select on public.tt_doctor_feedback;
create policy tt_doctor_feedback_select on public.tt_doctor_feedback for select to authenticated
  using (public.tt_is_staff() or doctor_id = (select auth.uid()));
drop policy if exists tt_doctor_feedback_insert on public.tt_doctor_feedback;
create policy tt_doctor_feedback_insert on public.tt_doctor_feedback for insert to authenticated
  with check (public.tt_is_doctor() or public.tt_is_staff());
drop policy if exists tt_doctor_feedback_update on public.tt_doctor_feedback;
create policy tt_doctor_feedback_update on public.tt_doctor_feedback for update to authenticated
  using (public.tt_is_staff() or doctor_id = (select auth.uid())) with check (public.tt_is_staff() or doctor_id = (select auth.uid()));
drop policy if exists tt_doctor_feedback_delete on public.tt_doctor_feedback;
create policy tt_doctor_feedback_delete on public.tt_doctor_feedback for delete to authenticated
  using (public.tt_is_staff() or (doctor_id = (select auth.uid()) and answered_at is null));
