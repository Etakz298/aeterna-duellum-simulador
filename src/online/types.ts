import type { CardTemplate } from '../types';

export type Seat = 'p1' | 'p2';
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
  library: { count: number; top: CardBackInfo | null };
  graveyard: (CardBackInfo & { id: string })[];
  play: OnlinePlayCard[];
  handCount: number;
}

export interface OnlineHandCard extends CardBackInfo {
  id: string;
  templateId: string;
}

export interface OnlinePlayer {
  name: string;
  connected: boolean;
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
  me: OnlineSide;
  opp: OnlineSide;
  hand: OnlineHandCard[];
  oppHand: (CardBackInfo & { templateId?: string; id?: string })[]; // templateId solo si el rival enseña su mano (id solo en un jugador)
  life: { me: number; opp: number };
  tokens: OnlineToken[];
  log: LogEntry[];
}

export interface StateEffects {
  by?: Seat;
  select?: string[];
  reveal?: { by: Seat; templateId: string };
  matchEnded?: MatchResult;
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
