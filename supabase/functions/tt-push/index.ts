// Medical Office Bonn · Transport und Dolmetscher · Server-Funktion "tt-push"
// Aufgaben:
//   publicKey      – öffentlichen Schlüssel für Mitteilungen liefern (legt das Schlüsselpaar beim ersten Mal an)
//   notify         – Mitteilung aufs Handy senden (nur Einsatzleitung/Sekretariat); „page“ wählt die Seite, die sich öffnet
//   remind         – Erinnerungen (ruft die Datenbank alle 10 Minuten auf):
//                    · ab 16 Uhr an die Rückgabe des Fahrzeugs (je Person einmal am Tag)
//                    · Auftrag gestartet, aber nicht beendet: nach 4 Stunden, danach alle 2 Stunden (Nachtruhe 22–7 Uhr)
//                    · Wochenplan der temporären Dolmetscher: Freitag 15 Uhr die Frage nach den Arbeitstagen der
//                      nächsten Woche, Samstag und Sonntag um 11 Uhr eine Erinnerung an alle, die noch nichts eingetragen haben
//   progress       – „Losgefahren“ / „Fertig“ eines Dolmetschers an die Einsatzleitung melden
//   absence        – Urlaubsantrag, Krankmeldung oder Notfall einer fest angestellten Person an die Einsatzleitung melden
//   resetPassword  – neues vorläufiges Passwort für ein Konto vergeben (nur Admin)
//   deleteAccount  – ein Konto endgültig löschen (nur Admin; nie das eigene, nie ein Admin-Konto)
// Einrichtung: Supabase → Edge Functions → neue Funktion "tt-push" → diesen Text einfügen → Deploy.
// Der Schalter "Verify JWT" darf an oder aus sein – die Funktion prüft die Anmeldung selbst.
import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-tt-auth',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY') ?? '';
const admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

// Schlüsselpaar für Web-Push: wird beim ersten Aufruf erzeugt und bleibt in der gesperrten Tabelle tt_push_config.
async function vapidKeys() {
  const { data } = await admin.from('tt_push_config').select('public_key, private_key').eq('id', 1).maybeSingle();
  if (data) return { publicKey: data.public_key, privateKey: data.private_key };
  const keys = webpush.generateVAPIDKeys();
  const { error } = await admin.from('tt_push_config').insert({ id: 1, public_key: keys.publicKey, private_key: keys.privateKey });
  if (error) {
    // Ein zweiter Aufruf war schneller – dessen Schlüssel verwenden.
    const again = await admin.from('tt_push_config').select('public_key, private_key').eq('id', 1).maybeSingle();
    if (again.data) return { publicKey: again.data.public_key, privateKey: again.data.private_key };
    throw new Error('Schlüssel konnte nicht gespeichert werden: ' + error.message);
  }
  return keys;
}

// Wer ruft auf? Liefert das Profil der angemeldeten Person oder null.
async function caller(req: Request) {
  // Die App schickt die Anmeldung im Kopf "x-tt-auth"; "Authorization" bleibt als zweiter Weg erlaubt.
  const token = (req.headers.get('x-tt-auth') ?? req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token || token.startsWith('sb_')) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return null;
  const { data: profile } = await admin.from('tt_profiles').select('id, full_name, role, active').eq('id', data.user.id).maybeSingle();
  return profile?.active ? profile : null;
}

// Sendet eine Mitteilung an alle Geräte der genannten Personen. Abgemeldete Geräte werden entfernt.
async function sendTo(profileIds: string[], payload: { title: string; body: string; url?: string; tag?: string }) {
  if (!profileIds.length) return { sent: 0, devices: 0 };
  const keys = await vapidKeys();
  webpush.setVapidDetails('https://masudtaher.github.io/Termin-Tool/', keys.publicKey, keys.privateKey);
  const { data: subscriptions } = await admin.from('tt_push_subscriptions').select('endpoint, p256dh, auth').in('profile_id', profileIds);
  let sent = 0;
  await Promise.all((subscriptions ?? []).map(async (item) => {
    try {
      await webpush.sendNotification({ endpoint: item.endpoint, keys: { p256dh: item.p256dh, auth: item.auth } }, JSON.stringify(payload), { TTL: 60 * 60 * 12 });
      sent += 1;
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) await admin.from('tt_push_subscriptions').delete().eq('endpoint', item.endpoint);
    }
  }));
  return { sent, devices: (subscriptions ?? []).length };
}

