// Botschaft Dolmetscher und Transport-App · Server-Funktion "tt-push"
// Aufgaben:
//   publicKey      – öffentlichen Schlüssel für Mitteilungen liefern (legt das Schlüsselpaar beim ersten Mal an)
//   notify         – Mitteilung aufs Handy senden (nur Einsatzleitung/Sekretariat)
//   remind         – ab 16 Uhr an die Rückgabe des Fahrzeugs erinnern (ruft die Datenbank automatisch auf)
//   resetPassword  – neues vorläufiges Passwort für ein Konto vergeben (nur Admin)
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
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24 };
}

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
      if (now.hour < 16) return json({ reminded: 0, reason: 'vor 16 Uhr' });
      const { data: open } = await admin.from('tt_handovers')
        .select('id, driver_id, vehicle_id, reminded_at, emergency')
        .is('end_time', null).eq('emergency', false).not('driver_id', 'is', null);
      const due = (open ?? []).filter((item) => !item.reminded_at
        || new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date(item.reminded_at)) < now.date);
      let reminded = 0;
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
      return json({ reminded, open: (open ?? []).length });
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
      const result = await sendTo((people ?? []).map((item) => item.id), {
        title: String(input.title ?? 'Nachricht von der Einsatzleitung').slice(0, 80),
        body: String(input.body ?? '').slice(0, 300),
        url: 'portal.html?seite=nachrichten', tag: 'nachricht',
      });
      return json({ ...result, people: (people ?? []).length });
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
