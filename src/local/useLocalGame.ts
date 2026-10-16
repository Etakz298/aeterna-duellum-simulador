import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// El mismo motor que usa el servidor del 1 vs 1, aquí en modo libre: una sola
// persona controla a los dos jugadores.
import { Game } from '../../server/game.js';
import type { CardTemplate } from '../types';
import type { MatchResult, OnlineState, PeekResult, Seat, ServerLibrary } from '../online/types';

const GAME_KEY = 'solo_game';
const RESULTS_KEY = 'solo_results';
export const SOLO_NAMES: Record<Seat, string> = { p1: 'Jugador 1', p2: 'Jugador 2' };

export function loadSoloResults(): MatchResult[] {
  try {
    return JSON.parse(localStorage.getItem(RESULTS_KEY) || '[]') as MatchResult[];
  } catch {
    return [];
  }
}

function saveSoloResult(r: MatchResult) {
  try {
    const list = loadSoloResults();
    list.push(r);
    localStorage.setItem(RESULTS_KEY, JSON.stringify(list.slice(-5000)));
  } catch {
    // sin almacenamiento: no se guarda el historial
  }
}

function newGame(): any {
  const g: any = new Game('LOCAL', { free: true });
  for (const s of ['p1', 'p2'] as Seat[]) {
    g.players[s] = { name: SOLO_NAMES[s], token: '', deckId: null, connected: true, handRevealed: true };
  }
  return g;
}

function restoreGame(): any {
  const g = newGame();
  try {
    const raw = localStorage.getItem(GAME_KEY);
    if (!raw) return g;
    const d = JSON.parse(raw);
    g.cards = new Map((d.cards || []).map((c: any) => [c.id, c]));
    g.life = d.life || g.life;
    g.tokens = d.tokens || [];
    g.seq = d.seq || 0;
    g.log = d.log || [];
    for (const s of ['p1', 'p2'] as Seat[]) g.players[s].deckId = d.decks?.[s] ?? null;
  } catch {
    // partida guardada dañada: se empieza de cero
  }
  return g;
}

function persist(g: any) {
  try {
    localStorage.setItem(
      GAME_KEY,
      JSON.stringify({ cards: [...g.cards.values()], life: g.life, tokens: g.tokens, seq: g.seq, log: g.log, decks: { p1: g.players.p1.deckId, p2: g.players.p2.deckId } }),
    );
  } catch {
    // sin almacenamiento: la partida no sobrevive a recargar
  }
}

// Vista desde el Jugador 1 (abajo) con la mano del Jugador 2 visible y con ids
function viewOf(g: any): OnlineState {
  const v = g.viewFor('p1') as OnlineState;
  v.oppHand = g.zoneCards('p2', 'hand').map((c: any) => ({ id: c.id, templateId: c.templateId, deckId: c.deckId, backType: c.backType, isSpecial: !!c.isSpecial }));
  return v;
}

export function useLocalGame(
  local: { templates: CardTemplate[]; backUrls: Record<string, string>; deckNames: Record<string, string> },
  handlers: { onError: (message: string) => void; onMatchEnded: (r: MatchResult) => void },
) {
  const library: ServerLibrary = useMemo(
    () => ({
      deckNames: Object.fromEntries(Object.entries(local.deckNames).filter(([id]) => local.templates.some((t) => t.deckId === id))),
      templates: local.templates,
      backs: local.backUrls,
      updatedAt: 0,
    }),
    [local.templates, local.backUrls, local.deckNames],
  );
  const gameRef = useRef<any>(null);
  if (!gameRef.current) gameRef.current = restoreGame();
  const [state, setState] = useState<OnlineState>(() => viewOf(gameRef.current));
  const [peek, setPeek] = useState<PeekResult | null>(null);
  const [selectRequest, setSelectRequest] = useState<string[] | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const libraryRef = useRef(library);
  libraryRef.current = library;

  // Si se borra un mazo de la biblioteca, sus cartas desaparecen de la mesa
  useEffect(() => {
    if (!local.templates.length) return;
    const g = gameRef.current;
    const ids = new Set(local.templates.map((t) => t.id));
    let changed = false;
    for (const c of [...g.cards.values()]) {
      if (!ids.has(c.templateId)) {
        g.cards.delete(c.id);
        changed = true;
      }
    }
    if (changed) {
      persist(g);
      setState(viewOf(g));
    }
  }, [local.templates]);

  // msg.as indica con qué jugador se hace la acción (por defecto el Jugador 1)
  const send = useCallback((msg: any) => {
    const g = gameRef.current;
    const seat: Seat = msg.as === 'p2' ? 'p2' : 'p1';
    try {
      const result = g.apply(seat, msg, libraryRef.current);
      if (result.private?.t === 'peek') setPeek({ zone: result.private.zone, cards: result.private.cards, side: seat });
      if (result.fx?.select) setSelectRequest(result.fx.select);
      if (result.result) {
        saveSoloResult(result.result);
        handlersRef.current.onMatchEnded(result.result);
      }
    } catch (err) {
      handlersRef.current.onError(err instanceof Error ? err.message : String(err));
    }
    persist(g);
    setState(viewOf(g));
  }, []);

  const patchState = useCallback((fn: (s: OnlineState) => OnlineState) => setState((s) => fn(s)), []);

  return { state, library, send, patchState, peek, setPeek, selectRequest };
}
