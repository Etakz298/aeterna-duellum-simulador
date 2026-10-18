import type { CardTemplate } from '../types';

export type Seat = 'p1' | 'p2' | 'p3' | 'p4';
export type GameMode = 'duel' | 'ffa3' | 'team4';
export type BackType = 'backA' | 'backB';

// Carta en una zona de juego tal y como la envía el servidor.
// Si está boca abajo no trae templateId: el cliente no sabe qué carta es.
export interface OnlinePlayCard {
  id: string;
  owner: Seat;
  deckId: string;
  backType: BackType;
  x: number; // relativa a la zona de juego, vista por su dueño
  y: number;
  isFaceUp: boolean;
  rotation: number;
  order: number;
  templateId?: string;
}

export interface CardBackInfo {
  deckId: string;
  backType: BackType;
}

export interface OnlineSide {
  library: { count: number; top: (CardBackInfo & { templateId?: string }) | null; shuffles?: number }; // templateId solo si es la carta Especial; shuffles: veces barajada
  graveyard: (CardBackInfo & { id: string; templateId?: string })[]; // templateId solo si es la carta Especial
  play: OnlinePlayCard[];
  handCount: number;
}

export interface OnlineHandCard extends CardBackInfo {
  id: string;
  templateId: string;
  isSpecial?: boolean; // carta Especial: va en su hueco a la derecha de la mano
}

export interface OnlinePlayer {
  name: string;
  connected: boolean;
  visible?: boolean; // tiene la partida a la vista (pestaña abierta y visible)
  deckId: string | null;
  left?: boolean;
  handRevealed?: boolean;
}

export interface LogEntry {
  id: string;
  at: number;
  kind: 'event' | 'chat' | 'reveal';
  text: string;
  by?: Seat; // quién escribió (mensajes de chat)
  audio?: { id: string; dur: number; wave: number[]; heard?: boolean }; // mensaje de voz
  reaction?: boolean; // emojis enviados desde el botón de la mesa (sin aviso)
}

export interface OnlineToken {
  id: string;
  x?: number;
  y?: number;
  cardId?: string; // token fijado a una carta en juego
  rx?: number; // posición dentro de esa carta (0-1)
  ry?: number;
}

export interface OnlineState {
  code: string;
  you: Seat;
  rev: number;
  players: Partial<Record<Seat, OnlinePlayer>>;
  starter?: Seat; // quién juega el primer turno
  started?: boolean; // ya se ha jugado alguna carta en esta partida
  oppSelected?: string | null; // carta en juego que tiene seleccionada el rival
  pointer?: { from: string; targets: string[]; by: Seat; rev: number } | null; // carta que señala a otras
  me: OnlineSide;
  opp: OnlineSide;
  hand: OnlineHandCard[];
  oppHand: (CardBackInfo & { templateId?: string; id?: string; isSpecial?: boolean })[]; // templateId solo si el rival enseña su mano (id solo en un jugador)
  life: { me: number; opp: number };
  tokens: OnlineToken[];
  log: LogEntry[];
}

export interface StateEffects {
  by?: Seat;
  select?: string[];
  reveal?: { by: Seat; templateId: string };
  matchEnded?: MatchResult;
  multiEnded?: { winner: string; label: string | null }; // 3 y 4 jugadores
}

export interface MatchResult {
  id: string;
  at: number;
  room: string;
  players: Record<Seat, { name: string; deck: string | null }>;
  winner: Seat | 'draw';
  by: string;
}

export interface PeekCard {
  id: string;
  templateId: string;
  name: string;
}

export interface PeekResult {
  zone: 'library' | 'graveyard';
  side?: Seat; // en un jugador: de quién es lo que se mira
  cards: PeekCard[];
}

export interface ServerLibrary {
  deckNames: Record<string, string>;
  templates: CardTemplate[];
  backs: Record<string, string>;
  updatedAt: number;
}

// ---------- Partidas de 3 jugadores (todos contra todos) y 2 contra 2 ----------

export interface MultiSide {
  library: { count: number; top: CardBackInfo | null; shuffles?: number };
  graveyard: (CardBackInfo & { id: string })[];
  play: OnlinePlayCard[];
  // Mano: la propia con id y templateId; la de los demás solo con el reverso (salvo la Especial)
  hand: (CardBackInfo & { id?: string; templateId?: string; isSpecial?: boolean })[];
  selected: string | null; // carta en juego que tiene seleccionada ese jugador
}

export interface MultiState {
  code: string;
  you: Seat;
  mode: 'ffa3' | 'team4';
  seats: Seat[];
  teams: Record<'A' | 'B', Seat[]> | null;
  rev: number;
  players: Partial<Record<Seat, OnlinePlayer>>;
  starter?: Seat;
  started?: boolean;
  pointer?: { from: string; targets: string[]; by: Seat; rev: number } | null;
  sides: Record<Seat, MultiSide>;
  lives: Record<Seat, number>;
  tokens: OnlineToken[];
  log: LogEntry[];
}
