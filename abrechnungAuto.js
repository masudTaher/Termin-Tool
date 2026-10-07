// Abrechnung von selbst im Portal: Der laufende Stand jeder Person (Arbeitstage aus den beendeten Terminen, Sondertage,
// Belege) wird ohne Freigabe im Dolmetscher-Portal gezeigt und aktuell gehalten. Abgeschlossene Abrechnungen
// (zum Bestätigen gesendet) und ausgeblendete werden dabei nie angefasst.
const AbrechnungAuto = (() => {
    const STAMP_KEY = 'terminTool.payroll.autoSync';
    const EVERY_MS = 15 * 60 * 1000;
    const enabled = () => !window.__noAutoStatements;

    // Schreibt die geplanten Stände. Gibt die Zahl der geschriebenen Zeilen zurück (−1 bei einem Fehler).
    async function write(client, month, writes) {
        if (!writes.length) return 0;
        const now = new Date().toISOString();
        const { error } = await client.from('tt_statements').upsert(writes.map(({ row, data }) => ({
            month, profile_id: row.profileId, person_name: row.name, data,
            released_at: now, released_by: 'automatisch', response: 'offen', response_note: '', responded_at: null
        })), { onConflict: 'month,profile_id' });
        return error ? -1 : writes.length;
    }

    async function syncMonth(client, month) {
        const range = Abrechnung.monthRange(month);
        const [receiptResult, specialResult, payrollResult, monthResult, dayResult, profileResult, statementResult] = await Promise.all([
            client.from('tt_receipts').select('*').gte('date', range.start).lte('date', range.end),
            client.from('tt_special_days').select('*').gte('date', range.start).lte('date', range.end),
            client.from('tt_payroll').select('*').eq('month', month),
            client.from('tt_payroll_months').select('*').eq('month', month).maybeSingle(),
            client.from('tt_days').select('*').gte('date', range.start).lte('date', range.end),
            client.from('tt_profiles').select('*'),
            client.from('tt_statements').select('*').eq('month', month)
        ]);
        // Fehlt irgendeine Angabe, wird nichts geschrieben – lieber ein alter Stand als ein falscher.
        if ([receiptResult, specialResult, payrollResult, monthResult, dayResult, profileResult, statementResult].some(item => item.error)) return -1;
        const profiles = profileResult.data || [];
        const festIds = new Set(profiles.filter(item => item.employment === 'fest').map(item => item.id));
        const rate = Number(monthResult.data?.daily_rate ?? 80);
        const days = dayResult.data || [];
        const specialDays = specialResult.data || [];
        const { result } = Abrechnung.buildRows({
            month, rate, receipts: (receiptResult.data || []).filter(item => !festIds.has(item.profile_id)), specialDays,
            trackingSpecial: Abrechnung.specialFromDays(days, specialDays), payroll: payrollResult.data || [], profiles,
            autoWorkdays: Abrechnung.countWorkdays(days), statements: statementResult.data || []
        });
        return write(client, month, Abrechnung.planSync(result.rows, { month, rate, dayDates: Abrechnung.workdayDates(days) }));
    }

    // Im Hintergrund auf den Büro-Seiten: höchstens alle 15 Minuten, laufender Monat und der Monat davor.
    async function background(client) {
        if (!enabled() || !client) return;
        try {
            if (Date.now() - Number(localStorage.getItem(STAMP_KEY) || 0) < EVERY_MS) return;
            localStorage.setItem(STAMP_KEY, String(Date.now()));
        } catch (error) { return; }
        try {
            await syncMonth(client, Abrechnung.currentMonth());
            await syncMonth(client, Abrechnung.previousMonth());
        } catch (error) { /* beim nächsten Mal */ }
    }

    return { enabled, write, syncMonth, background };
})();
