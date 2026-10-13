import { useCallback, useEffect, useRef, useState } from 'react';
import type { OnlineState, PeekResult, StateEffects } from './types';
import { toWebSocketUrl } from './server';

const SESSION_KEY = 'online_session';

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
  onPeek?: (peek: PeekResult) => void;
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

  const rawSend = useCallback((msg: object) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
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
            setState(msg.state);
            if (msg.fx) handlersRef.current.onEffects?.(msg.fx);
            break;
          case 'peek':
            handlersRef.current.onPeek?.({ zone: msg.zone, cards: msg.cards || [] });
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
    [],
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
      wsRef.current?.close();
    },
    [],
  );

  return { status, state, setState, fatalError, connect, leave, send: rawSend };
}
