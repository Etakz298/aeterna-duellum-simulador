import type { CardTemplate, LifeCounter } from '../types';

export type Seat = 'p1' | 'p2';

// Carta sobre la mesa tal y como la envía el servidor.
// Si está boca abajo no trae templateId: el cliente no sabe qué carta es.
export interface OnlineBoardCard {
  id: string;
  owner: Seat;
  deckId: string;
  backType: 'backA' | 'backB';
  x: number;
  y: number;
  isFaceUp: boolean;
  rotation: number;
  zIndex: number;
  templateId?: string;
}

export interface OnlineHandCard {
  id: string;
  templateId: string;
  deckId: string;
  backType: 'backA' | 'backB';
}

export interface OpponentHandCard {
  deckId: string;
  backType: 'backA' | 'backB';
}

export interface OnlinePlayer {
  name: string;
  connected: boolean;
  deckId: string | null;
  handCount: number;
  left?: boolean;
}

export interface LogEntry {
  id: string;
  at: number;
  kind: 'event' | 'chat' | 'reveal';
  text: string;
}

export interface OnlineState {
  code: string;
  you: Seat;
  rev: number;
  players: Partial<Record<Seat, OnlinePlayer>>;
  cards: OnlineBoardCard[];
  hand: OnlineHandCard[];
  oppHand: OpponentHandCard[];
  counters: LifeCounter[];
  log: LogEntry[];
}

export interface StateEffects {
  by?: Seat;
  shuffle?: string[];
  select?: string[];
  reveal?: { by: Seat; templateId: string };
}

export interface PeekCard {
  id: string;
  templateId: string;
  name: string;
}

export interface ServerLibrary {
  deckNames: Record<string, string>;
  templates: CardTemplate[];
  backs: Record<string, string>;
  updatedAt: number;
}
