// Fahrzeugskizze (Draufsicht) für Schadensmeldungen – wie auf dem Übergabeprotokoll einer Autovermietung.
// Positionen werden als Anteil 0 … 1 gespeichert (x: links → rechts, y: vorne → hinten).
const CarSketch = (() => {
    const WIDTH = 200;
    const HEIGHT = 380;
    const STATUS_LABELS = { offen: 'Neu gemeldet', bekannt: 'Altschaden', 'in Arbeit': 'In Reparatur', erledigt: 'Behoben' };

    function zoneLabel(x, y) {
        const row = y < 0.3 ? 'vorne' : y > 0.7 ? 'hinten' : 'Seite';
        const column = x < 0.38 ? 'links' : x > 0.62 ? 'rechts' : 'Mitte';
        if (column === 'Mitte') return row === 'vorne' ? 'vorne Mitte (Motorhaube/Front)' : row === 'hinten' ? 'hinten Mitte (Heck)' : 'Dach / Mitte';
        return `${row} ${column}`;
    }

    const OUTLINE = `
        <rect class="sketch-wheel" x="27" y="66" width="14" height="52" rx="5"/>
        <rect class="sketch-wheel" x="159" y="66" width="14" height="52" rx="5"/>
        <rect class="sketch-wheel" x="27" y="262" width="14" height="52" rx="5"/>
        <rect class="sketch-wheel" x="159" y="262" width="14" height="52" rx="5"/>
        <path class="sketch-body" d="M62 22 Q100 10 138 22 Q160 30 162 70 L164 310 Q164 350 140 360 Q100 368 60 360 Q36 350 36 310 L38 70 Q40 30 62 22 Z"/>
        <path class="sketch-glass" d="M54 112 Q100 96 146 112 L140 146 Q100 138 60 146 Z"/>
        <path class="sketch-glass" d="M60 290 Q100 298 140 290 L146 318 Q100 330 54 318 Z"/>
        <path class="sketch-line" d="M60 146 L60 290 M140 146 L140 290 M60 218 L140 218"/>
        <path class="sketch-line" d="M50 100 Q100 84 150 100"/>
        <path class="sketch-line" d="M48 152 L48 284 M152 152 L152 284"/>
        <path class="sketch-mirror" d="M38 122 L24 116 L24 128 Z M162 122 L176 116 L176 128 Z"/>
        <path class="sketch-light" d="M52 26 Q62 20 72 20 L70 30 Q60 30 50 36 Z M148 26 Q138 20 128 20 L130 30 Q140 30 150 36 Z"/>
        <path class="sketch-light sketch-light-rear" d="M46 352 Q56 358 68 360 L68 352 Q56 350 46 344 Z M154 352 Q144 358 132 360 L132 352 Q144 350 154 344 Z"/>
        <text class="sketch-label" x="100" y="9" text-anchor="middle">VORNE</text>
        <text class="sketch-label" x="100" y="378" text-anchor="middle">HINTEN</text>
        <text class="sketch-label" x="10" y="194" text-anchor="middle">L</text>
        <text class="sketch-label" x="190" y="194" text-anchor="middle">R</text>`;

    // options.onPick(position) macht die Skizze antippbar; options.onMarker(marker) reagiert auf vorhandene Markierungen.
    function create(container, options = {}) {
        const NS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('viewBox', `0 0 ${WIDTH} ${HEIGHT}`);
        svg.setAttribute('class', `car-sketch${options.onPick ? ' is-pickable' : ''}`);
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', 'Fahrzeugskizze von oben mit markierten Schäden');
        svg.innerHTML = `${OUTLINE}<g class="sketch-markers"></g><g class="sketch-picked"></g>`;
        container.replaceChildren(svg);
        const markerLayer = svg.querySelector('.sketch-markers');
        const pickedLayer = svg.querySelector('.sketch-picked');
        let picked = null;

        function setMarkers(markers) {
            markerLayer.replaceChildren();
            (markers || []).forEach((marker, index) => {
                if (marker.x == null || marker.y == null) return;
                const group = document.createElementNS(NS, 'g');
                group.setAttribute('class', 'sketch-marker');
                group.dataset.status = marker.status || 'offen';
                group.setAttribute('transform', `translate(${marker.x * WIDTH} ${marker.y * HEIGHT})`);
                group.setAttribute('tabindex', '0');
                group.setAttribute('role', 'button');
                const title = document.createElementNS(NS, 'title');
                title.textContent = `${marker.number ?? index + 1}: ${STATUS_LABELS[marker.status] || ''} – ${marker.label || ''}`;
                const circle = document.createElementNS(NS, 'circle');
                circle.setAttribute('r', '10');
                const text = document.createElementNS(NS, 'text');
                text.setAttribute('text-anchor', 'middle');
                text.setAttribute('dy', '3.6');
                text.textContent = String(marker.number ?? index + 1);
                group.append(title, circle, text);
                const activate = event => { event.stopPropagation(); options.onMarker?.(marker); };
                group.addEventListener('click', activate);
                group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(event); } });
                markerLayer.append(group);
            });
        }

        function setPicked(position) {
            picked = position;
            pickedLayer.replaceChildren();
            if (!position) return;
            const ring = document.createElementNS(NS, 'circle');
            ring.setAttribute('class', 'sketch-picked-ring');
            ring.setAttribute('cx', position.x * WIDTH);
            ring.setAttribute('cy', position.y * HEIGHT);
            ring.setAttribute('r', '12');
            const cross = document.createElementNS(NS, 'path');
            cross.setAttribute('class', 'sketch-picked-cross');
            cross.setAttribute('d', `M${position.x * WIDTH - 6} ${position.y * HEIGHT} h12 M${position.x * WIDTH} ${position.y * HEIGHT - 6} v12`);
            pickedLayer.append(ring, cross);
        }

        if (options.onPick) {
            svg.addEventListener('click', event => {
                const box = svg.getBoundingClientRect();
                const position = {
                    x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
                    y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height))
                };
                setPicked(position);
                options.onPick(position);
            });
        }

        return { setMarkers, setPicked, getPicked: () => picked };
    }

    return { create, zoneLabel, STATUS_LABELS };
})();
