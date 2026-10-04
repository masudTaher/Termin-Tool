// Fahrzeugbilder: drei schlichte, schwarze Seitenansichten – Limousine, Kombi und Bus (Van).
// Bewusst ohne Markenzeichen. Liegt ein eigenes Foto in der Fahrzeugakte, wird das Foto gezeigt.
window.CarArt = (function () {
    let counter = 0;

    const SHAPES = {
        limousine: {
            body: 'M15 87C12 77 14 68 26 64L88 56C104 41 120 32 141 31L191 31C214 32 231 44 246 55L289 58C299 59 306 66 306 76L305 87L270 87A27 27 0 0 0 216 87L106 87A27 27 0 0 0 52 87Z',
            glass: 'M101 56C113 44 125 37 141 36.500L189 36.500C207 37.500 222 46 234 55Z',
            pillars: ['M164 37L162 56'],
            line: 'M30 68L296 64',
            handles: [[136, 62], [190, 62]],
            wheels: [79, 243]
        },
        kombi: {
            body: 'M15 87C12 77 14 68 26 64L88 56C104 41 120 32 141 31L262 31C282 33 296 45 302 58C305 64 306 70 306 76L305 87L270 87A27 27 0 0 0 216 87L106 87A27 27 0 0 0 52 87Z',
            glass: 'M101 56C113 44 125 37 141 36.500L258 36.500C274 38.500 286 46 292 55Z',
            pillars: ['M164 37L162 56', 'M226 37L227 56'],
            line: 'M30 68L300 64',
            handles: [[136, 62], [198, 62]],
            wheels: [79, 243]
        },
        bus: {
            body: 'M13 87C11 76 13 66 24 60L52 53C68 31 84 17 106 15L284 15C298 16 305 25 306 40L306 87L277 87A27 27 0 0 0 223 87L101 87A27 27 0 0 0 47 87Z',
            glass: 'M66 53C78 35 90 23 108 21L286 21C294 22 298 27 299 35L299 53Z',
            pillars: ['M122 22L118 53', 'M186 21L186 53', 'M250 21L250 53'],
            line: 'M26 66L302 66',
            handles: [[150, 61], [214, 61]],
            wheels: [74, 250]
        }
    };

    function kind(body) {
        const text = String(body || '').toLocaleLowerCase('de-DE');
        if (/bus|van|v-?klasse|vito|transporter|sprinter/.test(text)) return 'bus';
        if (/kombi|touring|t-?modell|avant|variant/.test(text)) return 'kombi';
        return 'limousine';
    }

    function svg(body) {
        const shape = SHAPES[kind(body)];
        const id = `carArt${++counter}`;
        const wheel = x => `<g transform="translate(${x} 87)"><circle r="20" fill="#0b0d10"/><circle r="12.500" fill="#aab2bc"/><circle r="12.500" fill="none" stroke="#6d7783" stroke-width="1.500"/><path d="M0-11V11M-11 0H11M-7.800-7.800L7.800 7.800M-7.800 7.800L7.800-7.800" stroke="#6d7783" stroke-width="1.600"/><circle r="4" fill="#e6eaef"/></g>`;
        return `<svg viewBox="0 0 320 116" role="img" aria-label="Fahrzeug" xmlns="http://www.w3.org/2000/svg">
            <defs>
                <linearGradient id="${id}b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a414c"/><stop offset=".45" stop-color="#171a20"/><stop offset="1" stop-color="#08090b"/></linearGradient>
                <linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fa1b5"/><stop offset="1" stop-color="#3a4656"/></linearGradient>
            </defs>
            <ellipse cx="160" cy="107" rx="140" ry="6" fill="#0f172a" opacity=".16"/>
            <path d="${shape.body}" fill="url(#${id}b)"/>
            <path d="${shape.glass}" fill="url(#${id}g)"/>
            ${shape.pillars.map(path => `<path d="${path}" stroke="#14171c" stroke-width="5" stroke-linecap="round"/>`).join('')}
            <path d="${shape.line}" stroke="#5a6470" stroke-width="1.200" opacity=".7" fill="none"/>
            ${shape.handles.map(([x, y]) => `<rect x="${x}" y="${y}" width="12" height="2.600" rx="1.300" fill="#7b8591"/>`).join('')}
            <path d="M17 70l12-3v6l-11 3z" fill="#f3efd9"/>
            <path d="M305 66l-8-2v8l8 1z" fill="#c8362f"/>
            ${shape.wheels.map(wheel).join('')}
        </svg>`;
    }

    return { svg, kind };
})();
