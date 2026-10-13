import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  Copy,
  Eye,
  EyeOff,
  Hand,
  Layers,
  LogOut,
  MessageSquare,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Search,
  Shuffle,
  X,
} from 'lucide-react';
import type { CardTemplate } from '../types';
import type { CardBackInfo, OnlinePlayCard, OnlineState, PeekResult, Seat, ServerLibrary } from './types';
import {
  BOARD_H,
  BOARD_W,
  CARD_H,
  CARD_W,
  LIFE_MAX,
  LIFE_MIN,
  PLAY_H,
  PLAY_W,
  SIDE_W,
  TOKEN_SIZE,
  clamp,
  inRect,
  playCardPos,
  zoneRect,
  type Rect,
  type SideKey,
  type ZoneKey,
} from './layout';
import { inviteLink } from './server';
import type { ConnectionStatus } from './useOnlineGame';

interface OnlineTableProps {
  state: OnlineState;
  status: ConnectionStatus;
  library: ServerLibrary;
  serverUrl: string;
  send: (msg: object) => void;
  patchState: (fn: (s: OnlineState) => OnlineState) => void;
  selectRequest: string[] | null;
  peek: PeekResult | null;
  onClosePeek: () => void;
  onPeekTaken: (id: string) => void;
  reveal: { by: Seat; templateId: string } | null;
  onCloseReveal: () => void;
  onReloadLibrary: () => void;
  onLeave: () => void;
  confirm: (title: string, message: string, onConfirm: () => void) => void;
  toast: (message: string) => void;
}

// Lo que se está arrastrando
type DragSource =
  | { kind: 'hand'; id: string; templateId: string; back: CardBackInfo }
  | { kind: 'library'; back: CardBackInfo }
  | { kind: 'play'; id: string; side: SideKey; card: OnlinePlayCard }
  | { kind: 'graveyard'; id: string; side: SideKey; back: CardBackInfo }
  | { kind: 'token'; id: string };

interface DragState {
  src: DragSource;
  startX: number; // pantalla
  startY: number;
  grabX: number; // desplazamiento lógico desde la esquina del objeto
  grabY: number;
  x: number; // posición lógica del puntero
  y: number;
  moved: boolean;
  shift: boolean;
}

const TOP_BAR_H = 52;
const ZONE_LABEL: Record<ZoneKey, string> = { library: 'Biblioteca', hand: 'Mano', play: 'Zona de juego', graveyard: 'Cementerio' };

const backKey = (b: CardBackInfo) => `${b.backType}-${b.deckId}`;

