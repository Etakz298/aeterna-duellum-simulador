import { useCallback, useEffect, useRef, useState } from 'react';
import type { OnlineState, PeekCard, StateEffects } from './types';
import { toWebSocketUrl } from './server';

const SESSION_KEY = 'online_session';
const MOVE_FLUSH_MS = 40;
const LOCAL_MOVE_GRACE_MS = 1200;

interface StoredSession {
  serverUrl: string;
  code: string;
  token: string;
}

export function loadStoredSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
}

function storeSession(s: StoredSession | null) {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // sin almacenamiento: solo se pierde la reconexión automática
  }
}

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting';

type Entry = { t: 'create'; name: string } | { t: 'join'; code: string; name: string } | { t: 'resume'; code: string; token: string };

export function useOnlineGame(handlers: {
  onEffects?: (fx: StateEffects) => void;
  onPeek?: (cards: PeekCard[]) => void;
  onError?: (message: string) => void;
}) {
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [state, setState] = useState<OnlineState | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const sessionRef = useRef<StoredSession | null>(null);
  const serverUrlRef = useRef<string>('');
  const leavingRef = useRef(false);
  const retryRef = useRef<number | undefined>(undefined);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  // Movimientos locales pendientes (para no "saltar" atrás al recibir estado)
  const pendingMoves = useRef(new Map<string, { x: number; y: number }>());
  const pendingCounterMoves = useRef(new Map<string, { x: number; y: number }>());
  const recentLocal = useRef(new Map<string, { x: number; y: number; at: number }>());
  const flushTimer = useRef<number | undefined>(undefined);

  const rawSend = useCallback((msg: object) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  const applyServerState = useCallback((incoming: OnlineState) => {
    const now = Date.now();
    const recent = recentLocal.current;
    for (const [id, m] of recent) if (now - m.at > LOCAL_MOVE_GRACE_MS) recent.delete(id);
    if (recent.size === 0) {
      setState(incoming);
      return;
    }
    setState({
      ...incoming,
      cards: incoming.cards.map((c) => {
        const m = recent.get(c.id);
        return m ? { ...c, x: m.x, y: m.y } : c;
      }),
      counters: incoming.counters.map((c) => {
        const m = recent.get(c.id);
        return m ? { ...c, x: m.x, y: m.y } : c;
      }),
    });
  }, []);

  const open = useCallback(
    (entry: Entry) => {
      window.clearTimeout(retryRef.current);
      const ws = new WebSocket(toWebSocketUrl(serverUrlRef.current));
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify(entry));
      };

      ws.onmessage = (ev) => {
        let msg: any;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        switch (msg.t) {
          case 'joined': {
            const s = { serverUrl: serverUrlRef.current, code: msg.code, token: msg.token };
            sessionRef.current = s;
            storeSession(s);
            setStatus('open');
            setFatalError(null);
            break;
          }
          case 'state':
            applyServerState(msg.state);
            if (msg.fx) handlersRef.current.onEffects?.(msg.fx);
            break;
          case 'moved':
          case 'counterMoved': {
            const map = new Map<string, { x: number; y: number }>(
              (msg.updates || []).map((u: { id: string; x: number; y: number }) => [u.id, u]),
            );
            setState((prev) => {
              if (!prev) return prev;
              if (msg.t === 'moved') {
                return {
                  ...prev,
                  cards: prev.cards.map((c) => {
                    const u = map.get(c.id);
                    return u ? { ...c, x: u.x, y: u.y } : c;
                  }),
                };
              }
              return {
                ...prev,
                counters: prev.counters.map((c) => {
                  const u = map.get(c.id);
                  return u ? { ...c, x: u.x, y: u.y } : c;
                }),
              };
            });
            break;
          }
          case 'peek':
            handlersRef.current.onPeek?.(msg.cards || []);
            break;
          case 'kicked':
            leavingRef.current = true;
            setFatalError(msg.message);
            break;
          case 'error':
            if (msg.fatal) {
              leavingRef.current = true;
              storeSession(null);
              sessionRef.current = null;
              setFatalError(msg.message);
              setState(null);
              setStatus('idle');
              ws.close();
            } else {
              handlersRef.current.onError?.(msg.message);
            }
            break;
        }
      };

      ws.onclose = () => {
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        if (leavingRef.current) return;
        if (sessionRef.current) {
          // Reconexión automática a la misma sala
          setStatus('reconnecting');
          const s = sessionRef.current;
          retryRef.current = window.setTimeout(() => open({ t: 'resume', code: s.code, token: s.token }), 1500);
        } else {
          setStatus('idle');
          setFatalError('No se ha podido conectar con el servidor.');
        }
      };
    },
    [applyServerState],
  );

  const connect = useCallback(
    (serverUrl: string, entry: Entry) => {
      leavingRef.current = false;
      serverUrlRef.current = serverUrl;
      setFatalError(null);
      setStatus('connecting');
      if (entry.t === 'resume') sessionRef.current = { serverUrl, code: entry.code, token: entry.token };
      wsRef.current?.close();
      open(entry);
    },
    [open],
  );

  const leave = useCallback(() => {
    leavingRef.current = true;
    // Avisar al servidor para que el rival sepa que nos hemos ido
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'leave' }));
    window.clearTimeout(retryRef.current);
    storeSession(null);
    sessionRef.current = null;
    wsRef.current?.close();
    wsRef.current = null;
    setState(null);
    setStatus('idle');
  }, []);

  useEffect(
    () => () => {
      leavingRef.current = true;
      window.clearTimeout(retryRef.current);
      window.clearTimeout(flushTimer.current);
      wsRef.current?.close();
    },
    [],
  );

  const flushMoves = useCallback(() => {
    window.clearTimeout(flushTimer.current);
    flushTimer.current = undefined;
    if (pendingMoves.current.size) {
      rawSend({ t: 'move', updates: [...pendingMoves.current].map(([id, p]) => ({ id, ...p })) });
      pendingMoves.current.clear();
    }
    if (pendingCounterMoves.current.size) {
      rawSend({ t: 'counterMove', updates: [...pendingCounterMoves.current].map(([id, p]) => ({ id, ...p })) });
      pendingCounterMoves.current.clear();
    }
  }, [rawSend]);

  // Movimiento local inmediato + envío agrupado al servidor
  const moveItems = useCallback(
    (kind: 'card' | 'counter', updates: { id: string; x: number; y: number }[]) => {
      if (updates.length === 0) return;
      const now = Date.now();
      const map = new Map(updates.map((u) => [u.id, u]));
      for (const u of updates) {
        (kind === 'card' ? pendingMoves : pendingCounterMoves).current.set(u.id, { x: u.x, y: u.y });
        recentLocal.current.set(u.id, { x: u.x, y: u.y, at: now });
      }
      setState((prev) => {
        if (!prev) return prev;
        if (kind === 'card') {
          return { ...prev, cards: prev.cards.map((c) => (map.has(c.id) ? { ...c, ...map.get(c.id)! } : c)) };
        }
        return { ...prev, counters: prev.counters.map((c) => (map.has(c.id) ? { ...c, ...map.get(c.id)! } : c)) };
      });
      if (flushTimer.current === undefined) flushTimer.current = window.setTimeout(flushMoves, MOVE_FLUSH_MS);
    },
    [flushMoves],
  );

  // Cualquier otra acción: primero se envían los movimientos pendientes
  const send = useCallback(
    (msg: object) => {
      flushMoves();
      rawSend(msg);
    },
    [flushMoves, rawSend],
  );

  return { status, state, setState, fatalError, connect, leave, send, moveItems, flushMoves };
}
