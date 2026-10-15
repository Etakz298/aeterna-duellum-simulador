// Medidas lógicas de la mesa online. Deben coincidir con server/game.js.
// La mesa se dibuja siempre a 1600x900 y se escala a la ventana, así los dos
// jugadores la ven igual sea cual sea su resolución.

export const BOARD_W = 1920;
export const BOARD_H = 1080;
export const SIDE_W = 300; // columnas laterales (sala y vidas)
export const ROW_H = 200; // franja de biblioteca, mano y cementerio
export const PLAY_W = 1320;
export const PLAY_H = 320;
export const CARD_W = 130; // cartas en la zona de juego
export const CARD_H = 206;
export const SMALL_W = 100; // cartas en mano y montones
export const SMALL_H = 158;
export const TOKEN_SIZE = 40;
export const PILE_W = 200;
export const ZONE_GAP = 20;
export const LIFE_MIN = 0;
export const LIFE_MAX = 10;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ZoneKey = 'library' | 'hand' | 'play' | 'graveyard';
export type SideKey = 'me' | 'opp';

// La mesa es simétrica respecto al centro: el rival se ve como si estuviera
// sentado enfrente (todo girado 180º).
const MY_ZONES: Record<ZoneKey, Rect> = {
  play: { x: SIDE_W, y: BOARD_H / 2 + ZONE_GAP / 2, w: PLAY_W, h: PLAY_H },
  library: { x: SIDE_W, y: BOARD_H - ROW_H, w: PILE_W, h: ROW_H },
  hand: { x: SIDE_W + PILE_W + ZONE_GAP, y: BOARD_H - ROW_H, w: PLAY_W - 2 * (PILE_W + ZONE_GAP), h: ROW_H },
  graveyard: { x: SIDE_W + PLAY_W - PILE_W, y: BOARD_H - ROW_H, w: PILE_W, h: ROW_H },
};

export const mirrorRect = (r: Rect): Rect => ({ x: BOARD_W - r.x - r.w, y: BOARD_H - r.y - r.h, w: r.w, h: r.h });

export function zoneRect(side: SideKey, zone: ZoneKey): Rect {
  return side === 'me' ? MY_ZONES[zone] : mirrorRect(MY_ZONES[zone]);
}

// Posición de una carta de la zona de juego (relativa a su dueño) en la mesa
export function playCardPos(side: SideKey, x: number, y: number) {
  const r = zoneRect(side, 'play');
  if (side === 'me') return { x: r.x + x, y: r.y + y };
  return { x: r.x + (PLAY_W - CARD_W - x), y: r.y + (PLAY_H - CARD_H - y) };
}

export const inRect = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
export const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

// ---------- Disposición en pantalla ----------
// En móvil (mesa muy reducida) las zonas de juego se dibujan más bajas para que
// las manos y los montones se vean más grandes. Las posiciones que se guardan y
// se envían siguen siendo las de la mesa normal; esto solo cambia cómo se pinta.

export const COMPACT_PLAY = 0.65; // tamaño de las cartas en juego en móvil
const C_PLAY_H = Math.round(PLAY_H * COMPACT_PLAY); // 208
const C_BOARD_H = 2 * ROW_H + 2 * 10 + 2 * C_PLAY_H + ZONE_GAP; // 856

// Puntos de corte en vertical (mesa normal → mesa de móvil)
const STD_Y = [0, ROW_H, ROW_H + 10, ROW_H + 10 + PLAY_H, BOARD_H - ROW_H - 10 - PLAY_H, BOARD_H - ROW_H - 10, BOARD_H - ROW_H, BOARD_H];
const CMP_Y = [0, ROW_H, ROW_H + 10, ROW_H + 10 + C_PLAY_H, C_BOARD_H - ROW_H - 10 - C_PLAY_H, C_BOARD_H - ROW_H - 10, C_BOARD_H - ROW_H, C_BOARD_H];

function piecewise(from: number[], to: number[], v: number) {
  for (let i = 1; i < from.length; i++) {
    if (v <= from[i] || i === from.length - 1) {
      const t = (v - from[i - 1]) / (from[i] - from[i - 1] || 1);
      return to[i - 1] + t * (to[i] - to[i - 1]);
    }
  }
  return v;
}

