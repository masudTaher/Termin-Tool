-- Botschaft Dolmetscher und Transport-App · Update 8b: automatische Erinnerung „Fahrzeug zurückgeben“
-- Erst ausführen, wenn die Funktion "tt-push" angelegt ist (siehe Anleitung EINRICHTUNG-MITTEILUNGEN.md).
-- Die Datenbank ruft dann täglich zwischen 16 und 22 Uhr alle 15 Minuten die Funktion auf.
-- Die Funktion erinnert jede Person höchstens einmal pro Tag und nur, wenn das Auto noch nicht zurück ist
-- (Notdienst ausgenommen). Kann erneut ausgeführt werden.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- Alten Zeitplan entfernen, falls vorhanden.
select cron.unschedule(jobid) from cron.job where jobname = 'tt-rueckgabe-erinnerung';

-- Zeiten in UTC: 14–20 Uhr UTC entspricht 16–22 Uhr (Sommerzeit) bzw. 15–21 Uhr (Winterzeit).
-- Die Funktion prüft selbst die deutsche Uhrzeit und erinnert erst ab 16 Uhr.
select cron.schedule(
  'tt-rueckgabe-erinnerung',
  '*/15 14-20 * * *',
  $$
  select net.http_post(
    url := 'https://dvjfvbrvhurlagmgprsp.supabase.co/functions/v1/tt-push',
    headers := '{"Content-Type": "application/json", "apikey": "sb_publishable_bw7aJIwh_FxsCGxxyROIbg_4BG9kM0o"}'::jsonb,
    body := '{"action": "remind"}'::jsonb
  );
  $$
);
