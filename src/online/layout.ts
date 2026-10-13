// Medidas lógicas de la mesa online. Deben coincidir con server/game.js.
// La mesa se dibuja siempre a 1600x900 y se escala a la ventana, así los dos
// jugadores la ven igual sea cual sea su resolución.

export const BOARD_W = 1600;
export const BOARD_H = 900;
export const SIDE_W = 140; // columnas de los contadores de vida
export const ROW_H = 190; // fila de biblioteca, mano y cementerio
export const PLAY_W = 1320;
export const PLAY_H = 260;
export const CARD_W = 100;
export const CARD_H = 158;
export const TOKEN_SIZE = 36;
export const PILE_W = 200;
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
  play: { x: SIDE_W, y: BOARD_H / 2, w: PLAY_W, h: PLAY_H },
  library: { x: SIDE_W, y: BOARD_H - ROW_H, w: PILE_W, h: ROW_H },
  hand: { x: SIDE_W + PILE_W, y: BOARD_H - ROW_H, w: PLAY_W - 2 * PILE_W, h: ROW_H },
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