export interface Layout {
  compact: boolean;
  boardH: number;
  cardW: number; // tamaño de una carta en juego
  cardH: number;
  zoneRect: (side: SideKey, zone: ZoneKey) => Rect;
  // Carta de la zona de juego (posición guardada, vista por su dueño) → mesa
  playCardPos: (side: SideKey, x: number, y: number) => { x: number; y: number };
  // Esquina de una carta en la mesa → posición guardada (vista por el dueño de la zona)
  playLocal: (side: SideKey, left: number, top: number) => { x: number; y: number };
  // Tokens: coordenadas de la mesa normal ↔ mesa dibujada
  toView: (x: number, y: number) => { x: number; y: number };
  fromView: (x: number, y: number) => { x: number; y: number };
}

export function makeLayout(compact: boolean): Layout {
  if (!compact) {
    return {
      compact,
      boardH: BOARD_H,
      cardW: CARD_W,
      cardH: CARD_H,
      zoneRect,
      playCardPos,
      playLocal: (side, left, top) => {
        const r = zoneRect(side, 'play');
        const x = clamp(left - r.x, 0, PLAY_W - CARD_W);
        const y = clamp(top - r.y, 0, PLAY_H - CARD_H);
        return side === 'me' ? { x, y } : { x: PLAY_W - CARD_W - x, y: PLAY_H - CARD_H - y };
      },
      toView: (x, y) => ({ x, y }),
      fromView: (x, y) => ({ x, y }),
    };
  }
  const cardW = CARD_W * COMPACT_PLAY;
  const cardH = CARD_H * COMPACT_PLAY;
  const ax = (PLAY_W - cardW) / (PLAY_W - CARD_W); // las zonas de juego mantienen su anchura
  const ay = (C_PLAY_H - cardH) / (PLAY_H - CARD_H);
  const myRects: Record<ZoneKey, Rect> = {
    play: { x: SIDE_W, y: C_BOARD_H - ROW_H - 10 - C_PLAY_H, w: PLAY_W, h: C_PLAY_H },
    library: { ...MY_ZONES.library, y: C_BOARD_H - ROW_H },
    hand: { ...MY_ZONES.hand, y: C_BOARD_H - ROW_H },
    graveyard: { ...MY_ZONES.graveyard, y: C_BOARD_H - ROW_H },
  };
  const rect = (side: SideKey, zone: ZoneKey): Rect => {
    const r = myRects[zone];
    return side === 'me' ? r : { x: BOARD_W - r.x - r.w, y: C_BOARD_H - r.y - r.h, w: r.w, h: r.h };
  };
  const inPlayBand = (y: number, std: boolean) => {
    const ys = std ? STD_Y : CMP_Y;
    return (y >= ys[2] && y <= ys[3]) || (y >= ys[4] && y <= ys[5]);
  };
  // En horizontal, dentro de una zona de juego: el centro de una carta sigue en su carta
  const offX = cardW / 2 - (ax * CARD_W) / 2;
  return {
    compact,
    boardH: C_BOARD_H,
    cardW,
    cardH,
    zoneRect: rect,
    playCardPos: (side, x, y) => {
      const r = rect(side, 'play');
      const mx = side === 'me' ? x : PLAY_W - CARD_W - x;
      const my = side === 'me' ? y : PLAY_H - CARD_H - y;
      return { x: r.x + ax * mx, y: r.y + ay * my };
    },
    playLocal: (side, left, top) => {
      const r = rect(side, 'play');
      const mx = clamp((left - r.x) / ax, 0, PLAY_W - CARD_W);
      const my = clamp((top - r.y) / ay, 0, PLAY_H - CARD_H);
      return side === 'me' ? { x: mx, y: my } : { x: PLAY_W - CARD_W - mx, y: PLAY_H - CARD_H - my };
    },
    toView: (x, y) => {
      const cx = x + TOKEN_SIZE / 2;
      const cy = y + TOKEN_SIZE / 2;
      const vy = piecewise(STD_Y, CMP_Y, cy);
      const vx = inPlayBand(cy, true) ? SIDE_W + ax * (cx - SIDE_W) + offX : cx;
      return { x: vx - TOKEN_SIZE / 2, y: vy - TOKEN_SIZE / 2 };
    },
    fromView: (x, y) => {
      const cx = x + TOKEN_SIZE / 2;
      const cy = y + TOKEN_SIZE / 2;
      const sy = piecewise(CMP_Y, STD_Y, cy);
      const sx = inPlayBand(cy, false) ? SIDE_W + (cx - SIDE_W - offX) / ax : cx;
      return { x: clamp(sx - TOKEN_SIZE / 2, 0, BOARD_W - TOKEN_SIZE), y: clamp(sy - TOKEN_SIZE / 2, 0, BOARD_H - TOKEN_SIZE) };
    },
  };
}