export const OnlineTable: React.FC<OnlineTableProps> = ({
  state,
  status,
  library,
  serverUrl,
  send,
  patchState,
  selectRequest,
  peek,
  onClosePeek,
  onPeekTaken,
  reveal,
  onCloseReveal,
  onReloadLibrary,
  onLeave,
  confirm,
  toast,
}) => {
  const me = state.you;
  const opp: Seat = me === 'p1' ? 'p2' : 'p1';
  const myInfo = state.players[me];
  const oppInfo = state.players[opp];

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [playFaceUp, setPlayFaceUp] = useState(true);
  const [showLog, setShowLog] = useState(false);
  const [chatText, setChatText] = useState('');
  const [seenLog, setSeenLog] = useState(state.log.length);
  const [hoverTemplate, setHoverTemplate] = useState<{ cardId: string; templateId: string; side: 'left' | 'right' } | null>(null);
  const [hoverHandId, setHoverHandId] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const areaRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState({ scale: 1, left: 0, top: 0 });

  // ---------- Escalado: la mesa lógica 1600x900 ocupa todo lo posible ----------

  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      const scale = Math.min(w / BOARD_W, h / BOARD_H);
      setFit({ scale, left: (w - BOARD_W * scale) / 2, top: (h - BOARD_H * scale) / 2 });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const toBoard = useCallback(
    (clientX: number, clientY: number) => {
      const rect = boardRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return { x: (clientX - rect.left) / fit.scale, y: (clientY - rect.top) / fit.scale };
    },
    [fit.scale],
  );

  // ---------- Datos derivados ----------

  const templateMap = useMemo(() => new Map<string, CardTemplate>(library.templates.map((t) => [t.id, t])), [library.templates]);
  const myPlay = state.me.play;
  const selectedCard = myPlay.find((c) => c.id === selectedId) || null;

  useEffect(() => {
    if (selectedId && !myPlay.some((c) => c.id === selectedId)) setSelectedId(null);
  }, [myPlay, selectedId]);

  useEffect(() => {
    if (selectRequest && selectRequest.length) setSelectedId(selectRequest[selectRequest.length - 1]);
  }, [selectRequest]);

  useEffect(() => {
    if (showLog) {
      setSeenLog(state.log.length);
      logEndRef.current?.scrollIntoView({ block: 'end' });
    }
  }, [state.log, showLog]);

  // ---------- Acciones ----------

  const draw = () => send({ t: 'draw', count: 1 });
  const flip = () => selectedCard && send({ t: 'flip', id: selectedCard.id });
  const rotate = (deg: number) => selectedCard && send({ t: 'rotate', id: selectedCard.id, deg });
  const moveSelected = (to: ZoneKey) => {
    if (!selectedCard) return;
    send({ t: 'move', id: selectedCard.id, to });
    setSelectedId(null);
  };
  const setLife = (value: number) => {
    const v = clamp(value, LIFE_MIN, LIFE_MAX);
    patchState((s) => ({ ...s, life: { ...s.life, me: v } }));
    send({ t: 'life', value: v });
  };
  const addToken = () => {
    const r = zoneRect('me', 'play');
    const n = state.tokens.length % 8;
    send({ t: 'tokenAdd', x: r.x + r.w / 2 - TOKEN_SIZE / 2 + n * 12, y: r.y + 20 + n * 6 });
  };

  // Teclado
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const k = e.key.toLowerCase();
    if (k === 'r') draw();
    else if (k === 'f') flip();
    else if (k === 'q') rotate(-90);
    else if (k === 'e') rotate(90);
    else if (k === 'h') moveSelected('hand');
    else if (k === 'g' || k === 'delete' || k === 'backspace') moveSelected('graveyard');
    else if (k === 'escape') setSelectedId(null);
    else return;
    e.preventDefault();
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // ---------- Arrastrar ----------

  const startDrag = (e: React.PointerEvent, src: DragSource, itemX: number, itemY: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const p = toBoard(e.clientX, e.clientY);
    const d: DragState = { src, startX: e.clientX, startY: e.clientY, grabX: p.x - itemX, grabY: p.y - itemY, x: p.x, y: p.y, moved: false, shift: e.shiftKey };
    dragRef.current = d;
    setDrag(d);
  };

  const dropRef = useRef<(d: DragState) => void>(() => {});
  dropRef.current = (d: DragState) => {
    const { src } = d;
    if (!d.moved) {
      // Clic sin arrastrar
      if (src.kind === 'library') draw();
      else if (src.kind === 'play' && src.side === 'me') setSelectedId(src.id);
      return;
    }
    const left = d.x - d.grabX;
    const top = d.y - d.grabY;

    if (src.kind === 'token') {
      const x = clamp(left, 0, BOARD_W - TOKEN_SIZE);
      const y = clamp(top, 0, BOARD_H - TOKEN_SIZE);
      patchState((s) => ({ ...s, tokens: s.tokens.map((t) => (t.id === src.id ? { ...t, x, y } : t)) }));
      send({ t: 'tokenMove', id: src.id, x, y });
      return;
    }

    const zones: ZoneKey[] = ['play', 'hand', 'graveyard', 'library'];
    const to = zones.find((z) => inRect(zoneRect('me', z), d.x, d.y));
    if (!to) return; // fuera de tus zonas: la carta vuelve a su sitio

    const ref = src.kind === 'library' ? { from: 'library' } : { id: src.id };

    if (to === 'play') {
      const r = zoneRect('me', 'play');
      const x = clamp(left - r.x, 0, PLAY_W - CARD_W);
      const y = clamp(top - r.y, 0, PLAY_H - CARD_H);
      if (src.kind === 'play' && src.side === 'me') {
        // Reordenar dentro de tu zona: se ve al instante
        patchState((s) => ({
          ...s,
          me: { ...s.me, play: s.me.play.map((c) => (c.id === src.id ? { ...c, x, y, order: Math.max(0, ...s.me.play.map((k) => k.order)) + 1 } : c)) },
        }));
        setSelectedId(src.id);
        send({ t: 'move', id: src.id, to: 'play', x, y });
        return;
      }
      let faceUp: boolean | undefined;
      if (src.kind === 'hand') faceUp = d.shift ? !playFaceUp : playFaceUp;
      if (src.kind === 'library') faceUp = d.shift;
      send({ t: 'move', ...ref, to: 'play', x, y, faceUp });
      return;
    }

    if (to === 'hand' && src.kind === 'hand') {
      // Reordenar la mano según dónde se suelte
      const ids = state.hand.map((c) => c.id).filter((id) => id !== src.id);
      const slots = handSlots(state.hand.length, zoneRect('me', 'hand'));
      let index = slots.filter((sx) => sx + CARD_W / 2 < d.x).length;
      index = clamp(index, 0, ids.length);
      ids.splice(index, 0, src.id);
      patchState((s) => ({ ...s, hand: ids.map((id) => s.hand.find((c) => c.id === id)!).filter(Boolean) }));
      send({ t: 'handOrder', ids });
      return;
    }
    if (to === 'graveyard' && src.kind === 'graveyard' && src.side === 'me') return;
    if (to === 'library' && src.kind === 'library') return;
    send({ t: 'move', ...ref, to });
  };

  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const p = toBoard(e.clientX, e.clientY);
      const moved = d.moved || Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > 5;
      const next = { ...d, x: p.x, y: p.y, moved, shift: e.shiftKey };
      dragRef.current = next;
      setDrag(next);
    };
    const up = (e: PointerEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (d && e.type === 'pointerup') dropRef.current({ ...d, shift: e.shiftKey });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [dragging, toBoard]);

  const isDragged = (kind: DragSource['kind'], id?: string) =>
    !!drag && drag.moved && drag.src.kind === kind && (id === undefined || ('id' in drag.src && drag.src.id === id));

  const showPreview = (cardId: string, templateId: string | undefined, boardX: number) => {
    if (!templateId || drag) return;
    setHoverTemplate({ cardId, templateId, side: boardX > BOARD_W / 2 ? 'left' : 'right' });
  };
  const hidePreview = () => setHoverTemplate(null);

  // ---------- Pintado de cartas ----------

  const cardImage = (templateId: string | undefined, back: CardBackInfo, faceUp: boolean) => {
    const t = faceUp && templateId ? templateMap.get(templateId) : undefined;
    if (t) {
      return t.imageUrl ? (
        <img src={t.imageUrl} alt={t.name} draggable={false} style={imgStyle} />
      ) : (
        <div style={{ ...imgStyle, background: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, padding: 6, textAlign: 'center' }}>
          {t.name}
        </div>
      );
    }
    const url = library.backs[backKey(back)];
    return url ? (
      <img src={url} alt="Reverso" draggable={false} style={imgStyle} />
    ) : (
      <div className="card-back-pattern" style={{ ...imgStyle }}>
        <span className="card-back-logo" style={{ fontSize: 24 }}>
          AD
        </span>
      </div>
    );
  };

  const zoneBox = (side: SideKey, zone: ZoneKey, label: string) => {
    const r = zoneRect(side, zone);
    const target = !!drag && drag.moved && drag.src.kind !== 'token' && side === 'me';
    return (
      <div
        key={`${side}-${zone}`}
        style={{
          position: 'absolute',
          left: r.x + 4,
          top: r.y + 4,
          width: r.w - 8,
          height: r.h - 8,
          borderRadius: 14,
          border: `2px ${target ? 'dashed' : 'solid'} ${target ? 'rgba(250, 204, 21, 0.7)' : side === 'me' ? 'rgba(129, 140, 248, 0.35)' : 'rgba(248, 113, 113, 0.3)'}`,
          background: zone === 'play' ? (side === 'me' ? 'rgba(79, 70, 229, 0.07)' : 'rgba(220, 38, 38, 0.06)') : 'rgba(0, 0, 0, 0.22)',
          pointerEvents: 'none',
        }}
      >
        <span
          style={{
            position: 'absolute',
            left: 10,
            [side === 'me' ? 'top' : 'bottom']: 6,
            fontSize: 13,
            fontWeight: 600,
            letterSpacing: 0.5,
            textTransform: 'uppercase',
            color: 'rgba(255,255,255,0.35)',
          }}
        >
          {label}
        </span>
      </div>
    );
  };

  // Biblioteca (montón boca abajo)
  const libraryPile = (side: SideKey) => {
    const lib = (side === 'me' ? state.me : state.opp).library;
    const r = zoneRect(side, 'library');
    const cx = r.x + (r.w - CARD_W) / 2;
    const cy = r.y + (side === 'me' ? 26 : r.h - 26 - CARD_H);
    const top = lib.top;
    return (
      <React.Fragment key={`lib-${side}`}>
        {top && (
          <div
            title={side === 'me' ? 'Clic: robar · Arrastrar: coger la carta de arriba' : undefined}
            onPointerDown={side === 'me' ? (e) => startDrag(e, { kind: 'library', back: top }, cx, cy) : undefined}
            style={{
              position: 'absolute',
              left: cx,
              top: cy,
              width: CARD_W,
              height: CARD_H,
              cursor: side === 'me' ? 'grab' : 'default',
              boxShadow: `${Math.min(lib.count, 8)}px ${Math.min(lib.count, 8)}px 0 rgba(0,0,0,0.45)`,
              borderRadius: 8,
              zIndex: 5,
            }}
          >
            {cardImage(undefined, top, false)}
          </div>
        )}
        <div style={{ ...pileCount, left: r.x + r.w - 46, top: side === 'me' ? r.y + 30 : r.y + r.h - 54 }}>{lib.count}</div>
        {side === 'me' && (
          <div style={{ position: 'absolute', left: r.x + r.w - 50, top: r.y + 64, display: 'flex', flexDirection: 'column', gap: 6, zIndex: 6 }}>
            <button className="btn-secondary" style={pileBtn} title="Barajar tu biblioteca" onClick={() => send({ t: 'shuffleLibrary' })} disabled={!lib.count}>
              <Shuffle size={16} />
            </button>
            <button className="btn-secondary" style={pileBtn} title="Mirar tu biblioteca (el rival verá que lo haces)" onClick={() => send({ t: 'peek', zone: 'library' })} disabled={!lib.count}>
              <Search size={16} />
            </button>
          </div>
        )}
      </React.Fragment>
    );
  };

  // Cementerio: boca abajo, girado 90º a la izquierda, la última arriba
  const graveyardPile = (side: SideKey) => {
    const list = (side === 'me' ? state.me : state.opp).graveyard;
    const r = zoneRect(side, 'graveyard');
    const shown = list.slice(-4);
    // La carta girada ocupa 158x100: centrada en horizontal y pegada al lado del dueño
    const centerY = side === 'me' ? r.y + 86 : r.y + r.h - 86;
    const baseX = r.x + (r.w - CARD_W) / 2;
    const baseY = centerY - CARD_H / 2;
    return (
      <React.Fragment key={`grave-${side}`}>
        {shown.map((c, i) => {
          const isTop = i === shown.length - 1;
          const x = baseX + i * 3;
          const y = baseY - i * 3;
          return (
            <div
              key={c.id}
              onPointerDown={isTop ? (e) => startDrag(e, { kind: 'graveyard', id: c.id, side, back: c }, x, y) : undefined}
              title={isTop ? 'Arrastra la carta de arriba para cogerla' : undefined}
              style={{
                position: 'absolute',
                left: x,
                top: y,
                width: CARD_W,
                height: CARD_H,
                transform: 'rotate(-90deg)',
                borderRadius: 8,
                cursor: isTop ? 'grab' : 'default',
                opacity: isTop && isDragged('graveyard', c.id) ? 0.25 : 1,
                boxShadow: '0 2px 6px rgba(0,0,0,0.5)',
                zIndex: 5 + i,
              }}
            >
              {cardImage(undefined, c, false)}
            </div>
          );
        })}
        <div style={{ ...pileCount, left: r.x + 14, top: side === 'me' ? r.y + 146 : r.y + 18 }}>{list.length}</div>
        {side === 'me' && list.length > 0 && (
          <button
            className="btn-secondary"
            style={{ ...pileBtn, position: 'absolute', left: r.x + r.w - 50, top: r.y + 142, zIndex: 12 }}
            title="Ver tu cementerio (el rival verá que lo haces)"
            onClick={() => send({ t: 'peek', zone: 'graveyard' })}
          >
            <Search size={16} />
          </button>
        )}
      </React.Fragment>
    );
  };

  const playCards = (side: SideKey) =>
    (side === 'me' ? state.me : state.opp).play.map((c) => {
      const pos = playCardPos(side, c.x, c.y);
      const selected = side === 'me' && c.id === selectedId;
      return (
        <div
          key={c.id}
          onPointerDown={(e) => startDrag(e, { kind: 'play', id: c.id, side, card: c }, pos.x, pos.y)}
          onPointerEnter={() => c.isFaceUp && showPreview(c.id, c.templateId, pos.x)}
          onPointerLeave={hidePreview}
          onDoubleClick={() => side === 'me' && send({ t: 'flip', id: c.id })}
          style={{
            position: 'absolute',
            left: pos.x,
            top: pos.y,
            width: CARD_W,
            height: CARD_H,
            transform: `rotate(${c.rotation}deg)`,
            transition: 'transform 0.15s ease',
            borderRadius: 8,
            zIndex: 20 + (c.order % 100000),
            cursor: 'grab',
            opacity: isDragged('play', c.id) ? 0.25 : 1,
            boxShadow: selected ? '0 0 0 3px #facc15, 0 6px 16px rgba(0,0,0,0.6)' : '0 4px 10px rgba(0,0,0,0.5)',
          }}
        >
          {cardImage(c.templateId, c, c.isFaceUp)}
        </div>
      );
    });

  const myHand = () => {
    const r = zoneRect('me', 'hand');
    const slots = handSlots(state.hand.length, r);
    const y = r.y + (r.h - CARD_H) / 2 + 6;
    return state.hand.map((c, i) => {
      const hovered = hoverHandId === c.id && !drag;
      return (
        <div
          key={c.id}
          onPointerDown={(e) => startDrag(e, { kind: 'hand', id: c.id, templateId: c.templateId, back: c }, slots[i], y)}
          onPointerEnter={() => {
            setHoverHandId(c.id);
            showPreview(c.id, c.templateId, slots[i]);
          }}
          onPointerLeave={() => {
            setHoverHandId((h) => (h === c.id ? null : h));
            hidePreview();
          }}
          style={{
            position: 'absolute',
            left: slots[i],
            top: y - (hovered ? 14 : 0),
            width: CARD_W,
            height: CARD_H,
            borderRadius: 8,
            zIndex: hovered ? 900 : 300 + i,
            cursor: 'grab',
            transition: 'top 0.12s ease',
            opacity: isDragged('hand', c.id) ? 0.25 : 1,
            boxShadow: '0 4px 10px rgba(0,0,0,0.55)',
          }}
        >
          {cardImage(c.templateId, c, true)}
          {hovered && (
            <button
              className="btn-secondary"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => send({ t: 'reveal', id: c.id })}
              title="Enseñar esta carta al rival sin jugarla"
              style={{ position: 'absolute', left: '50%', bottom: -2, transform: 'translate(-50%, 50%)', padding: '3px 8px', fontSize: 12 }}
            >
              <Eye size={12} /> Enseñar
            </button>
          )}
        </div>
      );
    });
  };

  const oppHand = () => {
    const r = zoneRect('opp', 'hand');
    const slots = handSlots(state.oppHand.length, r);
    const y = r.y + (r.h - CARD_H) / 2 - 6;
    return state.oppHand.map((c, i) => (
      <div key={i} style={{ position: 'absolute', left: slots[i], top: y, width: CARD_W, height: CARD_H, zIndex: 300 + i, borderRadius: 8, boxShadow: '0 4px 10px rgba(0,0,0,0.5)' }}>
        {cardImage(undefined, c, false)}
      </div>
    ));
  };

  const lifePanel = (side: SideKey) => {
    const mine = side === 'me';
    const value = mine ? state.life.me : state.life.opp;
    const info = mine ? myInfo : oppInfo;
    const x = mine ? 0 : BOARD_W - SIDE_W;
    const y = mine ? BOARD_H / 2 : 0;
    return (
      <div
        key={`life-${side}`}
        style={{
          position: 'absolute',
          left: x + 10,
          top: y + 10,
          width: SIDE_W - 20,
          height: BOARD_H / 2 - 20,
          borderRadius: 16,
          background: mine ? 'rgba(79, 70, 229, 0.14)' : 'rgba(220, 38, 38, 0.12)',
          border: `2px solid ${mine ? 'rgba(129, 140, 248, 0.4)' : 'rgba(248, 113, 113, 0.35)'}`,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          color: '#fff',
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, textAlign: 'center', padding: '0 6px', wordBreak: 'break-word' }}>
          {info ? info.name : 'Esperando rival…'}
          {mine ? ' (tú)' : ''}
        </div>
        {info && !mine && (info.left || !info.connected) && (
          <div style={{ fontSize: 12, color: 'var(--color-danger)' }}>{info.left ? 'ha salido' : 'desconectado'}</div>
        )}
        <div style={{ fontSize: 13, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>Vida</div>
        {mine && (
          <button className="btn-secondary" style={lifeBtn} onClick={() => setLife(value + 1)} disabled={value >= LIFE_MAX} title="Sumar vida">
            <Plus size={20} />
          </button>
        )}
        <div style={{ fontSize: 64, fontWeight: 800, lineHeight: 1 }}>{value}</div>
        {mine && (
          <button className="btn-secondary" style={lifeBtn} onClick={() => setLife(value - 1)} disabled={value <= LIFE_MIN} title="Restar vida">
            <Minus size={20} />
          </button>
        )}
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{(mine ? state.hand.length : state.opp.handCount)} en mano</div>
      </div>
    );
  };

  // Fantasma de lo que se arrastra
  const ghost = () => {
    if (!drag || !drag.moved) return null;
    const left = drag.x - drag.grabX;
    const top = drag.y - drag.grabY;
    const { src } = drag;
    if (src.kind === 'token') return null;
    let content: React.ReactNode;
    let rotation = 0;
    if (src.kind === 'hand') content = cardImage(src.templateId, src.back, drag.shift ? !playFaceUp : playFaceUp);
    else if (src.kind === 'library') content = cardImage(undefined, src.back, false);
    else if (src.kind === 'graveyard') content = cardImage(undefined, src.back, false);
    else {
      content = cardImage(src.card.templateId, src.card, src.card.isFaceUp);
      rotation = src.card.rotation;
    }
    return (
      <div
        style={{
          position: 'absolute',
          left,
          top,
          width: CARD_W,
          height: CARD_H,
          zIndex: 500000,
          pointerEvents: 'none',
          transform: `rotate(${rotation}deg) scale(1.05)`,
          borderRadius: 8,
          boxShadow: '0 14px 30px rgba(0,0,0,0.7)',
        }}
      >
        {content}
      </div>
    );
  };

  const tokens = state.tokens.map((t) => {
    const dragged = drag && drag.moved && drag.src.kind === 'token' && drag.src.id === t.id;
    const x = dragged ? clamp(drag.x - drag.grabX, 0, BOARD_W - TOKEN_SIZE) : t.x;
    const y = dragged ? clamp(drag.y - drag.grabY, 0, BOARD_H - TOKEN_SIZE) : t.y;
    return (
      <div
        key={t.id}
        title="Token · arrastrar para mover · doble clic para quitar"
        onPointerDown={(e) => startDrag(e, { kind: 'token', id: t.id }, t.x, t.y)}
        onDoubleClick={() => send({ t: 'tokenDelete', id: t.id })}
        onContextMenu={(e) => {
          e.preventDefault();
          send({ t: 'tokenDelete', id: t.id });
        }}
        style={{
          position: 'absolute',
          left: x,
          top: y,
          width: TOKEN_SIZE,
          height: TOKEN_SIZE,
          borderRadius: '50%',
          background: '#facc15',
          border: '3px solid #000',
          boxShadow: '0 3px 8px rgba(0,0,0,0.6)',
          cursor: 'grab',
          zIndex: 400000,
        }}
      />
    );
  });

  // ---------- Barra superior ----------

  const copyInvite = async () => {
    const link = inviteLink(serverUrl, state.code);
    try {
      await navigator.clipboard.writeText(link);
      toast('Enlace de invitación copiado');
    } catch {
      toast(link);
    }
  };

  const sendChat = (e: React.FormEvent) => {
    e.preventDefault();
    const text = chatText.trim();
    if (!text) return;
    send({ t: 'chat', text });
    setChatText('');
  };

  const myCardsInGame = state.me.library.count + state.hand.length + state.me.graveyard.length + state.me.play.length > 0;
  const unread = showLog ? 0 : Math.max(0, state.log.length - seenLog);
  const btn: React.CSSProperties = { padding: '6px 10px', fontSize: '0.78rem' };
  // La vista ampliada solo se muestra si la carta sigue donde estaba (y boca arriba)
  const hoverStillThere =
    !!hoverTemplate &&
    !drag &&
    (state.hand.some((c) => c.id === hoverTemplate.cardId) ||
      [...state.me.play, ...state.opp.play].some((c) => c.id === hoverTemplate.cardId && c.isFaceUp));
  const previewTemplate = hoverStillThere ? templateMap.get(hoverTemplate!.templateId) : undefined;

  return (
    <div style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', userSelect: 'none' }}>
      {/* Barra superior */}
      <div
        className="glass-panel"
        style={{
          minHeight: TOP_BAR_H,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          borderRadius: 0,
          flexWrap: 'wrap',
          zIndex: 10,
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Sala</span>
          <span style={{ fontSize: '1.1rem', fontWeight: 700, letterSpacing: 3 }}>{state.code}</span>
        </div>
        <button className="btn-secondary" onClick={copyInvite} title="Copiar enlace de invitación" style={btn}>
          <Copy size={13} /> Invitar
        </button>
        <div style={{ width: 1, height: 24, background: 'var(--glass-border)' }} />
        <select
          value={myInfo?.deckId || ''}
          onChange={(e) => send({ t: 'chooseDeck', deckId: e.target.value })}
          style={{
            background: 'rgba(0,0,0,0.35)',
            color: '#fff',
            border: '1px solid var(--glass-border)',
            borderRadius: 6,
            padding: '6px',
            fontSize: '0.78rem',
            fontFamily: 'var(--font-family)',
            maxWidth: 200,
          }}
        >
          <option value="" disabled>
            {Object.keys(library.deckNames).length ? 'Elige tu mazo…' : 'No hay mazos publicados'}
          </option>
          {Object.entries(library.deckNames).map(([id, name]) => (
            <option key={id} value={id}>
              {name} ({library.templates.filter((t) => t.deckId === id).reduce((s, t) => s + (t.quantity || 1), 0)})
            </option>
          ))}
        </select>
        <button className="btn-secondary" onClick={onReloadLibrary} title="Recargar mazos del servidor" style={{ padding: '6px 8px' }}>
          <RefreshCw size={13} />
        </button>
        <button
          className="btn-primary"
          disabled={!myInfo?.deckId}
          onClick={() => {
            const doSpawn = () => send({ t: 'spawnDeck' });
            if (myCardsInGame)
              confirm('Volver a poner el mazo', 'Se retirarán todas tus cartas (biblioteca, mano, mesa y cementerio) y tu mazo se barajará de nuevo en la biblioteca. ¿Seguro?', doSpawn);
            else doSpawn();
          }}
          style={{ ...btn, opacity: myInfo?.deckId ? 1 : 0.5 }}
        >
          <Layers size={13} /> Poner mazo
        </button>
        <button className="btn-secondary" onClick={() => setPlayFaceUp((v) => !v)} title="Cómo se juegan las cartas de la mano (Mayús al soltar lo invierte)" style={btn}>
          {playFaceUp ? <Eye size={13} /> : <EyeOff size={13} />} {playFaceUp ? 'Jugar boca arriba' : 'Jugar boca abajo'}
        </button>
        <button className="btn-secondary" onClick={addToken} title="Añadir un token a la mesa" style={btn}>
          <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#facc15', border: '2px solid #000', display: 'inline-block' }} /> Token
        </button>

        {selectedCard && (
          <>
            <div style={{ width: 1, height: 24, background: 'var(--glass-border)' }} />
            <button className="btn-secondary" onClick={flip} title="Voltear (F)" style={btn}>
              <Eye size={13} /> Voltear
            </button>
            <button className="btn-secondary" onClick={() => rotate(-90)} title="Girar a la izquierda (Q)" style={btn}>
              <RotateCcw size={13} />
            </button>
            <button className="btn-secondary" onClick={() => rotate(90)} title="Girar a la derecha (E)" style={btn}>
              <RotateCw size={13} />
            </button>
            <button className="btn-secondary" onClick={() => moveSelected('hand')} title="A la mano (H)" style={btn}>
              <Hand size={13} /> Mano
            </button>
            <button className="btn-secondary" onClick={() => moveSelected('graveyard')} title="Al cementerio (G)" style={btn}>
              <Archive size={13} /> Cementerio
            </button>
          </>
        )}

        <div style={{ flex: 1 }} />
        <button className="btn-secondary" onClick={() => setShowLog((v) => !v)} style={{ ...btn, position: 'relative' }}>
          <MessageSquare size={13} /> Chat
          {unread > 0 && <span style={{ marginLeft: 4, background: 'var(--color-accent)', borderRadius: 10, padding: '0 6px', fontSize: '0.7rem' }}>{unread}</span>}
        </button>
        <button
          className="btn-secondary"
          onClick={() =>
            confirm('Reiniciar mesa', 'Se retirarán todas las cartas y tokens de los dos jugadores y las vidas volverán a 10. ¿Seguro?', () => send({ t: 'reset' }))
          }
          style={btn}
        >
          Reiniciar
        </button>
        <button className="btn-danger" onClick={onLeave} style={btn}>
          <LogOut size={13} /> Salir
        </button>
      </div>

      {/* Mesa escalada */}
      <div ref={areaRef} style={{ flex: 1, position: 'relative', overflow: 'hidden' }} onPointerDown={() => setSelectedId(null)}>
        <div
          ref={boardRef}
          style={{
            position: 'absolute',
            left: fit.left,
            top: fit.top,
            width: BOARD_W,
            height: BOARD_H,
            transform: `scale(${fit.scale})`,
            transformOrigin: '0 0',
            background: 'radial-gradient(ellipse at center, #1b2440 0%, #0b1020 75%)',
            borderRadius: 18,
            boxShadow: '0 0 0 1px rgba(255,255,255,0.06)',
          }}
        >
          {(['opp', 'me'] as SideKey[]).flatMap((side) =>
            (['library', 'hand', 'graveyard', 'play'] as ZoneKey[]).map((zone) =>
              zoneBox(side, zone, zone === 'play' ? `${ZONE_LABEL.play}${side === 'opp' && oppInfo ? ` · ${oppInfo.name}` : side === 'me' ? ' · tú' : ''}` : ZONE_LABEL[zone]),
            ),
          )}
          <div style={{ position: 'absolute', left: SIDE_W, top: BOARD_H / 2 - 1, width: PLAY_W, height: 2, background: 'rgba(255,255,255,0.12)' }} />
          {lifePanel('opp')}
          {lifePanel('me')}
          {libraryPile('opp')}
          {libraryPile('me')}
          {graveyardPile('opp')}
          {graveyardPile('me')}
          {oppHand()}
          {myHand()}
          {playCards('opp')}
          {playCards('me')}
          {tokens}
          {ghost()}
          {!myCardsInGame && (
            <div style={{ position: 'absolute', left: SIDE_W, top: BOARD_H / 2 + 90, width: PLAY_W, textAlign: 'center', color: 'rgba(255,255,255,0.45)', fontSize: 20, pointerEvents: 'none' }}>
              {myInfo?.deckId ? 'Pulsa "Poner mazo" para barajar tu mazo en la biblioteca' : 'Elige tu mazo arriba y pulsa "Poner mazo"'}
            </div>
          )}
        </div>

        {/* Vista ampliada de la carta bajo el ratón */}
        {previewTemplate?.imageUrl && (
          <img
            src={previewTemplate.imageUrl}
            alt={previewTemplate.name}
            style={{
              position: 'absolute',
              top: 12,
              [hoverTemplate!.side]: 12,
              height: 'min(480px, 62%)',
              aspectRatio: `${CARD_W} / ${CARD_H}`,
              objectFit: 'cover',
              borderRadius: 14,
              boxShadow: '0 20px 50px rgba(0,0,0,0.8)',
              pointerEvents: 'none',
              zIndex: 600000,
            }}
          />
        )}

        {/* Registro de la partida y chat */}
        {showLog && (
          <div
            className="glass-panel"
            onPointerDown={(e) => e.stopPropagation()}
            style={{ position: 'absolute', top: 8, right: 8, width: 300, height: 'min(460px, calc(100% - 16px))', display: 'flex', flexDirection: 'column', zIndex: 700000 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', padding: '10px 12px', borderBottom: '1px solid var(--glass-border)', fontSize: '0.8rem', fontWeight: 600 }}>
              <MessageSquare size={14} style={{ marginRight: 6 }} />
              <span style={{ flex: 1 }}>Partida y chat</span>
              <button className="btn-secondary" onClick={() => setShowLog(false)} style={{ padding: 4 }} title="Ocultar">
                <X size={12} />
              </button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 5, userSelect: 'text' }}>
              {state.log.map((entry) => (
                <div
                  key={entry.id}
                  style={{
                    fontSize: '0.75rem',
                    lineHeight: 1.35,
                    color: entry.kind === 'chat' ? '#fff' : entry.kind === 'reveal' ? 'var(--color-accent)' : 'var(--text-muted)',
                  }}
                >
                  <span style={{ opacity: 0.5, marginRight: 4 }}>{new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  {entry.text}
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
            <form onSubmit={sendChat} style={{ display: 'flex', gap: 6, padding: 8, borderTop: '1px solid var(--glass-border)' }}>
              <input
                value={chatText}
                onChange={(e) => setChatText(e.target.value)}
                placeholder="Escribe al rival…"
                maxLength={300}
                style={{
                  flex: 1,
                  background: 'rgba(0,0,0,0.35)',
                  color: '#fff',
                  border: '1px solid var(--glass-border)',
                  borderRadius: 6,
                  padding: '6px 8px',
                  fontSize: '0.8rem',
                  fontFamily: 'var(--font-family)',
                  outline: 'none',
                }}
              />
              <button className="btn-primary" type="submit" style={{ padding: '6px 10px', fontSize: '0.75rem' }}>
                Enviar
              </button>
            </form>
          </div>
        )}

        {status === 'reconnecting' && (
          <div
            className="glass-panel"
            style={{ position: 'absolute', top: '45%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 800000, padding: '14px 22px', fontSize: '0.9rem' }}
          >
            Conexión perdida. Reconectando…
          </div>
        )}
      </div>

      {/* Mirar biblioteca o cementerio propios */}
      {peek && (
        <Overlay onClose={onClosePeek}>
          <h3 style={{ fontSize: '1.05rem', fontWeight: 700, marginBottom: 4 }}>
            {peek.zone === 'library' ? 'Tu biblioteca' : 'Tu cementerio'}: {peek.cards.length} {peek.cards.length === 1 ? 'carta' : 'cartas'} (de arriba a abajo)
          </h3>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 14 }}>
            Solo tú las ves; tu rival sabe que las estás mirando. Puedes coger cualquiera a tu mano.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, maxHeight: '60vh', overflowY: 'auto', justifyContent: 'center' }}>
            {peek.cards.map((c) => {
              const t = templateMap.get(c.templateId);
              return (
                <div key={c.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                  {t?.imageUrl ? (
                    <img src={t.imageUrl} alt={c.name} style={{ width: 120, height: 190, objectFit: 'cover', borderRadius: 10 }} />
                  ) : (
                    <div style={{ width: 120, height: 190, borderRadius: 10, background: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem' }}>
                      {c.name}
                    </div>
                  )}
                  <button
                    className="btn-secondary"
                    style={{ padding: '4px 10px', fontSize: '0.72rem' }}
                    onClick={() => {
                      send({ t: 'takeFromPeek', id: c.id });
                      onPeekTaken(c.id);
                    }}
                  >
                    <Hand size={12} /> A mi mano
                  </button>
                </div>
              );
            })}
          </div>
          {peek.zone === 'library' && (
            <button
              className="btn-primary"
              style={{ marginTop: 16, padding: '8px 16px', fontSize: '0.85rem' }}
              onClick={() => {
                send({ t: 'shuffleLibrary' });
                onClosePeek();
              }}
            >
              <Shuffle size={14} /> Barajar y cerrar
            </button>
          )}
        </Overlay>
      )}

      {/* Carta enseñada por el rival */}
      {reveal && reveal.by !== me && (
        <Overlay onClose={onCloseReveal}>
          <h3 style={{ fontSize: '1.05rem', fontWeight: 700, marginBottom: 12 }}>{oppInfo?.name || 'Tu rival'} te enseña una carta de su mano</h3>
          {templateMap.get(reveal.templateId)?.imageUrl ? (
            <img src={templateMap.get(reveal.templateId)!.imageUrl} alt="" style={{ width: 260, height: 412, objectFit: 'cover', borderRadius: 14, display: 'block', margin: '0 auto' }} />
          ) : (
            <p>{templateMap.get(reveal.templateId)?.name || 'Carta'}</p>
          )}
        </Overlay>
      )}
    </div>
  );
};

// Posiciones x de las cartas de una mano dentro de su zona (se solapan si no caben)
function handSlots(n: number, r: Rect): number[] {
  if (n === 0) return [];
  const pad = 16;
  const avail = r.w - pad * 2;
  const step = n === 1 ? 0 : Math.min(CARD_W + 8, (avail - CARD_W) / (n - 1));
  const total = CARD_W + step * (n - 1);
  const start = r.x + (r.w - total) / 2;
  return Array.from({ length: n }, (_, i) => start + i * step);
}

const imgStyle: React.CSSProperties = {
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  borderRadius: 8,
  display: 'block',
  pointerEvents: 'none',
};

const pileCount: React.CSSProperties = {
  position: 'absolute',
  minWidth: 36,
  padding: '2px 8px',
  borderRadius: 12,
  background: 'rgba(0,0,0,0.6)',
  color: '#fff',
  fontSize: 15,
  fontWeight: 700,
  textAlign: 'center',
  zIndex: 15,
  pointerEvents: 'none',
};

const pileBtn: React.CSSProperties = { padding: 6, width: 36, height: 36, justifyContent: 'center' };
const lifeBtn: React.CSSProperties = { padding: 8, width: 52, height: 40, justifyContent: 'center' };

const Overlay: React.FC<{ onClose: () => void; children: React.ReactNode }> = ({ onClose, children }) => (
  <div
    onPointerDown={onClose}
    style={{
      position: 'fixed',
      inset: 0,
      background: 'rgba(5, 8, 16, 0.75)',
      backdropFilter: 'blur(6px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 900000,
    }}
  >
    <div
      className="glass-panel"
      onPointerDown={(e) => e.stopPropagation()}
      style={{ maxWidth: 'min(900px, 92vw)', padding: '22px 44px', borderRadius: 16, position: 'relative', textAlign: 'center' }}
    >
      <button className="btn-secondary" onClick={onClose} style={{ position: 'absolute', top: 10, right: 10, padding: 4 }}>
        <X size={14} />
      </button>
      {children}
    </div>
  </div>
);