function berlinNow() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  // Wochentag des Berliner Datums: 0 = Sonntag … 5 = Freitag, 6 = Samstag
  return { date, hour: Number(get('hour')) % 24, weekday: new Date(`${date}T12:00:00Z`).getUTCDay() };
}

const HOUR = 60 * 60 * 1000;
// Rechnen mit Datumsangaben der Form 2026-10-09 (ohne Uhrzeit, also ohne Zeitzonen-Fallen)
const addDays = (isoDate: string, count: number) => {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
};
const deDate = (isoDate: string) => `${isoDate.slice(8, 10)}.${isoDate.slice(5, 7)}.`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Nur POST.' }, 405);
  let input: Record<string, unknown> = {};
  try { input = await req.json(); } catch (_error) { /* leerer Aufruf */ }
  const action = String(input.action ?? '');

  try {
    if (action === 'publicKey') {
      return json({ publicKey: (await vapidKeys()).publicKey });
    }

    if (action === 'remind') {
      const now = berlinNow();
      let reminded = 0;
      let open = 0;
      // 1) Fahrzeug zurückgeben: ab 16 Uhr, je Person einmal am Tag (Notdienst ausgenommen)
      if (now.hour >= 16) {
        const { data: handovers } = await admin.from('tt_handovers')
          .select('id, driver_id, vehicle_id, reminded_at, emergency')
          .is('end_time', null).eq('emergency', false).not('driver_id', 'is', null);
        open = (handovers ?? []).length;
        const due = (handovers ?? []).filter((item) => !item.reminded_at
          || new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date(item.reminded_at)) < now.date);
        for (const item of due) {
          const { data: vehicle } = await admin.from('tt_vehicles').select('plate').eq('id', item.vehicle_id).maybeSingle();
          const result = await sendTo([item.driver_id], {
            title: 'Fahrzeug zurückgeben',
            body: `Bitte gib ${vehicle?.plate ?? 'dein Fahrzeug'} zurück, wenn du fertig bist: Kilometer, Tank, Parkort, Sauberkeit.`,
            url: 'portal.html', tag: 'rueckgabe',
          });
          await admin.from('tt_handovers').update({ reminded_at: new Date().toISOString() }).eq('id', item.id);
          if (result.sent) reminded += 1;
        }
      }
      // 2) Auftrag gestartet, aber nicht als fertig gemeldet: erste Erinnerung nach 4 Stunden, danach alle 2 Stunden,
      //    bis „Fertig“ gemeldet ist. Nachts (22–7 Uhr) ist Ruhe; nach 12 Erinnerungen ist Schluss.
      let jobs = 0;
      if (now.hour >= 7 && now.hour < 22) {
        const { data: running } = await admin.from('tt_assignments')
          .select('id, interpreter_id, title, started_at, reminded_at, reminder_count')
          .eq('work_status', 'losgefahren').eq('cancelled', false).is('finished_at', null).not('started_at', 'is', null);
        for (const job of running ?? []) {
          const count = Number(job.reminder_count ?? 0);
          const dueAt = count === 0 || !job.reminded_at
            ? new Date(job.started_at).getTime() + 4 * HOUR
            : new Date(job.reminded_at).getTime() + 2 * HOUR;
          if (Date.now() < dueAt || count >= 12) continue;
          await sendTo([job.interpreter_id], {
            title: 'Auftrag noch nicht beendet',
            body: `${job.title}: Bitte melde im Portal „Fertig“, sobald der Auftrag beendet ist.`,
            url: 'portal.html?seite=auftraege', tag: `auftrag-${job.id}`,
          });
          await admin.from('tt_assignments').update({ reminded_at: new Date().toISOString(), reminder_count: count + 1 }).eq('id', job.id);
          jobs += 1;
        }
      }
      // 3) Wochenplan der temporären Dolmetscher: Freitag ab 13 Uhr wird die nächste Woche im Portal freigegeben – dann geht
      //    die Nachricht hinaus (Mitteilung aufs Handy und Nachricht im Portal),
      //    Samstag und Sonntag ab 11 Uhr eine Erinnerung – nur an Personen, die für die nächste Woche noch keinen Tag
      //    eingetragen haben. Jede der drei Stufen geht je Woche genau einmal hinaus (Merkzettel tt_push_log).
      let plan = 0;
      const stage = now.weekday === 5 && now.hour >= 13 ? 'fr' : now.weekday === 6 && now.hour >= 11 ? 'sa' : now.weekday === 0 && now.hour >= 11 ? 'so' : '';
      if (stage && now.hour < 21) {
        const monday = addDays(now.date, stage === 'fr' ? 3 : stage === 'sa' ? 2 : 1);
        // Der Eintrag gelingt nur beim ersten Mal; fehlt die Tabelle noch (Update 15), wird nichts gesendet.
        const { error: logError } = await admin.from('tt_push_log').insert({ key: `wochenplan:${monday}:${stage}` });
        if (!logError) {
          const [{ data: people }, { data: days }] = await Promise.all([
            admin.from('tt_profiles').select('id').eq('active', true).eq('role', 'dolmetscher').eq('employment', 'temporär'),
            admin.from('tt_workdays').select('user_id').gte('date', monday).lte('date', addDays(monday, 6)),
          ]);
          const answered = new Set((days ?? []).map((item) => item.user_id));
          const waiting = (people ?? []).map((item) => item.id).filter((id) => !answered.has(id));
          const week = `${deDate(monday)} bis ${deDate(addDays(monday, 4))}`;
          // Freitag: zusätzlich eine Nachricht im Portal an alle temporären Dolmetscher (auch ohne Mitteilungen aufs Handy sichtbar).
          if (stage === 'fr') {
            await admin.from('tt_messages').insert({ sender_name: 'Einsatzleitung', audience: 'temporär', recipient_ids: [], body: `Der Wochenplan für nächste Woche (${week}) ist offen. Bitte trag unter „Arbeitstage“ ein, an welchen Tagen du arbeiten kannst.` });
          }
          const result = await sendTo(waiting, {
            title: stage === 'fr' ? 'Wochenplan ist offen: Wann kannst du arbeiten?' : stage === 'sa' ? 'Erinnerung: Arbeitstage eintragen' : 'Letzte Erinnerung: Arbeitstage eintragen',
            body: stage === 'fr'
              ? `Ab jetzt kannst du dich für nächste Woche (${week}) eintragen. Bitte trag im Portal ein, an welchen Tagen du arbeiten kannst.`
              : `Für nächste Woche (${week}) fehlen noch deine Arbeitstage. Bitte trag sie im Portal ein.`,
            url: 'portal.html?seite=arbeitstage', tag: 'wochenplan',
          });
          plan = result.sent;
        }
      }
      return json({ reminded, open, jobs, plan });
    }

    const profile = await caller(req);
    if (!profile) return json({ error: 'Bitte zuerst anmelden.' }, 401);
    const isStaff = ['admin', 'sekretariat'].includes(profile.role);

    if (action === 'notify') {
      if (!isStaff) return json({ error: 'Nur Einsatzleitung und Sekretariat dürfen Mitteilungen senden.' }, 403);
      const audience = String(input.audience ?? 'alle');
      const recipientIds = Array.isArray(input.recipientIds) ? input.recipientIds.map(String) : [];
      let query = admin.from('tt_profiles').select('id, employment, role').eq('active', true);
      if (audience === 'einzeln') query = query.in('id', recipientIds.length ? recipientIds : ['00000000-0000-0000-0000-000000000000']);
      else if (audience === 'fest' || audience === 'temporär') query = query.eq('employment', audience).eq('role', 'dolmetscher');
      else query = query.neq('id', profile.id);
      const { data: people } = await query;
      // Wohin führt ein Tipp auf die Mitteilung? Nur diese Seiten des Portals sind erlaubt.
      const pages: Record<string, string> = {
        nachrichten: 'portal.html?seite=nachrichten', auftraege: 'portal.html?seite=auftraege', rueckfragen: 'portal.html?seite=rueckfragen',
        start: 'portal.html', arbeitstage: 'portal.html?seite=arbeitstage', zeiten: 'portal.html?seite=zeiten',
      };
      const tags: Record<string, string> = { rueckfragen: 'rueckfrage', start: 'anfrage', arbeitstage: 'wochenplan', zeiten: 'abwesenheit' };
      const page = String(input.page ?? 'nachrichten');
      const result = await sendTo((people ?? []).map((item) => item.id), {
        title: String(input.title ?? 'Nachricht von der Einsatzleitung').slice(0, 80),
        body: String(input.body ?? '').slice(0, 300),
        url: pages[page] ?? pages.nachrichten, tag: tags[page] ?? 'nachricht',
      });
      return json({ ...result, people: (people ?? []).length });
    }

    if (action === 'progress') {
      // Ein Dolmetscher hat „Losfahren“ oder „Fertig“ gemeldet: Mitteilung an Einsatzleitung und Sekretariat.
      const { data: job } = await admin.from('tt_assignments')
        .select('id, title, interpreter_id, interpreter_name, work_status').eq('id', String(input.assignmentId ?? '')).maybeSingle();
      if (!job || job.interpreter_id !== profile.id) return json({ error: 'Auftrag nicht gefunden.' }, 404);
      const { data: staff } = await admin.from('tt_profiles').select('id').eq('active', true).in('role', ['admin', 'sekretariat']);
      const finished = job.work_status === 'beendet';
      const result = await sendTo((staff ?? []).map((item) => item.id), {
        title: finished ? 'TERMIN · fertig, wieder frei' : 'TERMIN · losgefahren',
        body: `${job.interpreter_name}${finished ? ' ist fertig' : ' ist unterwegs'}: ${job.title}`,
        url: 'termineTracking.html', tag: `fortschritt-${job.id}`,
      });
      return json(result);
    }

    if (action === 'response') {
      // Ein Dolmetscher hat auf Aufträge geantwortet (Zusage, unter Vorbehalt, Absage): Mitteilung an Einsatzleitung und Sekretariat.
      const ids = (Array.isArray(input.assignmentIds) ? input.assignmentIds : [input.assignmentId]).map((id) => String(id ?? '')).filter(Boolean).slice(0, 30);
      if (!ids.length) return json({ error: 'Auftrag fehlt.' }, 400);
      const { data: jobs } = await admin.from('tt_assignments')
        .select('id, title, date, time, interpreter_id, interpreter_name, response, response_note').in('id', ids).eq('interpreter_id', profile.id);
      const answered = (jobs ?? []).filter((job) => ['zugesagt', 'vorbehalt', 'abgesagt'].includes(job.response)).sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
      if (!answered.length) return json({ sent: 0, devices: 0 });
      const { data: staff } = await admin.from('tt_profiles').select('id').eq('active', true).in('role', ['admin', 'sekretariat']);
      const words: Record<string, string> = { zugesagt: 'zugesagt', vorbehalt: 'unter Vorbehalt', abgesagt: 'ABGESAGT' };
      const first = answered[0];
      const same = answered.every((job) => job.response === first.response);
      const result = await sendTo((staff ?? []).map((item) => item.id), {
        title: answered.length === 1 ? `TERMIN · ${words[first.response]}` : `TERMIN · ${answered.length} Aufträge ${same ? words[first.response] : 'beantwortet'}`,
        body: answered.length === 1
          ? `${first.interpreter_name}: ${first.title}${first.response_note ? ` – „${String(first.response_note).slice(0, 120)}“` : ''}`
          : `${first.interpreter_name} · ${deDate(first.date)} · ${answered.map((job) => String(job.time ?? '').slice(0, 5)).filter(Boolean).join(', ')} Uhr`,
        url: 'termineTracking.html', tag: `antwort-${first.id}`,
      });
      return json(result);
    }

    if (action === 'vehicle') {
      // Ein Fahrzeug wurde im Portal übernommen oder zurückgegeben: eigene Mitteilung, klar getrennt von den Terminen.
      const back = String(input.kind ?? '') === 'return';
      const { data: trips } = await admin.from('tt_handovers')
        .select('id, vehicle_id, driver_name, date, start_time, end_time, end_mileage, created_at').eq('driver_id', profile.id).order('created_at', { ascending: false }).limit(1);
      const trip = (trips ?? [])[0];
      if (!trip || Boolean(trip.end_time) !== back) return json({ sent: 0, devices: 0 });
      const { data: vehicle } = await admin.from('tt_vehicles').select('plate, brand').eq('id', trip.vehicle_id).maybeSingle();
      const { data: staff } = await admin.from('tt_profiles').select('id').eq('active', true).in('role', ['admin', 'sekretariat']);
      const clock = String((back ? trip.end_time : trip.start_time) ?? '').slice(0, 5);
      const result = await sendTo((staff ?? []).map((item) => item.id), {
        title: back ? 'FAHRZEUG · zurückgegeben' : 'FAHRZEUG · übernommen',
        body: `${trip.driver_name} · ${vehicle?.plate ?? 'Fahrzeug'}${vehicle?.brand ? ` (${vehicle.brand})` : ''}${clock ? ` · ${clock} Uhr` : ''}${back && trip.end_mileage ? ` · ${trip.end_mileage} km` : ''}`,
        url: 'fahrzeuge.html', tag: `fahrzeug-${trip.id}-${back ? 'zurueck' : 'start'}`,
      });
      return json(result);
    }

    if (action === 'absence') {
      // Eine fest angestellte Person hat Urlaub beantragt oder Krankheit / einen Notfall gemeldet:
      // Mitteilung an Einsatzleitung und Sekretariat.
      const { data: item } = await admin.from('tt_absences')
        .select('id, profile_id, person_name, kind, date_from, date_to, note').eq('id', String(input.absenceId ?? '')).maybeSingle();
      if (!item || item.profile_id !== profile.id) return json({ error: 'Eintrag nicht gefunden.' }, 404);
      const { data: staff } = await admin.from('tt_profiles').select('id').eq('active', true).in('role', ['admin', 'sekretariat']);
      const range = item.date_from === item.date_to ? deDate(item.date_from) : `${deDate(item.date_from)} bis ${deDate(item.date_to)}`;
      const titles: Record<string, string> = { urlaub: 'Urlaubsantrag', krank: 'Krankmeldung', notfall: 'Notfall gemeldet' };
      const result = await sendTo((staff ?? []).map((entry) => entry.id), {
        title: titles[item.kind] ?? 'Abwesenheit gemeldet',
        body: `${item.person_name || profile.full_name || 'Unbekannt'}: ${range}${item.note ? ` – ${String(item.note).slice(0, 120)}` : ''}`,
        url: 'festangestellte.html?reiter=abwesenheiten', tag: `abwesenheit-${item.id}`,
      });
      return json(result);
    }

    if (action === 'deleteAccount') {
      // Ein Konto endgültig löschen. Arbeitstage, Aufträge, Überstunden, Abrechnungen und Abwesenheiten der Person gehen mit;
      // Fahrten, Schäden, Belege und Unterlagen bleiben erhalten (ohne Konto). Wer nur nicht mehr arbeiten soll, wird gesperrt.
      if (profile.role !== 'admin') return json({ error: 'Nur der Admin darf Konten löschen.' }, 403);
      const profileId = String(input.profileId ?? '');
      if (!profileId || profileId === profile.id) return json({ error: 'Das eigene Konto kann hier nicht gelöscht werden.' }, 400);
      const { data: target } = await admin.from('tt_profiles').select('id, full_name, role').eq('id', profileId).maybeSingle();
      if (!target) return json({ error: 'Dieses Konto gibt es nicht (mehr).' }, 404);
      if (target.role === 'admin') return json({ error: 'Ein Admin-Konto kann hier nicht gelöscht werden.' }, 400);
      const name = target.full_name || 'Die Person';
      const { data: trips } = await admin.from('tt_handovers').select('id').eq('driver_id', profileId).is('end_time', null);
      if ((trips ?? []).length) return json({ error: `${name} hat gerade ein Fahrzeug. Bitte zuerst die Rückgabe eintragen.` }, 409);
      const { data: cards } = await admin.from('tt_fuel_cards').select('number').eq('holder_id', profileId);
      if ((cards ?? []).length) return json({ error: `${name} hat noch die Tankkarte ${cards?.[0]?.number ?? ''}. Bitte zuerst zurücknehmen.` }, 409);
      const { error } = await admin.auth.admin.deleteUser(profileId);
      if (error && !/not found/i.test(error.message ?? '')) return json({ error: error.message }, 400);
      // Mit der Anmeldung verschwindet auch das Profil. Gab es die Anmeldung schon nicht mehr, wird das Profil hier entfernt.
      await admin.from('tt_profiles').delete().eq('id', profileId);
      return json({ deleted: true, name: target.full_name ?? '' });
    }

    if (action === 'resetPassword') {
      if (profile.role !== 'admin') return json({ error: 'Nur der Admin darf Passwörter neu vergeben.' }, 403);
      const profileId = String(input.profileId ?? '');
      if (!profileId || profileId === profile.id) return json({ error: 'Dieses Konto kann hier nicht zurückgesetzt werden.' }, 400);
      // Gut lesbares vorläufiges Passwort ohne verwechselbare Zeichen (0/O, 1/l).
      const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const bytes = crypto.getRandomValues(new Uint8Array(10));
      const password = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
      const { error } = await admin.auth.admin.updateUserById(profileId, { password });
      if (error) return json({ error: error.message }, 400);
      await admin.from('tt_profiles').update({ must_change_password: true }).eq('id', profileId);
      await admin.from('tt_reset_requests').update({ done_at: new Date().toISOString(), done_by: profile.full_name ?? '' }).eq('profile_id', profileId).is('done_at', null);
      return json({ password });
    }

    return json({ error: 'Unbekannte Aufgabe.' }, 400);
  } catch (error) {
    return json({ error: (error as Error).message ?? 'Fehler' }, 500);
  }
});
