import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  BookOpen,
  Copy,
  Eye,
  EyeOff,
  Globe,
  History,
  Hand,
  Layers,
  Maximize,
  Menu,
  Minimize,
  LogOut,
  MessageSquare,
  RefreshCw,
  Shuffle,
  Trophy,
  X,
} from 'lucide-react';
import type { CardTemplate } from '../types';
import type { CardBackInfo, MatchResult, OnlinePlayCard, OnlineState, PeekResult, Seat, ServerLibrary } from './types';
import {
  BOARD_H,
  BOARD_W,
  CARD_H,
  CARD_W,
  LIFE_CARD_RATIO,
  LIFE_TRACK,
  LIFE_MAX,
  LIFE_MIN,
  PLAY_H,
  PLAY_W,
  SIDE_W,
  SMALL_H,
  SMALL_W,
  TOKEN_SIZE,
  clamp,
  inRect,
  makeLayout,
  zoneRect as stdZoneRect,
  type Rect,
  type SideKey,
  type ZoneKey,
} from './layout';
import { inviteLink } from './server';
import { MatchHistory } from './MatchHistory';
import { IOS_FULLSCREEN_HINT, fullscreenSupported, toggleFullscreen, useIsFullscreen } from '../fullscreen';
import { appPoint, appRect } from '../rotation';
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
  // Modo un jugador: se controlan los dos lados de la mesa y se ven las dos manos
  solo?: boolean;
  localResults?: () => MatchResult[];
  onOpenOnline?: () => void;
}

// Lo que se está arrastrando
type DragSource =
  | { kind: 'hand'; id: string; templateId: string; back: CardBackInfo; side: SideKey }
  | { kind: 'library'; back: CardBackInfo; side: SideKey }
  | { kind: 'play'; id: string; side: SideKey; card: OnlinePlayCard }
  | { kind: 'graveyard'; id: string; side: SideKey; back: CardBackInfo }
  | { kind: 'token'; id: string; cardId?: string }
  | { kind: 'view' }; // solo para ampliar con el dedo (mano del rival enseñada)

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
  longPress?: boolean;
  preview?: string; // carta que se ve (para ampliarla al tocar en el móvil)
}


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
  solo = false,
  localResults,
  onOpenOnline,
}) => {
  const me = state.you;
  const opp: Seat = me === 'p1' ? 'p2' : 'p1';
  const myInfo = state.players[me];
  const oppInfo = state.players[opp];
  const seatOf = (side: SideKey): Seat => (side === 'me' ? me : opp);
  const canControl = (side: SideKey) => side === 'me' || solo;
  // En un jugador cada acción se hace con el jugador del lado donde ocurre
  const sendAs = (side: SideKey, msg: object) => send(solo ? { ...msg, as: seatOf(side) } : msg);
  const deckNameOf = (side: SideKey) => {
    const id = state.players[seatOf(side)]?.deckId;
    return id ? library.deckNames[id] : undefined;
  };

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showEnd, setShowEnd] = useState(false);
  const [endReset, setEndReset] = useState(true);
  const [showHistory, setShowHistory] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [chatText, setChatText] = useState('');
  const [seenLog, setSeenLog] = useState(state.log.length);
  const [hoverTemplate, setHoverTemplate] = useState<{ cardId: string; templateId: string } | null>(null);
  const [hoverHandId, setHoverHandId] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const justDropped = useRef(new Map<string, number>());
  // En tablet (pantalla táctil) los controles se hacen más grandes y la vista
  // ampliada se abre manteniendo el dedo sobre la carta
  const isTouch = useMemo(() => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches, []);
  const [pressPreview, setPressPreview] = useState<string | null>(null);
  const pressTimer = useRef<number | undefined>(undefined);
  const [selectedHandId, setSelectedHandId] = useState<string | null>(null);
  const [selectedTokenId, setSelectedTokenId] = useState<string | null>(null);
  const [portrait, setPortrait] = useState(false);

  const areaRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState({ scale: 1, left: 0, top: 0, compact: false });
  // Pantalla pequeña (móvil): la mesa se ve muy reducida, así que el panel y las
  // acciones salen a tamaño normal fuera de la mesa
  const compact = fit.compact;
  // En móvil las zonas de juego se dibujan más bajas (ver layout.ts)
  const L = useMemo(() => makeLayout(compact), [compact]);
  const zoneRect = L.zoneRect;
  const [menuOpen, setMenuOpen] = useState(false);
  const [lifeSel, setLifeSel] = useState<SideKey | null>(null);
  const fullscreen = useIsFullscreen();
  const ui = compact
    ? { font: 15, pad: '8px 10px', icon: 16, pile: 40, life: 36 }
    : isTouch
      ? { font: 19, pad: '10px 12px', icon: 20, pile: 56, life: 52 }
      : { font: 14, pad: '7px 10px', icon: 14, pile: 40, life: 36 };
  const smallBtn: React.CSSProperties = isTouch ? { padding: '6px 12px', fontSize: 16 } : { padding: '3px 10px', fontSize: 13 };
  // Con el dedo, tocar una carta la muestra en grande unos segundos
  const previewTimer = useRef<number | undefined>(undefined);
  // Carta en juego tocada: pasa por delante de las demás (con sus tokens) unos segundos
  const [raisedId, setRaisedId] = useState<string | null>(null);
  const raiseTimer = useRef<number | undefined>(undefined);
  const raiseCard = (id: string) => {
    window.clearTimeout(raiseTimer.current);
    setRaisedId(id);
    raiseTimer.current = window.setTimeout(() => setRaisedId(null), 5000);
  };
  const hidePressPreview = () => {
    window.clearTimeout(previewTimer.current);
    setPressPreview(null);
  };
  const clearSelections = () => {
    setSelectedId(null);
    setSelectedHandId(null);
    setSelectedTokenId(null);
    setLifeSel(null);
  };
  const onFullscreen = async () => {
    if (!fullscreenSupported()) return toast(IOS_FULLSCREEN_HINT);
    if (!(await toggleFullscreen())) toast('El navegador no ha permitido la pantalla completa');
  };

  // ---------- Escalado: la mesa lógica 1920x1080 ocupa todo lo posible ----------

  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      // Pantalla pequeña (móvil): la mesa normal quedaría diminuta
      const compactNow = Math.min(w / BOARD_W, h / BOARD_H) < 0.55;
      const boardH = makeLayout(compactNow).boardH;
      const scale = Math.min(w / BOARD_W, h / boardH);
      setFit({ scale, left: (w - BOARD_W * scale) / 2, top: (h - boardH * scale) / 2, compact: compactNow });
      setPortrait(h > w * 1.1);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const toBoard = useCallback(
    (clientX: number, clientY: number) => {
      if (!boardRef.current) return { x: 0, y: 0 };
      const rect = appRect(boardRef.current);
      const p = appPoint(clientX, clientY);
      return { x: (p.x - rect.left) / fit.scale, y: (p.y - rect.top) / fit.scale };
    },
    [fit.scale],
  );

  // ---------- Cartas que cambian de zona: se deslizan como en una mesa ----------
  // Cada carta lleva data-fid con su id. Tras cada cambio se compara dónde estaba
  // cada carta antes y dónde está ahora; si cambió de zona (otro elemento), la
  // nueva se anima desde la posición anterior. Las que desaparecen hacia la
  // biblioteca o la mano oculta del rival vuelan hasta allí.
  const lastDrop = useRef<{ id?: string; lib?: SideKey; x: number; y: number; w: number; at: number } | null>(null);
  const flipPrev = useRef<{
    pos: Map<string, { x: number; y: number; w: number; el: HTMLElement; side: SideKey; zone: string }>;
    ids: Set<string>;
    lib: Record<SideKey, number>;
    oppHand: number;
  } | null>(null);
  useLayoutEffect(() => {
    const board = boardRef.current;
    if (!board || !fit.scale) return;
    const br = appRect(board);
    const pos = new Map<string, { x: number; y: number; w: number; el: HTMLElement; side: SideKey; zone: string }>();
    board.querySelectorAll<HTMLElement>('[data-fid]').forEach((el) => {
      const r = appRect(el);
      pos.set(el.dataset.fid!, {
        x: (r.left + r.width / 2 - br.left) / fit.scale,
        y: (r.top + r.height / 2 - br.top) / fit.scale,
        w: parseFloat(el.style.width) || SMALL_W,
        el,
        side: el.dataset.side as SideKey,
        zone: el.dataset.zone || '',
      });
    });
    const ids = new Set<string>();
    for (const c of [...state.me.play, ...state.opp.play, ...state.me.graveyard, ...state.opp.graveyard, ...state.hand]) ids.add(c.id);
    for (const c of state.oppHand) if (c.id) ids.add(c.id);
    const lib = { me: state.me.library.count, opp: state.opp.library.count };
    const prev = flipPrev.current;
    flipPrev.current = { pos, ids, lib, oppHand: state.oppHand.length };
    if (!prev) return;

    const libCenter = (side: SideKey) => {
      const r = zoneRect(side, 'library');
      return { x: r.x + 22 + SMALL_W / 2, y: side === 'me' ? r.y + 8 + SMALL_H / 2 : r.y + r.h - 8 - SMALL_H / 2 };
    };
    const oppHandCenter = () => {
      const r = zoneRect('opp', 'hand');
      return { x: r.x + r.w / 2, y: r.y + 8 + SMALL_H / 2 };
    };
    const drop = lastDrop.current && Date.now() - lastDrop.current.at < 2000 ? lastDrop.current : null;
    const timing = { duration: 450, easing: 'cubic-bezier(0.25, 0.8, 0.25, 1)' };

    // El motor cambia el id de una carta al cambiar de zona (para no poder seguirla
    // en zonas ocultas), así que se empareja la carta que desaparece con la que aparece
    const appeared = [...pos].filter(([id]) => !prev.ids.has(id));
    const vanished = [...prev.pos].filter(([id]) => !ids.has(id) && !pos.has(id));
    const pairs = new Map<string, string>();
    if (appeared.length === 1 && vanished.length === 1) pairs.set(appeared[0][0], vanished[0][0]);
    const paired = new Set(pairs.values());

    // Carta recolocada dentro de su zona de juego: se desliza desde donde se soltó
    const same = drop?.id ? pos.get(drop.id) : undefined;
    if (drop && same && same.zone === 'play' && same.el === prev.pos.get(drop.id!)?.el) {
      const dx = drop.x - same.x;
      const dy = drop.y - same.y;
      if (Math.hypot(dx, dy) >= 3) same.el.animate([{ translate: `${dx}px ${dy}px`, zIndex: 500000 }, { translate: '0px 0px', zIndex: 500000 }], timing);
      lastDrop.current = null;
    }

    // Cartas que aparecen en otro sitio
    for (const [id, now] of appeared) {
      const oldId = pairs.get(id);
      let from: { x: number; y: number; w: number; zone: string } | null = null;
      if (drop && ((oldId && drop.id === oldId) || (drop.lib && !oldId))) {
        // Soltada con el dedo o el ratón: sale de donde la dejaste
        from = { ...drop, zone: now.zone };
        lastDrop.current = null;
      } else if (oldId) from = prev.pos.get(oldId)!;
      else if (lib[now.side] < prev.lib[now.side]) from = { ...libCenter(now.side), w: SMALL_W, zone: 'library' };
      else if (!solo && now.side === 'opp' && state.oppHand.length < prev.oppHand) from = { ...oppHandCenter(), w: SMALL_W, zone: 'hand' };
      if (!from) continue;
      const dx = from.x - now.x;
      const dy = from.y - now.y;
      if (Math.hypot(dx, dy) < 3) continue;
      // Sin la animación de entrada: la carta llega volando
      for (const a of now.el.getAnimations()) if (a instanceof CSSAnimation) a.cancel();
      const turn = now.zone === 'graveyard' && from.zone !== 'graveyard' ? '90deg' : '0deg';
      now.el.animate(
        [
          { translate: `${dx}px ${dy}px`, scale: String(from.w / now.w), rotate: turn, zIndex: 500000 },
          { translate: '0px 0px', scale: '1', rotate: '0deg', zIndex: 500000 },
        ],
        timing,
      );
    }

    // Cartas que se van a una biblioteca o a la mano oculta del rival
    for (const [id, before] of vanished) {
      if (paired.has(id)) continue;
      let to: { x: number; y: number } | null = null;
      if (lib[before.side] > prev.lib[before.side]) to = libCenter(before.side);
      else if (lib.me > prev.lib.me) to = libCenter('me');
      else if (lib.opp > prev.lib.opp) to = libCenter('opp');
      else if (!solo && state.oppHand.length > prev.oppHand) to = oppHandCenter();
      if (!to) continue;
      const start = drop && drop.id === id ? drop : before;
      if (drop && drop.id === id) lastDrop.current = null;
      const ghostEl = before.el;
      const w = parseFloat(ghostEl.style.width) || SMALL_W;
      const h = parseFloat(ghostEl.style.height) || SMALL_H;
      ghostEl.style.left = `${start.x - w / 2}px`;
      ghostEl.style.top = `${start.y - h / 2}px`;
      ghostEl.style.opacity = '1';
      ghostEl.style.pointerEvents = 'none';
      ghostEl.style.zIndex = '500000';
      for (const a of ghostEl.getAnimations()) a.cancel();
      board.appendChild(ghostEl);
      const anim = ghostEl.animate(
        [
          { translate: '0px 0px', scale: '1', opacity: 1 },
          { translate: `${to.x - start.x}px ${to.y - start.y}px`, scale: String(SMALL_W / w), opacity: 0.6 },
        ],
        timing,
      );
      anim.onfinish = anim.oncancel = () => ghostEl.remove();
    }
  });

  // ---------- Datos derivados ----------

  const templateMap = useMemo(() => new Map<string, CardTemplate>(library.templates.map((t) => [t.id, t])), [library.templates]);
  // Precargar las imágenes para que al voltear una carta se vea al instante
  useEffect(() => {
    for (const t of library.templates) if (t.imageUrl) new Image().src = t.imageUrl;
    for (const url of Object.values(library.backs)) new Image().src = url;
  }, [library]);

  const myPlay = state.me.play;
  const controlledPlay = solo ? [...state.me.play, ...state.opp.play] : myPlay;
  const selectedHand = state.hand.find((c) => c.id === selectedHandId) || null;
  const selectedOppHand = solo ? state.oppHand.find((c) => c.id && c.id === selectedHandId) || null : null;
  const selectedCard = controlledPlay.find((c) => c.id === selectedId) || null;
  const selectedSide: SideKey = selectedCard && state.opp.play.includes(selectedCard) ? 'opp' : 'me';

  // ---------- Zona de juego ordenada ----------
  // Las cartas en juego se colocan en fila, alineadas y centradas. La x guardada
  // solo sirve para el orden (de izquierda a derecha vista por el dueño).
  const PLAY_MAX_X = PLAY_W - CARD_W;
  const attachedTokenSize = TOKEN_SIZE * (compact ? 0.8 : 0.75);
  const PLAY_MID_Y = (PLAY_H - CARD_H) / 2;
  // ¿Esta zona se ve girada (orden de derecha a izquierda)?
  const mirroredPlay = (side: SideKey) => L.playCardPos(side, 0, 0).x > L.playCardPos(side, 100, 0).x;
  const playInViewOrder = (side: SideKey, list?: OnlinePlayCard[]) => {
    const sorted = [...(list ?? (side === 'me' ? state.me : state.opp).play)].sort((a, b) => a.x - b.x || a.order - b.order);
    return mirroredPlay(side) ? sorted.reverse() : sorted;
  };
  const playSlotsX = (side: SideKey, n: number) => {
    const r = zoneRect(side, 'play');
    const gap = 16;
    const avail = r.w - 2 * 16;
    const step = n > 1 ? Math.min(L.cardW + gap, (avail - L.cardW) / (n - 1)) : 0;
    const total = L.cardW + (n - 1) * step;
    const start = r.x + (r.w - total) / 2;
    return Array.from({ length: n }, (_, i) => start + i * step);
  };
  const playLayout = useMemo(() => {
    const map = new Map<string, { x: number; y: number; slot: number }>();
    for (const side of ['me', 'opp'] as SideKey[]) {
      const ordered = playInViewOrder(side);
      const xs = playSlotsX(side, ordered.length);
      const r = zoneRect(side, 'play');
      const y = r.y + (r.h - L.cardH) / 2;
      ordered.forEach((c, i) => map.set(c.id, { x: xs[i], y, slot: i }));
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.me.play, state.opp.play, L]);

  // Coloca una carta en la fila de una zona de juego en la posición `index` (vista)
  // y reparte las demás para que queden en orden. `card` es la carta ya en esa zona
  // o el mensaje de movimiento de una carta que llega de otro sitio.
  const placeInPlay = (side: SideKey, index: number, card: { id: string } | { msg: Record<string, unknown> }) => {
    const movingId = 'id' in card ? card.id : null;
    const others = playInViewOrder(side).filter((c) => c.id !== movingId);
    const at = clamp(index, 0, others.length);
    const ordered: (OnlinePlayCard | null)[] = [...others];
    ordered.splice(at, 0, null); // null = la carta que se coloca
    if (mirroredPlay(side)) ordered.reverse();
    const n = ordered.length;
    const keyOf = (k: number) => (n === 1 ? PLAY_MAX_X / 2 : (k * PLAY_MAX_X) / (n - 1));
    const updates: { id: string; x: number }[] = [];
    let mine = 0;
    ordered.forEach((c, k) => {
      if (c === null) mine = keyOf(k);
      else if (Math.abs(c.x - keyOf(k)) > 0.01) updates.push({ id: c.id, x: keyOf(k) });
    });
    if (movingId) updates.push({ id: movingId, x: mine });
    // Se ve al momento; el servidor confirma después
    const byId = new Map(updates.map((u) => [u.id, u.x]));
    patchState((s) => ({ ...s, [side]: { ...s[side], play: s[side].play.map((c) => (byId.has(c.id) ? { ...c, x: byId.get(c.id)!, y: PLAY_MID_Y } : c)) } }));
    for (const u of updates) sendAs(side, { t: 'move', id: u.id, to: 'play', x: u.x, y: PLAY_MID_Y });
    if (!('id' in card)) sendAs(side, { ...card.msg, to: 'play', x: mine, y: PLAY_MID_Y });
  };
  // Jugar al final de la fila (a la derecha, vista por el dueño)
  const playAtEnd = (side: SideKey, msg: Record<string, unknown>) =>
    placeInPlay(side, mirroredPlay(side) ? 0 : (side === 'me' ? state.me : state.opp).play.length, { msg });

  useEffect(() => {
    if (selectedId && !controlledPlay.some((c) => c.id === selectedId)) setSelectedId(null);
  }, [controlledPlay, selectedId]);

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

  const draw = (side: SideKey = 'me') => sendAs(side, { t: 'draw', count: 1 });
  const flip = () => selectedCard && sendAs(selectedSide, { t: 'flip', id: selectedCard.id });
  const tokenOnCard = () => selectedCard && sendAs(selectedSide, { t: 'tokenAdd', cardId: selectedCard.id });
  const moveSelected = (to: ZoneKey) => {
    if (!selectedCard) return;
    sendAs(selectedSide, { t: 'move', id: selectedCard.id, to });
    setSelectedId(null);
  };
  const setLife = (side: SideKey, value: number) => {
    const v = clamp(value, LIFE_MIN, LIFE_MAX);
    patchState((s) => ({ ...s, life: { ...s.life, [side]: v } }));
    sendAs(side, { t: 'life', value: v });
  };
  const addToken = () => {
    const r = stdZoneRect('me', 'play');
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
    else if (k === 't') tokenOnCard();
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

  const startDrag = (e: React.PointerEvent, src: DragSource, itemX: number, itemY: number, previewTemplateId?: string) => {
    if (e.button !== 0) return;
    if (src.kind === 'play') raiseCard(src.id);
    e.preventDefault();
    e.stopPropagation();
    const p = toBoard(e.clientX, e.clientY);
    const d: DragState = { src, startX: e.clientX, startY: e.clientY, grabX: p.x - itemX, grabY: p.y - itemY, x: p.x, y: p.y, moved: false, shift: e.shiftKey, preview: previewTemplateId };
    dragRef.current = d;
    setDrag(d);
    window.clearTimeout(pressTimer.current);
    if (e.pointerType === 'touch') {
      // Tocar una carta con el dedo: vista ampliada al momento (se quita si se arrastra)
      if (previewTemplateId) {
        window.clearTimeout(previewTimer.current);
        setPressPreview(previewTemplateId);
      } else hidePressPreview();
    }
  };

  const dropRef = useRef<(d: DragState) => void>(() => {});
  dropRef.current = (d: DragState) => {
    const { src } = d;
    if (d.longPress) return;
    if (src.kind === 'view') return;
    if (!d.moved) {
      // Clic (o toque) sin arrastrar
      const wasHand = selectedHandId;
      const wasToken = selectedTokenId;
      clearSelections();
      if (src.kind === 'library') draw(src.side);
      else if (src.kind === 'play' && canControl(src.side)) setSelectedId(src.id);
      else if (src.kind === 'hand') setSelectedHandId(wasHand === src.id ? null : src.id);
      else if (src.kind === 'token') setSelectedTokenId(wasToken === src.id ? null : src.id);
      return;
    }
    const left = d.x - d.grabX;
    const top = d.y - d.grabY;
    if (src.kind !== 'token') {
      // La animación de la carta soltada sale de donde la dejaste, no de su sitio anterior
      const small = src.kind !== 'play';
      lastDrop.current = {
        id: src.kind === 'library' ? undefined : src.id,
        lib: src.kind === 'library' ? src.side : undefined,
        x: left + (small ? SMALL_W : L.cardW) / 2,
        y: top + (small ? SMALL_H : L.cardH) / 2,
        w: small ? SMALL_W : L.cardW,
        at: Date.now(),
      };
    }

    if (src.kind === 'token' && src.cardId) {
      // Token de una carta: se queda dentro de la carta, donde se suelte
      const slot = playLayout.get(src.cardId);
      if (!slot) return;
      const size = attachedTokenSize;
      const rx = clamp((left + size / 2 - slot.x) / L.cardW, 0, 1);
      const ry = clamp((top + size / 2 - slot.y) / L.cardH, 0, 1);
      patchState((s) => ({ ...s, tokens: s.tokens.map((t) => (t.id === src.id ? { ...t, rx, ry } : t)) }));
      send({ t: 'tokenMove', id: src.id, rx, ry });
      return;
    }
    if (src.kind === 'token') {
      const { x, y } = L.fromView(clamp(left, 0, BOARD_W - TOKEN_SIZE), clamp(top, 0, L.boardH - TOKEN_SIZE));
      patchState((s) => ({ ...s, tokens: s.tokens.map((t) => (t.id === src.id ? { ...t, x, y } : t)) }));
      send({ t: 'tokenMove', id: src.id, x, y });
      return;
    }

    const zones: ZoneKey[] = ['play', 'hand', 'graveyard', 'library'];
    let toSide: SideKey = 'me';
    let to: ZoneKey | undefined;
    for (const side of (solo ? ['me', 'opp'] : ['me']) as SideKey[]) {
      to = zones.find((z) => inRect(zoneRect(side, z), d.x, d.y));
      if (to) {
        toSide = side;
        break;
      }
    }
    if (!to) return; // fuera de tus zonas: la carta vuelve a su sitio

    const ref = src.kind === 'library' ? { from: 'library', fromSide: seatOf(src.side) } : { id: src.id };

    if (to === 'play') {
      // Posición en la fila según dónde se suelte
      const dropCx = src.kind === 'play' ? left + L.cardW / 2 : d.x;
      const movingId = src.kind === 'play' && src.side === toSide ? src.id : null;
      const others = playInViewOrder(toSide).filter((c) => c.id !== movingId);
      const index = others.filter((c) => (playLayout.get(c.id)?.x ?? 0) + L.cardW / 2 < dropCx).length;
      if (movingId) {
        justDropped.current.set(movingId, Date.now());
        setSelectedId(movingId);
        placeInPlay(toSide, index, { id: movingId });
        return;
      }
      let faceUp: boolean | undefined;
      if (src.kind === 'hand') faceUp = !d.shift; // Mayús al soltar: boca abajo
      if (src.kind === 'library') faceUp = d.shift;
      placeInPlay(toSide, index, { msg: { t: 'move', ...ref, faceUp } });
      return;
    }

    if (to === 'hand' && src.kind === 'hand' && src.side === 'opp' && toSide === 'opp') return;
    if (to === 'hand' && src.kind === 'hand' && toSide === 'me' && src.side === 'me') {
      // Reordenar la mano según dónde se suelte
      const ids = state.hand.map((c) => c.id).filter((id) => id !== src.id);
      const slots = handSlots(state.hand.length, zoneRect('me', 'hand'));
      let index = slots.filter((sx) => sx + SMALL_W / 2 < d.x).length;
      index = clamp(index, 0, ids.length);
      ids.splice(index, 0, src.id);
      patchState((s) => ({ ...s, hand: ids.map((id) => s.hand.find((c) => c.id === id)!).filter(Boolean) }));
      send({ t: 'handOrder', ids });
      return;
    }
    if (to === 'graveyard' && src.kind === 'graveyard' && src.side === toSide) return;
    if (to === 'library' && src.kind === 'library' && src.side === toSide) return;
    sendAs(toSide, { t: 'move', ...ref, to });
  };

  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const p = toBoard(e.clientX, e.clientY);
      if (d.longPress) return; // mantener pulsado el mazo abre sus acciones: no se arrastra
      const moved = d.moved || Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > (e.pointerType === 'touch' ? 10 : 5);
      if (moved && !d.moved) {
        window.clearTimeout(pressTimer.current);
        hidePressPreview();
      }
      const next = { ...d, x: p.x, y: p.y, moved, shift: e.shiftKey };
      dragRef.current = next;
      setDrag(next);
    };
    const up = (e: PointerEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      window.clearTimeout(pressTimer.current);
      // Un toque sin arrastrar deja la carta ampliada 8 segundos
      if (d && !d.moved && d.preview && e.pointerType === 'touch' && e.type === 'pointerup') {
        window.clearTimeout(previewTimer.current);
        previewTimer.current = window.setTimeout(() => setPressPreview(null), 8000);
      } else hidePressPreview();
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

  const showPreview = (e: React.PointerEvent, cardId: string, templateId: string | undefined) => {
    if (!templateId || drag || e.pointerType === 'touch') return;
    setHoverTemplate({ cardId, templateId });
  };
  const hidePreview = () => setHoverTemplate(null);

  // ---------- Pintado de cartas ----------

  const cardImage = (templateId: string | undefined, back: CardBackInfo, faceUp: boolean) => {
    const t = faceUp && templateId ? templateMap.get(templateId) : undefined;
    if (t) {
      return t.imageUrl ? (
        <img src={t.imageUrl} alt={t.name} draggable={false} style={imgStyle} />
      ) : (
        <div style={{ ...imgStyle, background: '#1e293b', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, padding: 6, textAlign: 'center' }}>
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

  // Franjas marcadas sobre la mesa
  const band = (side: SideKey, zone: ZoneKey, label: string) => {
    const r = zoneRect(side, zone);
    const target = !!drag && drag.moved && drag.src.kind !== 'token' && canControl(side);
    return (
      <div
        key={`${side}-${zone}`}
        style={{
          position: 'absolute',
          left: r.x,
          top: r.y,
          width: r.w,
          height: r.h,
          borderRadius: 18,
          border: `2px dashed ${target ? 'rgba(168, 85, 247, 0.65)' : 'rgba(255, 255, 255, 0.11)'}`,
          background: target ? 'rgba(168, 85, 247, 0.06)' : 'rgba(255, 255, 255, 0.015)',
          transition: 'border-color 0.15s, background 0.15s',
          pointerEvents: 'none',
        }}
      >
        <span
          style={{
            position: 'absolute',
            left: 16,
            [side === 'me' ? 'top' : 'bottom']: 8,
            fontSize: 14,
            fontWeight: 600,
            letterSpacing: 1,
            textTransform: 'uppercase',
            color: 'rgba(255,255,255,0.22)',
          }}
        >
          {label}
        </span>
      </div>
    );
  };

  // Biblioteca (montón boca abajo)
  // Botón redondo de los montones (barajar)
  const roundSize = compact ? 60 : isTouch ? 52 : 44;
  const roundBtn: React.CSSProperties = { position: 'absolute', width: roundSize, height: roundSize, padding: 0, borderRadius: '50%', justifyContent: 'center', zIndex: 12 };
  const libraryPile = (side: SideKey) => {
    const lib = (side === 'me' ? state.me : state.opp).library;
    const r = zoneRect(side, 'library');
    const cx = r.x + 22;
    const cy = side === 'me' ? r.y + 8 : r.y + r.h - 8 - SMALL_H;
    const top = lib.top;
    return (
      <React.Fragment key={`lib-${side}`}>
        {top && (
          <div
            title={canControl(side) ? 'Clic: robar · Arrastrar: coger la carta de arriba' : undefined}
            onPointerDown={canControl(side) ? (e) => startDrag(e, { kind: 'library', back: top, side }, cx, cy) : undefined}
            style={{
              ...cardFrame,
              left: cx,
              top: cy,
              width: SMALL_W,
              height: SMALL_H,
              cursor: canControl(side) ? 'grab' : 'default',
              boxShadow: `${Math.min(lib.count, 6)}px ${Math.min(lib.count, 6)}px 0 rgba(0,0,0,0.45), 0 4px 10px rgba(0,0,0,0.3)`,
              zIndex: 5,
            }}
          >
            {cardImage(undefined, top, false)}
          </div>
        )}
        <div style={{ ...pill, left: r.x + r.w / 2, top: side === 'me' ? r.y + SMALL_H + 14 : r.y + 8 }}>
          Biblioteca · {lib.count}
        </div>
        {canControl(side) && lib.count > 0 && (
          <button
            className="btn-secondary"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => sendAs(side, { t: 'shuffleLibrary' })}
            title={solo ? 'Barajar la biblioteca' : 'Barajar tu biblioteca'}
            style={{ ...roundBtn, left: cx + SMALL_W + (r.x + r.w - cx - SMALL_W - roundSize) / 2, top: cy + SMALL_H / 2 - roundSize / 2 }}
          >
            <Shuffle size={compact ? 26 : 20} />
          </button>
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
    const centerY = side === 'me' ? r.y + 80 : r.y + r.h - 80;
    const baseX = r.x + (r.w - SMALL_W) / 2;
    const baseY = centerY - SMALL_H / 2;
    return (
      <React.Fragment key={`grave-${side}`}>
        {shown.map((c, i) => {
          const isTop = i === shown.length - 1;
          const x = baseX + i * 3;
          const y = baseY - i * 3;
          return (
            <div
              key={c.id}
              data-fid={c.id}
              data-side={side}
              data-zone="graveyard"
              className={isTop ? 'ol-grave-enter' : undefined}
              onPointerDown={isTop ? (e) => startDrag(e, { kind: 'graveyard', id: c.id, side, back: c }, x, y) : undefined}
              title={isTop ? 'Arrastra la carta de arriba para cogerla' : undefined}
              style={{
                ...cardFrame,
                left: x,
                top: y,
                width: SMALL_W,
                height: SMALL_H,
                transform: 'rotate(-90deg)',
                cursor: isTop ? 'grab' : 'default',
                opacity: isTop && isDragged('graveyard', c.id) ? 0.25 : 1,
                zIndex: 5 + i,
              }}
            >
              {cardImage(undefined, c, false)}
            </div>
          );
        })}
        <div style={{ ...pill, left: r.x + r.w / 2, top: side === 'me' ? r.y + 150 : r.y + 18 }}>
          Cementerio · {list.length}
        </div>
        {canControl(side) && list.length > 0 && (side === 'me' ? state.me : state.opp).library.count === 0 && (
          <button
            className="btn-primary"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => sendAs(side, { t: 'recycleGraveyard' })}
            title="La biblioteca está vacía: barajar el cementerio y ponerlo en la biblioteca"
            style={{ ...roundBtn, left: r.x + r.w / 2 - roundSize / 2, top: centerY - roundSize / 2, zIndex: 20 }}
          >
            <Shuffle size={compact ? 26 : 20} />
          </button>
        )}
      </React.Fragment>
    );
  };

  // Carta de dos caras (como en un jugador): al voltear gira en 3D y al girar rota con rebote
  const flipCard = (templateId: string | undefined, back: CardBackInfo, faceUp: boolean) => {
    const t = templateId ? templateMap.get(templateId) : undefined;
    const backUrl = library.backs[backKey(back)];
    return (
      <div className={`card-container ${faceUp ? '' : 'flipped-state'}`}>
        <div className="card-face card-front">
          {t?.imageUrl ? (
            <img src={t.imageUrl} alt={t.name} draggable={false} />
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 14, padding: 8, textAlign: 'center', background: '#0f172a' }}>
              {t?.name || ''}
            </div>
          )}
        </div>
        <div className="card-face card-back">
          {backUrl ? (
            <img src={backUrl} alt="Reverso" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }} />
          ) : (
            <div className="card-back-pattern">
              <span className="card-back-logo">AD</span>
            </div>
          )}
        </div>
      </div>
    );
  };

  const playCards = (side: SideKey) =>
    (side === 'me' ? state.me : state.opp).play.map((c) => {
      const slot = playLayout.get(c.id);
      const pos = slot ?? L.playCardPos(side, c.x, c.y);
      const selected = canControl(side) && c.id === selectedId;
      // La carta que acabas de soltar no se desliza: ya está donde la dejaste
      const instant = Date.now() - (justDropped.current.get(c.id) || 0) < 500;
      return (
        <div
          key={c.id}
          data-fid={c.id}
          data-side={side}
          data-zone="play"
          className={`ol-card ol-play ol-enter${instant ? ' ol-instant' : ''}`}
          onPointerDown={(e) => startDrag(e, { kind: 'play', id: c.id, side, card: c }, pos.x, pos.y, c.isFaceUp ? c.templateId : undefined)}
          onPointerEnter={(e) => c.isFaceUp && showPreview(e, c.id, c.templateId)}
          onPointerLeave={hidePreview}
          onDoubleClick={() => canControl(side) && sendAs(side, { t: 'flip', id: c.id })}
          style={{
            position: 'absolute',
            left: pos.x,
            top: pos.y,
            width: L.cardW,
            height: L.cardH,
            zIndex: c.id === raisedId ? 250 : 20 + (slot?.slot ?? 0) * 2,
            cursor: 'grab',
            opacity: isDragged('play', c.id) ? 0.25 : 1,
          }}
        >
          <div
            className="card-rotation-wrapper"
            style={{
              transform: `rotate(${c.rotation}deg)`,
              borderRadius: 'var(--card-radius)',
              boxShadow: selected ? '0 0 0 3px var(--color-accent), 0 0 24px var(--color-accent-glow)' : 'none',
            }}
          >
            {flipCard(c.templateId, c, c.isFaceUp)}
          </div>
        </div>
      );
    });

  // Bandeja de la mano propia (como en un jugador, pero dentro de su franja)
  const myHandTray = () => {
    const r = zoneRect('me', 'hand');
    const cardsRect = { x: r.x, y: r.y, w: r.w, h: r.h };
    const slots = handSlots(state.hand.length, cardsRect);
    const y = r.y + 36;
    return (
      <React.Fragment key="my-hand">
        <div className="glass-panel" style={{ position: 'absolute', left: r.x, top: r.y, width: r.w, height: r.h, borderRadius: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: isTouch ? '4px 10px' : '6px 14px', fontSize: isTouch ? 17 : 15 }}>
            <Hand size={16} />
            <strong>{solo ? `Mano de ${myInfo?.name}` : 'Tu mano'} ({state.hand.length})</strong>
            <span style={{ color: handRevealed ? 'var(--color-accent)' : 'var(--text-muted)', fontSize: isTouch ? 15 : 13, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {selectedHand || solo ? '' : handRevealed ? 'Tu rival está viendo tu mano' : 'Solo tú ves estas cartas'}
            </span>
            {selectedHand && !compact && (
              <>
                {!solo && (
                  <button className="btn-secondary" onPointerDown={(e) => e.stopPropagation()} onClick={() => send({ t: 'reveal', id: selectedHand.id })} title="Enseñar esta carta al rival sin jugarla" style={smallBtn}>
                    <Eye size={ui.icon} /> Enseñar
                  </button>
                )}
                <button
                  className="btn-secondary"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => {
                    playAtEnd('me', { t: 'move', id: selectedHand.id, faceUp: false });
                    setSelectedHandId(null);
                  }}
                  title="Jugar esta carta boca abajo en el centro de tu zona"
                  style={smallBtn}
                >
                  <EyeOff size={ui.icon} /> Jugar boca abajo
                </button>
              </>
            )}
            {!solo && !compact && (
              <button
                className={handRevealed ? 'btn-primary' : 'btn-secondary'}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => send({ t: 'showHand', value: !handRevealed })}
                title={handRevealed ? 'Volver a ocultar tu mano' : 'Enseñar todas las cartas de tu mano al rival hasta que la vuelvas a ocultar'}
                style={smallBtn}
              >
                {handRevealed ? <EyeOff size={ui.icon} /> : <Eye size={ui.icon} />} {handRevealed ? 'Ocultar mi mano' : 'Enseñar mi mano'}
              </button>
            )}
          </div>
        </div>
        {state.hand.map((c, i) => {
          const hovered = (hoverHandId === c.id || selectedHandId === c.id) && !drag;
          return (
            <div
              key={c.id}
              data-fid={c.id}
              data-side="me"
              data-zone="hand"
              className="ol-hand-enter"
              onPointerDown={(e) => startDrag(e, { kind: 'hand', id: c.id, templateId: c.templateId, back: c, side: 'me' }, slots[i], y, c.templateId)}
              onPointerEnter={(e) => {
                if (e.pointerType === 'touch') return;
                setHoverHandId(c.id);
                showPreview(e, c.id, c.templateId);
              }}
              onPointerLeave={() => {
                setHoverHandId((h) => (h === c.id ? null : h));
                hidePreview();
              }}
              style={{
                ...cardFrame,
                left: slots[i],
                top: y - (hovered ? 16 : 0),
                width: SMALL_W,
                height: SMALL_H,
                zIndex: hovered ? 900 : 300 + i,
                cursor: 'grab',
                transition: 'top 0.15s ease, left 0.3s ease',
                opacity: isDragged('hand', c.id) ? 0.25 : 1,
              }}
            >
              {cardImage(c.templateId, c, true)}
              {hovered && !isTouch && !solo && (
                <button
                  className="btn-secondary"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => send({ t: 'reveal', id: c.id })}
                  title="Enseñar esta carta al rival sin jugarla"
                  style={{ position: 'absolute', left: '50%', bottom: 6, transform: 'translateX(-50%)', padding: '3px 8px', fontSize: 12, background: 'rgba(18,24,38,0.9)' }}
                >
                  <Eye size={12} /> Enseñar
                </button>
              )}
            </div>
          );
        })}
      </React.Fragment>
    );
  };

  // En un jugador la mano de arriba se ve y se juega igual que la de abajo
  const soloOppHandTray = () => {
    const r = zoneRect('opp', 'hand');
    const slots = handSlots(state.oppHand.length, r);
    const y = r.y + 8;
    return (
      <React.Fragment key="opp-hand">
        <div className="glass-panel" style={{ position: 'absolute', left: r.x, top: r.y, width: r.w, height: r.h, borderRadius: 18 }}>
          <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: isTouch ? '4px 10px' : '6px 14px', fontSize: isTouch ? 17 : 15 }}>
            <Hand size={16} />
            <strong>
              Mano de {oppInfo?.name} ({state.oppHand.length})
            </strong>
            {selectedOppHand && !compact && (
              <button
                className="btn-secondary"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => {
                  playAtEnd('opp', { t: 'move', id: selectedOppHand.id, faceUp: false });
                  setSelectedHandId(null);
                }}
                title="Jugar esta carta boca abajo en el centro de su zona"
                style={smallBtn}
              >
                <EyeOff size={ui.icon} /> Jugar boca abajo
              </button>
            )}
          </div>
        </div>
        {state.oppHand.map((c, i) => {
          const id = c.id!;
          const hovered = (hoverHandId === id || selectedHandId === id) && !drag;
          return (
            <div
              key={id}
              data-fid={id}
              data-side="opp"
              data-zone="hand"
              className="ol-hand-enter"
              onPointerDown={(e) => startDrag(e, { kind: 'hand', id, templateId: c.templateId!, back: c, side: 'opp' }, slots[i], y, c.templateId)}
              onPointerEnter={(e) => {
                if (e.pointerType === 'touch') return;
                setHoverHandId(id);
                showPreview(e, id, c.templateId);
              }}
              onPointerLeave={() => {
                setHoverHandId((h) => (h === id ? null : h));
                hidePreview();
              }}
              style={{
                ...cardFrame,
                left: slots[i],
                top: y + (hovered ? 16 : 0),
                width: SMALL_W,
                height: SMALL_H,
                zIndex: hovered ? 900 : 300 + i,
                cursor: 'grab',
                transition: 'top 0.15s ease, left 0.3s ease',
                opacity: isDragged('hand', id) ? 0.25 : 1,
              }}
            >
              {cardImage(c.templateId, c, true)}
            </div>
          );
        })}
      </React.Fragment>
    );
  };

  const oppHandTray = () => {
    if (solo) return soloOppHandTray();
    const r = zoneRect('opp', 'hand');
    const slots = handSlots(state.oppHand.length, r);
    const y = r.y + 8;
    return (
      <React.Fragment key="opp-hand">
        <div className="glass-panel" style={{ position: 'absolute', left: r.x, top: r.y, width: r.w, height: r.h, borderRadius: 18 }}>
          <div style={{ position: 'absolute', bottom: 6, left: 0, right: 0, textAlign: 'center', fontSize: 14, color: 'var(--text-muted)' }}>
            Mano de <strong style={{ color: '#fff' }}>{oppInfo?.name || 'tu rival'}</strong>: {state.oppHand.length} {state.oppHand.length === 1 ? 'carta' : 'cartas'}
            {oppInfo?.handRevealed && <span style={{ color: 'var(--color-accent)' }}> · te la está enseñando</span>}
          </div>
        </div>
        {state.oppHand.map((c, i) => (
          <div
            key={i}
            className="ol-opp-hand-enter"
            onPointerEnter={(e) => c.templateId && showPreview(e, `opp-hand-${i}`, c.templateId)}
            onPointerDown={(e) => c.templateId && startDrag(e, { kind: 'view' }, 0, 0, c.templateId)}
            onPointerLeave={hidePreview}
            style={{ position: 'absolute', left: slots[i], top: y, width: SMALL_W, height: SMALL_H, zIndex: 300 + i, transition: 'left 0.3s ease' }}
          >
            {/* Cuando el rival enseña la mano, sus cartas se dan la vuelta */}
            {flipCard(c.templateId, c, !!c.templateId)}
          </div>
        ))}
      </React.Fragment>
    );
  };

  // Contadores de vida redondos, fijos: el tuyo a la izquierda y el del rival a la derecha
  // Carta de vida del mazo (de 10 a 0): el token marca la vida y se mueve con + y −
  const lifeTemplateOf = (side: SideKey) => {
    const deckId = state.players[seatOf(side)]?.deckId;
    return deckId ? library.templates.find((t) => t.deckId === deckId && t.isLife && t.imageUrl) : undefined;
  };
  const lifeCard = (side: SideKey, tpl: CardTemplate) => {
    const mine = canControl(side);
    const value = clamp(side === 'me' ? state.life.me : state.life.opp, LIFE_MIN, LIFE_MAX);
    const info = side === 'me' ? myInfo : oppInfo;
    const h = compact ? 226 : 300;
    const w = h * LIFE_CARD_RATIO;
    const cx = side === 'me' ? SIDE_W / 2 : BOARD_W - SIDE_W / 2;
    const pr = zoneRect(side, 'play');
    const top = pr.y + pr.h / 2 - h / 2 - (compact ? 0 : 14);
    const left = cx - w / 2;
    const [tx, ty] = LIFE_TRACK[value];
    const token = w * 0.16;
    const btnStyle: React.CSSProperties = { width: ui.life + 6, height: ui.life + 6, fontSize: isTouch ? 26 : 22 };
    return (
      <React.Fragment key={`life-${side}`}>
        <div
          title={mine && !compact ? undefined : `Vida: ${value}`}
          onPointerDown={compact && mine ? (e) => e.stopPropagation() : undefined}
          onClick={
            compact && mine
              ? () => {
                  clearSelections();
                  setLifeSel(side);
                }
              : undefined
          }
          style={{
            position: 'absolute',
            left,
            top,
            width: w,
            height: h,
            borderRadius: 14,
            overflow: 'hidden',
            zIndex: 50,
            cursor: compact && mine ? 'pointer' : 'default',
            boxShadow: lifeSel === side ? '0 0 0 4px var(--color-accent), 0 10px 25px rgba(0,0,0,0.5)' : '0 10px 25px rgba(0,0,0,0.5)',
          }}
        >
          <img src={tpl.imageUrl} alt={tpl.name} draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }} />
          {/* Token de vida: se desliza hasta el número */}
          <div
            style={{
              position: 'absolute',
              left: tx * w - token / 2,
              top: ty * h - token / 2,
              width: token,
              height: token,
              borderRadius: '50%',
              background: 'radial-gradient(circle at 35% 30%, #fde68a, #facc15 55%, #ca8a04)',
              border: '3px solid #000',
              boxShadow: '0 6px 12px rgba(0,0,0,0.55)',
              opacity: 0.92,
              transition: 'left 0.5s cubic-bezier(0.34, 1.3, 0.64, 1), top 0.5s cubic-bezier(0.34, 1.3, 0.64, 1)',
              pointerEvents: 'none',
            }}
          />
        </div>
        <div style={{ ...pill, left: cx, top: top - 30, zIndex: 51 }}>
          {solo ? deckNameOf(side) || info?.name : info ? info.name : 'Esperando…'} · {value}
        </div>
        {mine && !compact && (
          <div style={{ position: 'absolute', left: cx, top: top + h + 8, transform: 'translateX(-50%)', display: 'flex', gap: 14, zIndex: 51 }}>
            <button className="life-counter-btn" style={btnStyle} onClick={() => setLife(side, value - 1)} disabled={value <= LIFE_MIN} title="Restar vida">
              −
            </button>
            <button className="life-counter-btn" style={btnStyle} onClick={() => setLife(side, value + 1)} disabled={value >= LIFE_MAX} title="Sumar vida">
              +
            </button>
          </div>
        )}
      </React.Fragment>
    );
  };

  const lifeCounter = (side: SideKey) => {
    const lifeTpl = lifeTemplateOf(side);
    if (lifeTpl) return lifeCard(side, lifeTpl);
    const mine = canControl(side);
    const value = side === 'me' ? state.life.me : state.life.opp;
    const info = side === 'me' ? myInfo : oppInfo;
    const size = 190;
    const cx = side === 'me' ? SIDE_W / 2 : BOARD_W - SIDE_W / 2;
    const pr = zoneRect(side, 'play');
    const cy = pr.y + pr.h / 2;
    return (
      <div
        key={`life-${side}`}
        className="life-counter-token"
        onPointerDown={compact && mine ? (e) => e.stopPropagation() : undefined}
        onClick={
          compact && mine
            ? () => {
                clearSelections();
                setLifeSel(side);
              }
            : undefined
        }
        style={{
          left: cx - size / 2,
          top: cy - size / 2,
          width: size,
          height: size,
          cursor: compact && mine ? 'pointer' : 'default',
          zIndex: 50,
          boxShadow: lifeSel === side ? '0 0 0 4px var(--color-accent), 0 10px 25px rgba(0,0,0,0.5)' : undefined,
        }}
      >
        <div className="life-counter-label" style={{ fontSize: 15, maxWidth: 150 }}>
          {solo ? deckNameOf(side) || info?.name : info ? info.name : 'Esperando…'}
        </div>
        {info && side === 'opp' && !solo && (info.left || !info.connected) && (
          <div style={{ fontSize: 12, color: 'var(--color-danger)' }}>{info.left ? 'ha salido' : 'desconectado'}</div>
        )}
        <div className="life-counter-display">
          {mine && !compact && (
            <button className="life-counter-btn" style={{ width: ui.life, height: ui.life, fontSize: isTouch ? 26 : undefined }} onClick={() => setLife(side, value - 1)} disabled={value <= LIFE_MIN} title="Restar vida">
              −
            </button>
          )}
          <span key={value} className="life-counter-val ol-pulse" style={{ fontSize: 54 }}>
            {value}
          </span>
          {mine && !compact && (
            <button className="life-counter-btn" style={{ width: ui.life, height: ui.life, fontSize: isTouch ? 26 : undefined }} onClick={() => setLife(side, value + 1)} disabled={value >= LIFE_MAX} title="Sumar vida">
              +
            </button>
          )}
        </div>
      </div>
    );
  };

  // Fantasma de lo que se arrastra
  const ghost = () => {
    if (!drag || !drag.moved) return null;
    const { src } = drag;
    if (src.kind === 'token' || src.kind === 'view') return null;
    const small = src.kind !== 'play';
    const left = drag.x - drag.grabX;
    const top = drag.y - drag.grabY;
    let content: React.ReactNode;
    let rotation = 0;
    if (src.kind === 'hand') content = cardImage(src.templateId, src.back, !drag.shift);
    else if (src.kind === 'library' || src.kind === 'graveyard') content = cardImage(undefined, src.back, false);
    else {
      content = cardImage(src.card.templateId, src.card, src.card.isFaceUp);
      rotation = src.card.rotation;
    }
    return (
      <div
        style={{
          ...cardFrame,
          left,
          top,
          width: small ? SMALL_W : L.cardW,
          height: small ? SMALL_H : L.cardH,
          zIndex: 500000,
          pointerEvents: 'none',
          transform: `rotate(${rotation + 3}deg) scale(1.07)`,
          boxShadow: '0 26px 45px rgba(0,0,0,0.65)',
        }}
      >
        {content}
      </div>
    );
  };

  // Tokens fijados a una carta: se mueven por encima de ella y van justo sobre su capa
  const attachedIndex = new Map<string, number>();
  const tokens = state.tokens.map((t) => {
    if (t.cardId) {
      const slot = playLayout.get(t.cardId);
      if (!slot) return null;
      const k = attachedIndex.get(t.cardId) ?? 0;
      attachedIndex.set(t.cardId, k + 1);
      const size = attachedTokenSize;
      const rx = t.rx ?? 0.8;
      const ry = t.ry ?? Math.min(0.9, 0.12 + k * 0.16);
      const dragging = drag && drag.moved && drag.src.kind === 'token' && drag.src.id === t.id;
      // Mientras se arrastra no sale de su carta
      const x = dragging ? clamp(drag.x - drag.grabX, slot.x - size / 2, slot.x + L.cardW - size / 2) : slot.x + rx * L.cardW - size / 2;
      const y = dragging ? clamp(drag.y - drag.grabY, slot.y - size / 2, slot.y + L.cardH - size / 2) : slot.y + ry * L.cardH - size / 2;
      return (
        <div
          key={t.id}
          title="Token de la carta · arrastrar para moverlo · toca para quitarlo"
          onPointerDown={(e) => startDrag(e, { kind: 'token', id: t.id, cardId: t.cardId }, x, y)}
          onDoubleClick={() => send({ t: 'tokenDelete', id: t.id })}
          onContextMenu={(e) => {
            e.preventDefault();
            send({ t: 'tokenDelete', id: t.id });
          }}
          style={{
            position: 'absolute',
            left: x,
            top: y,
            width: size,
            height: size,
            borderRadius: '50%',
            background: '#facc15',
            border: '3px solid #000',
            boxShadow: dragging ? '0 10px 18px rgba(0,0,0,0.6)' : '0 4px 10px rgba(0,0,0,0.6)',
            transform: dragging ? 'scale(1.15)' : 'none',
            transition: dragging ? 'transform 0.15s' : 'left 0.35s cubic-bezier(0.25, 0.8, 0.25, 1), top 0.35s cubic-bezier(0.25, 0.8, 0.25, 1), transform 0.15s',
            cursor: 'grab',
            // Justo encima de su carta: otra carta que se le ponga encima lo tapa
            zIndex: dragging ? 500000 : t.cardId === raisedId ? 251 : 21 + slot.slot * 2,
            outline: selectedTokenId === t.id ? '3px solid var(--color-accent)' : 'none',
            outlineOffset: 3,
          }}
        >
          {selectedTokenId === t.id && !compact && !dragging && (
            <button
              className="btn-danger"
              title="Quitar token"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                send({ t: 'tokenDelete', id: t.id });
                setSelectedTokenId(null);
              }}
              style={{ position: 'absolute', left: size + 6, top: -6, width: 32, height: 32, padding: 0, justifyContent: 'center', borderRadius: '50%' }}
            >
              <X size={14} />
            </button>
          )}
        </div>
      );
    }
    const dragged = drag && drag.moved && drag.src.kind === 'token' && drag.src.id === t.id;
    const view = L.toView(t.x!, t.y!);
    const x = dragged ? clamp(drag.x - drag.grabX, 0, BOARD_W - TOKEN_SIZE) : view.x;
    const y = dragged ? clamp(drag.y - drag.grabY, 0, L.boardH - TOKEN_SIZE) : view.y;
    return (
      <div
        key={t.id}
        title="Token · arrastrar para mover · doble clic para quitar"
        onPointerDown={(e) => startDrag(e, { kind: 'token', id: t.id }, view.x, view.y)}
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
          boxShadow: dragged ? '0 12px 22px rgba(0,0,0,0.6)' : '0 4px 10px rgba(0,0,0,0.6)',
          transform: dragged ? 'scale(1.15)' : 'none',
          transition: dragged ? 'transform 0.15s, box-shadow 0.15s' : 'left 0.3s ease, top 0.3s ease, transform 0.15s, box-shadow 0.15s',
          cursor: 'grab',
          zIndex: 400000,
          outline: selectedTokenId === t.id ? '3px solid var(--color-accent)' : 'none',
          outlineOffset: 3,
        }}
      >
        {selectedTokenId === t.id && !dragged && !compact && (
          <button
            className="btn-danger"
            title="Quitar token"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => {
              send({ t: 'tokenDelete', id: t.id });
              setSelectedTokenId(null);
            }}
            style={{ position: 'absolute', left: TOKEN_SIZE + 6, top: -6, width: ui.pile * 0.8, height: ui.pile * 0.8, padding: 0, justifyContent: 'center', borderRadius: '50%' }}
          >
            <X size={ui.icon + 2} />
          </button>
        )}
      </div>
    );
  });

  // ---------- Panel de la sala ----------

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

  const handRevealed = !!myInfo?.handRevealed;
  const myCardsInGame = state.me.library.count + state.hand.length + state.me.graveyard.length + state.me.play.length > 0;
  const unread = showLog ? 0 : Math.max(0, state.log.length - seenLog);
  const btn: React.CSSProperties = { padding: ui.pad, fontSize: ui.font };
  // La vista ampliada solo se muestra si la carta sigue donde estaba (y boca arriba)
  const hoverStillThere =
    !!hoverTemplate &&
    !drag &&
    (state.hand.some((c) => c.id === hoverTemplate.cardId) ||
      state.oppHand.some((c, i) => (c.id ?? `opp-hand-${i}`) === hoverTemplate.cardId && c.templateId === hoverTemplate.templateId) ||
      [...state.me.play, ...state.opp.play].some((c) => c.id === hoverTemplate.cardId && c.isFaceUp));
  const previewTemplate = pressPreview ? templateMap.get(pressPreview) : hoverStillThere ? templateMap.get(hoverTemplate!.templateId) : undefined;

  const panelBox: React.CSSProperties = compact
    ? { position: 'relative', width: 'min(300px, 88vw)', padding: 14, display: 'flex', flexDirection: 'column', gap: 9, fontSize: 15 }
    : { position: 'absolute', left: 14, top: 14, width: SIDE_W - 28, padding: 16, display: 'flex', flexDirection: 'column', gap: 10, zIndex: 60, fontSize: isTouch ? 18 : 14 };
  const fullscreenBtn = (
    <button className="btn-secondary" onClick={onFullscreen} title={fullscreen ? 'Salir de pantalla completa' : 'Pantalla completa'} style={{ ...btn, padding: '6px 9px' }}>
      {fullscreen ? <Minimize size={ui.icon} /> : <Maximize size={ui.icon} />}
    </button>
  );
  const cardsOf = (side: SideKey) => {
    const sd = side === 'me' ? state.me : state.opp;
    return sd.library.count + sd.graveyard.length + sd.play.length + (side === 'me' ? state.hand.length : state.oppHand.length);
  };
  const deckSelect = (side: SideKey, placeholder: string) => (
    <select
      value={state.players[seatOf(side)]?.deckId || ''}
      onChange={(e) => sendAs(side, { t: 'chooseDeck', deckId: e.target.value })}
      style={{
        flex: 1,
        minWidth: 0,
        background: 'rgba(0,0,0,0.35)',
        color: '#fff',
        border: '1px solid var(--glass-border)',
        borderRadius: 6,
        padding: 7,
        fontSize: isTouch ? 16 : 14,
        fontFamily: 'var(--font-family)',
      }}
    >
      <option value="" disabled>
        {Object.keys(library.deckNames).length ? placeholder : solo ? 'No hay mazos con cartas' : 'No hay mazos publicados'}
      </option>
      {Object.entries(library.deckNames).map(([id, name]) => (
        <option key={id} value={id}>
          {name} ({library.templates.filter((t) => t.deckId === id && !t.isLife).reduce((s, t) => s + (t.quantity || 1), 0)})
        </option>
      ))}
    </select>
  );
  const spawnDeck = (side: SideKey) => {
    const doSpawn = () => sendAs(side, { t: 'spawnDeck' });
    const who = solo ? `de ${state.players[seatOf(side)]?.name}` : 'tus';
    if (cardsOf(side) > 0)
      confirm('Volver a poner el mazo', `Se retirarán todas las cartas ${who} (biblioteca, mano, mesa y cementerio) y el mazo se barajará de nuevo en la biblioteca. ¿Seguro?`, doSpawn);
    else doSpawn();
  };

  const soloPanel = (
    <div
      className="glass-panel"
      onPointerDown={(e) => e.stopPropagation()}
      style={panelBox}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: '#fff' }}>Un jugador</div>
        {fullscreenBtn}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn-secondary" onClick={onLeave} title="Gestionar mazos, cartas y dorsos" style={{ ...btn, flex: 1 }}>
          <BookOpen size={14} /> Mazos
        </button>
        {onOpenOnline && (
          <button className="btn-secondary" onClick={onOpenOnline} title="Jugar online contra otra persona" style={{ ...btn, flex: 1 }}>
            <Globe size={14} /> Online 1 vs 1
          </button>
        )}
      </div>
      {(['opp', 'me'] as SideKey[]).map((side) => {
        const has = !!state.players[seatOf(side)]?.deckId;
        return (
          <div key={side} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: isTouch ? 15 : 12, color: 'var(--text-muted)' }}>
              {state.players[seatOf(side)]?.name} ({side === 'me' ? 'abajo' : 'arriba'})
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              {deckSelect(side, 'Elige mazo…')}
              <button
                className="btn-primary"
                data-keep
                disabled={!has}
                onClick={() => spawnDeck(side)}
                title="Poner el mazo barajado en su biblioteca"
                style={{ padding: '6px 9px', opacity: has ? 1 : 0.5 }}
              >
                <Layers size={15} />
              </button>
            </div>
          </div>
        );
      })}
      <div style={{ height: 1, background: 'var(--glass-border)' }} />
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn-secondary" onClick={addToken} title="Añadir un token a la mesa" style={{ ...btn, flex: 1 }}>
          <span style={{ width: 13, height: 13, borderRadius: '50%', background: '#facc15', border: '2px solid #000', display: 'inline-block' }} /> Token
        </button>
        <button className="btn-secondary" onClick={() => setShowLog((v) => !v)} style={{ ...btn, flex: 1 }}>
          <MessageSquare size={14} /> Registro
        </button>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn-primary" onClick={() => setShowEnd(true)} style={{ ...btn, flex: 1 }} title="Registrar qué campeón ha ganado">
          <Trophy size={14} /> Terminar partida
        </button>
        <button className="btn-secondary" onClick={() => setShowHistory(true)} style={{ ...btn, flex: 1 }} title="Ver qué campeones han ganado">
          <History size={14} /> Historial
        </button>
      </div>
      <button
        className="btn-danger"
        onClick={() => confirm('Reiniciar mesa', 'Se retirarán todas las cartas y tokens de los dos jugadores y las vidas volverán a 10. ¿Seguro?', () => send({ t: 'reset' }))}
        style={btn}
      >
        Reiniciar
      </button>
      <div style={{ fontSize: isTouch ? 15 : 12, color: 'var(--text-muted)', lineHeight: 1.45 }}>
        {compact
          ? 'Mueves las cartas de los dos jugadores. Toca una biblioteca para robar (mantenla pulsada para barajar o mirar). Toca una carta para verla en grande y ver sus acciones; toca un cementerio o una vida para ver las suyas.'
          : isTouch
          ? 'Mueves las cartas de los dos jugadores. Toca una carta para verla en grande y ver sus acciones; toca la biblioteca para robar.'
          : 'Mueves las cartas de los dos jugadores. Clic en la biblioteca o R: robar · H: a la mano · G: al cementerio · T: token en la carta'}
      </div>
    </div>
  );

  const roomPanel = solo ? soloPanel : (
    <div
      className="glass-panel"
      onPointerDown={(e) => e.stopPropagation()}
      style={panelBox}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Sala online</div>
          <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: 3, color: '#fff' }}>{state.code}</div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn-secondary" onClick={copyInvite} title="Copiar enlace de invitación" style={btn}>
            <Copy size={14} /> Invitar
          </button>
          {fullscreenBtn}
        </div>
      </div>
      {compact && (
        <button
          className={handRevealed ? 'btn-primary' : 'btn-secondary'}
          onClick={() => send({ t: 'showHand', value: !handRevealed })}
          style={btn}
        >
          {handRevealed ? <EyeOff size={ui.icon} /> : <Eye size={ui.icon} />} {handRevealed ? 'Ocultar mi mano' : 'Enseñar mi mano al rival'}
        </button>
      )}
      {(['p1', 'p2'] as Seat[]).map((seat) => {
        const p = state.players[seat];
        return (
          <div key={seat} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                width: 9,
                height: 9,
                borderRadius: '50%',
                background: p ? (p.connected ? 'var(--color-success)' : 'var(--color-danger)') : 'var(--text-muted)',
                flexShrink: 0,
              }}
            />
            <span style={{ flex: 1, color: p ? '#fff' : 'var(--text-muted)' }}>
              {p ? p.name : 'Esperando rival…'}
              {seat === me ? ' (tú)' : ''}
              {p && p.left ? ' · ha salido' : p && !p.connected ? ' · desconectado' : ''}
            </span>
          </div>
        );
      })}
      <div style={{ height: 1, background: 'var(--glass-border)' }} />
      <div style={{ display: 'flex', gap: 6 }}>
        <select
          value={myInfo?.deckId || ''}
          onChange={(e) => send({ t: 'chooseDeck', deckId: e.target.value })}
          style={{
            flex: 1,
            minWidth: 0,
            background: 'rgba(0,0,0,0.35)',
            color: '#fff',
            border: '1px solid var(--glass-border)',
            borderRadius: 6,
            padding: 7,
            fontSize: 14,
            fontFamily: 'var(--font-family)',
          }}
        >
          <option value="" disabled>
            {Object.keys(library.deckNames).length ? 'Elige tu mazo…' : 'No hay mazos publicados'}
          </option>
          {Object.entries(library.deckNames).map(([id, name]) => (
            // Cada jugador con un mazo distinto: el del rival no se puede elegir
            <option key={id} value={id} disabled={!!oppInfo?.deckId && oppInfo.deckId === id}>
              {name} ({library.templates.filter((t) => t.deckId === id && !t.isLife).reduce((s, t) => s + (t.quantity || 1), 0)})
              {oppInfo?.deckId === id ? ' · lo usa tu rival' : ''}
            </option>
          ))}
        </select>
        <button className="btn-secondary" data-keep onClick={onReloadLibrary} title="Recargar mazos del servidor" style={{ padding: '6px 9px' }}>
          <RefreshCw size={14} />
        </button>
      </div>
      <button
        className="btn-primary"
        disabled={!myInfo?.deckId}
        onClick={() => spawnDeck('me')}
        style={{ ...btn, padding: 10, opacity: myInfo?.deckId ? 1 : 0.5 }}
      >
        <Layers size={15} /> Poner mi mazo barajado
      </button>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn-secondary" onClick={addToken} title="Añadir un token a la mesa" style={{ ...btn, flex: 1 }}>
          <span style={{ width: 13, height: 13, borderRadius: '50%', background: '#facc15', border: '2px solid #000', display: 'inline-block' }} /> Token
        </button>
        <button className="btn-secondary" onClick={() => setShowLog((v) => !v)} style={{ ...btn, flex: 1 }}>
          <MessageSquare size={14} /> Chat
          {unread > 0 && <span style={{ marginLeft: 2, background: 'var(--color-accent)', borderRadius: 10, padding: '0 6px', fontSize: 12 }}>{unread}</span>}
        </button>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn-primary" onClick={() => setShowEnd(true)} disabled={!oppInfo} style={{ ...btn, flex: 1, opacity: oppInfo ? 1 : 0.5 }} title="Registrar quién ha ganado">
          <Trophy size={14} /> Terminar partida
        </button>
        <button className="btn-secondary" onClick={() => setShowHistory(true)} style={{ ...btn, flex: 1 }} title="Ver quién ha ganado y con qué mazos">
          <History size={14} /> Historial
        </button>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          className="btn-danger"
          onClick={() =>
            confirm('Reiniciar mesa', 'Se retirarán todas las cartas y tokens de los dos jugadores y las vidas volverán a 10. ¿Seguro?', () => send({ t: 'reset' }))
          }
          style={{ ...btn, flex: 1 }}
        >
          Reiniciar
        </button>
        <button className="btn-danger" onClick={onLeave} style={{ ...btn, flex: 1 }}>
          <LogOut size={14} /> Salir
        </button>
      </div>
      <div style={{ fontSize: isTouch ? 15 : 12, color: 'var(--text-muted)', lineHeight: 1.45 }}>
        {compact
          ? 'Arrastra las cartas con el dedo. Toca tu biblioteca para robar (mantenla pulsada para barajar o mirar). Toca una carta para verla en grande y ver sus acciones; toca tu cementerio o tu vida para ver las suyas.'
          : isTouch
          ? 'Arrastra las cartas con el dedo. Toca una carta para verla en grande y ver sus acciones; toca la biblioteca para robar.'
          : 'Arrastra las cartas entre tus franjas. Clic en la biblioteca o R: robar · H: a la mano · G: al cementerio · T: token en la carta'}
      </div>
    </div>
  );

  const tokenDot: React.CSSProperties = { width: 12, height: 12, borderRadius: '50%', background: '#facc15', border: '2px solid #000', display: 'inline-block' };
  // Acciones de la carta seleccionada (barra flotante como en un jugador)
  const selectionBar = selectedCard && !compact && (
    <div
      className="glass-panel"
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        left: SIDE_W + PLAY_W / 2,
        top: BOARD_H / 2,
        transform: 'translate(-50%, -50%)',
        padding: '8px 14px',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        zIndex: 450000,
        fontSize: 14,
        whiteSpace: 'nowrap',
        boxShadow: '0 10px 30px rgba(0,0,0,0.6)',
      }}
    >
      <span style={{ fontWeight: 600, color: 'var(--text-muted)' }}>Carta:</span>
      <button className="btn-secondary" onClick={tokenOnCard} title="Poner un token en esta carta (T)" style={btn}>
        <span style={tokenDot} /> Token
      </button>
      <button className="btn-secondary" onClick={() => moveSelected('hand')} title="A la mano (H)" style={btn}>
        <Hand size={ui.icon} /> A la mano
      </button>
      <button className="btn-secondary" onClick={() => moveSelected('graveyard')} title="Al cementerio (G)" style={btn}>
        <Archive size={ui.icon} /> Cementerio
      </button>
    </div>
  );

  // Barra de acciones a tamaño normal para móvil (fuera de la mesa escalada)
  const barBtn: React.CSSProperties = { padding: '6px 10px', fontSize: 14 };
  const sideName = (side: SideKey) => (solo ? state.players[seatOf(side)]?.name : side === 'me' ? 'tu' : oppInfo?.name);
  let barTitle = '';
  let barContent: React.ReactNode = null;
  if (compact) {
    if (selectedCard) {
      barTitle = 'Carta';
      barContent = (
        <>
          <button className="btn-secondary" onClick={tokenOnCard} style={barBtn}>
            <span style={tokenDot} /> Token
          </button>
          <button className="btn-secondary" onClick={() => moveSelected('hand')} style={barBtn}>
            <Hand size={16} /> Mano
          </button>
          <button className="btn-secondary" onClick={() => moveSelected('graveyard')} style={barBtn}>
            <Archive size={16} /> Cementerio
          </button>
        </>
      );
    } else if (selectedHand || selectedOppHand) {
      const side: SideKey = selectedHand ? 'me' : 'opp';
      const id = (selectedHand || selectedOppHand)!.id!;
      barTitle = 'Mano';
      barContent = (
        <>
          {!solo && (
            <button className="btn-secondary" onClick={() => send({ t: 'reveal', id })} style={barBtn}>
              <Eye size={16} /> Enseñar
            </button>
          )}
          <button
            className="btn-secondary"
            onClick={() => {
              playAtEnd(side, { t: 'move', id, faceUp: true });
              setSelectedHandId(null);
            }}
            style={barBtn}
          >
            <Layers size={16} /> Jugar
          </button>
          <button
            className="btn-secondary"
            onClick={() => {
              playAtEnd(side, { t: 'move', id, faceUp: false });
              setSelectedHandId(null);
            }}
            style={barBtn}
          >
            <EyeOff size={16} /> Boca abajo
          </button>
          <button
            className="btn-secondary"
            onClick={() => {
              sendAs(side, { t: 'move', id, to: 'graveyard' });
              setSelectedHandId(null);
            }}
            style={barBtn}
          >
            <Archive size={16} /> Cementerio
          </button>
        </>
      );
    } else if (selectedTokenId) {
      barTitle = 'Token';
      barContent = (
        <button
          className="btn-danger"
          onClick={() => {
            send({ t: 'tokenDelete', id: selectedTokenId });
            setSelectedTokenId(null);
          }}
          style={barBtn}
        >
          <X size={16} /> Quitar token
        </button>
      );
    } else if (lifeSel) {
      const value = lifeSel === 'me' ? state.life.me : state.life.opp;
      barTitle = solo ? `Vida de ${deckNameOf(lifeSel) || sideName(lifeSel)}` : 'Tu vida';
      barContent = (
        <>
          <button className="btn-secondary" onClick={() => setLife(lifeSel, value - 1)} disabled={value <= LIFE_MIN} style={{ ...barBtn, fontSize: 22, padding: '4px 18px' }}>
            −
          </button>
          <span style={{ fontSize: 26, fontWeight: 700, minWidth: 36, textAlign: 'center' }}>{value}</span>
          <button className="btn-secondary" onClick={() => setLife(lifeSel, value + 1)} disabled={value >= LIFE_MAX} style={{ ...barBtn, fontSize: 22, padding: '4px 18px' }}>
            +
          </button>
        </>
      );
    }
  }

  return (
    <div className="tabletop-container" style={{ width: '100%', height: '100%', cursor: 'default', userSelect: 'none' }}>
      <div className="tabletop-grid" />
      <div className="tabletop-texture" />

      {/* Mesa escalada: misma disposición para los dos jugadores */}
      <div
        ref={areaRef}
        style={{
          position: 'absolute',
          // Sin meterse bajo la muesca ni la barra de inicio del móvil
          top: 'env(safe-area-inset-top, 0px)',
          right: 'env(safe-area-inset-right, 0px)',
          bottom: 'env(safe-area-inset-bottom, 0px)',
          left: 'env(safe-area-inset-left, 0px)',
        }}
        onPointerDown={() => {
          clearSelections();
          // Tocar el tablero vacío también quita la carta ampliada
          hidePressPreview();
        }}
      >
        <div
          ref={boardRef}
          style={{
            position: 'absolute',
            left: fit.left,
            top: fit.top,
            width: BOARD_W,
            height: L.boardH,
            transform: `scale(${fit.scale})`,
            transformOrigin: '0 0',
            touchAction: 'none', // el dedo arrastra cartas en vez de mover o ampliar la página
          }}
        >
          {(['opp', 'me'] as SideKey[]).flatMap((side) =>
            (['library', 'graveyard', 'play'] as ZoneKey[]).map((zone) =>
              band(side, zone, zone === 'play' ? (side === 'me' && !solo ? 'Tu zona de juego' : `Zona de juego de ${state.players[seatOf(side)]?.name || 'tu rival'}`) : ''),
            ),
          )}
          {!compact && roomPanel}
          {lifeCounter('opp')}
          {lifeCounter('me')}
          {libraryPile('opp')}
          {libraryPile('me')}
          {graveyardPile('opp')}
          {graveyardPile('me')}
          {oppHandTray()}
          {myHandTray()}
          {playCards('opp')}
          {playCards('me')}
          {selectionBar}
          {tokens}
          {ghost()}
          {solo && cardsOf('me') + cardsOf('opp') === 0 && (
            <div style={{ position: 'absolute', left: SIDE_W, top: L.boardH / 2 - 20, width: PLAY_W, textAlign: 'center', color: 'rgba(255,255,255,0.4)', fontSize: 22, pointerEvents: 'none' }}>
              Elige un mazo para cada jugador en el panel y pulsa el botón de al lado para ponerlo barajado
            </div>
          )}
          {!solo && !myCardsInGame && (
            <div style={{ position: 'absolute', left: SIDE_W, top: zoneRect('me', 'play').y + zoneRect('me', 'play').h * 0.4, width: PLAY_W, textAlign: 'center', color: 'rgba(255,255,255,0.4)', fontSize: 22, pointerEvents: 'none' }}>
              {myInfo?.deckId ? 'Pulsa "Poner mi mazo barajado" para empezar' : 'Elige tu mazo en el panel de la sala y pulsa "Poner mi mazo barajado"'}
            </div>
          )}
        </div>

        {/* Móvil: menú con el panel, pantalla completa y barra de acciones a tamaño normal */}
        {compact && (
          <div style={{ position: 'absolute', top: 8, left: 8, display: 'flex', gap: 6, zIndex: 650000 }} onPointerDown={(e) => e.stopPropagation()}>
            <button className="btn-secondary" onClick={() => setMenuOpen(true)} style={{ padding: 9, background: 'rgba(18,24,38,0.92)' }} title="Menú">
              <Menu size={20} />
            </button>
            <button className="btn-secondary" onClick={onFullscreen} style={{ padding: 9, background: 'rgba(18,24,38,0.92)' }} title="Pantalla completa">
              {fullscreen ? <Minimize size={20} /> : <Maximize size={20} />}
            </button>
          </div>
        )}
        {compact && menuOpen && (
          <div
            style={{ position: 'absolute', inset: 0, zIndex: 760000, background: 'rgba(5, 8, 16, 0.55)' }}
            onPointerDown={(e) => {
              e.stopPropagation();
              setMenuOpen(false);
            }}
          >
            <div
              style={{ position: 'absolute', left: 8, top: 8, maxHeight: 'calc(100% - 16px)', overflowY: 'auto', borderRadius: 16 }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                // Al pulsar una acción el menú se cierra para ver la mesa (salvo al preparar los mazos)
                const b = (e.target as HTMLElement).closest('button');
                if (b && !b.hasAttribute('data-keep')) setMenuOpen(false);
              }}
            >
              {roomPanel}
            </div>
          </div>
        )}
        {barContent && (
          <div
            className="glass-panel"
            onPointerDown={(e) => e.stopPropagation()}
            style={{
              // En la línea central, entre las dos zonas de juego, para no tapar manos ni montones
              position: 'absolute',
              top: fit.top + (L.boardH / 2) * fit.scale,
              left: '50%',
              transform: 'translate(-50%, -50%)',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 8px',
              zIndex: 640000,
              maxWidth: 'calc(100% - 130px)',
              overflowX: 'auto',
              whiteSpace: 'nowrap',
              boxShadow: '0 10px 30px rgba(0,0,0,0.6)',
            }}
          >
            <span style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 600, padding: '0 4px' }}>{barTitle}</span>
            {barContent}
            <button className="btn-secondary" onClick={clearSelections} style={{ padding: 8 }} title="Cerrar">
              <X size={16} />
            </button>
          </div>
        )}

        {/* Vista ampliada de la carta bajo el ratón */}
        {previewTemplate?.imageUrl && (
          <img
            src={previewTemplate.imageUrl}
            alt={previewTemplate.name}
            style={{
              position: 'absolute',
              top: 12,
              right: 12, // siempre en la misma esquina
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
            style={{ position: 'absolute', top: 12, right: 12, width: 300, height: 'min(460px, calc(100% - 24px))', display: 'flex', flexDirection: 'column', zIndex: 700000 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', padding: '10px 12px', borderBottom: '1px solid var(--glass-border)', fontSize: '0.8rem', fontWeight: 600 }}>
              <MessageSquare size={14} style={{ marginRight: 6 }} />
              <span style={{ flex: 1 }}>{solo ? 'Registro de la partida' : 'Partida y chat'}</span>
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
            {!solo && <form onSubmit={sendChat} style={{ display: 'flex', gap: 6, padding: 8, borderTop: '1px solid var(--glass-border)' }}>
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
            </form>}
          </div>
        )}

        {isTouch && portrait && (
          <div
            className="glass-panel"
            style={{ position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 750000, padding: '10px 18px', fontSize: '0.95rem', whiteSpace: 'nowrap' }}
          >
            {compact ? 'Gira el móvil en horizontal para jugar' : 'Gira la tablet en horizontal para ver la mesa más grande'}
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
            {solo
              ? `${peek.zone === 'library' ? 'Biblioteca' : 'Cementerio'} de ${state.players[peek.side || me]?.name}`
              : peek.zone === 'library'
                ? 'Tu biblioteca'
                : 'Tu cementerio'}
            : {peek.cards.length} {peek.cards.length === 1 ? 'carta' : 'cartas'} (de arriba a abajo)
          </h3>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 14 }}>
            {solo ? 'Puedes coger cualquiera a su mano.' : 'Solo tú las ves; tu rival sabe que las estás mirando. Puedes coger cualquiera a tu mano.'}
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
                      sendAs(peek.side === opp ? 'opp' : 'me', { t: 'takeFromPeek', id: c.id });
                      onPeekTaken(c.id);
                    }}
                  >
                    <Hand size={12} /> {solo ? 'A su mano' : 'A mi mano'}
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
                sendAs(peek.side === opp ? 'opp' : 'me', { t: 'shuffleLibrary' });
                onClosePeek();
              }}
            >
              <Shuffle size={14} /> Barajar y cerrar
            </button>
          )}
        </Overlay>
      )}

      {/* Fin de partida: quién ha ganado */}
      {showEnd && (
        <Overlay onClose={() => setShowEnd(false)}>
          <h3 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: 6 }}>¿Quién ha ganado?</h3>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 16 }}>
            {solo ? 'Se guardará en el historial de este ordenador con el campeón (mazo) de cada lado.' : 'Se guardará en el historial con los mazos de cada uno.'}
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
            {(['p1', 'p2'] as Seat[]).map((seat) => {
              const p = state.players[seat];
              if (!p) return null;
              return (
                <button
                  key={seat}
                  className="btn-primary"
                  style={{ padding: '10px 18px', fontSize: '0.95rem' }}
                  onClick={() => {
                    send({ t: 'endMatch', winner: seat, reset: endReset });
                    setShowEnd(false);
                  }}
                >
                  <Trophy size={15} />{' '}
                  {solo && p.deckId && library.deckNames[p.deckId] ? (
                    <>
                      {library.deckNames[p.deckId]}
                      <span style={{ opacity: 0.75, fontWeight: 400 }}> · {p.name}</span>
                    </>
                  ) : (
                    <>
                      {p.name}
                      {seat === me ? ' (tú)' : ''}
                      {p.deckId && library.deckNames[p.deckId] ? <span style={{ opacity: 0.75, fontWeight: 400 }}> · {library.deckNames[p.deckId]}</span> : null}
                    </>
                  )}
                </button>
              );
            })}
            <button
              className="btn-secondary"
              style={{ padding: '10px 18px', fontSize: '0.95rem' }}
              onClick={() => {
                send({ t: 'endMatch', winner: 'draw', reset: endReset });
                setShowEnd(false);
              }}
            >
              Empate
            </button>
          </div>
          <label style={{ fontSize: '0.82rem', color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={endReset} onChange={(e) => setEndReset(e.target.checked)} />
            Limpiar la mesa para jugar otra (vidas a 10)
          </label>
        </Overlay>
      )}

      {showHistory && (
        <MatchHistory serverUrl={serverUrl} roomCode={solo ? undefined : state.code} localResults={solo ? localResults?.() : undefined} onClose={() => setShowHistory(false)} />
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

// Posiciones x de las cartas de una mano dentro de su franja (se solapan si no caben)
function handSlots(n: number, r: Rect): number[] {
  if (n === 0) return [];
  const pad = 16;
  const avail = r.w - pad * 2;
  const step = n === 1 ? 0 : Math.min(SMALL_W + 10, (avail - SMALL_W) / (n - 1));
  const total = SMALL_W + step * (n - 1);
  const start = r.x + (r.w - total) / 2;
  return Array.from({ length: n }, (_, i) => start + i * step);
}

// Marco de carta con el mismo aspecto que la mesa de un jugador
const cardFrame = {
  position: 'absolute',
  borderRadius: 'var(--card-radius)',
  overflow: 'hidden',
  border: '2px solid rgba(255, 255, 255, 0.05)',
  boxShadow: '0 4px 10px rgba(0, 0, 0, 0.3)',
  background: '#1e293b',
} satisfies React.CSSProperties;

const imgStyle: React.CSSProperties = {
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  display: 'block',
  pointerEvents: 'none',
};

const pill: React.CSSProperties = {
  position: 'absolute',
  transform: 'translateX(-50%)',
  padding: '3px 12px',
  borderRadius: 20,
  border: '1px solid var(--color-accent)',
  background: 'rgba(18, 24, 38, 0.92)',
  color: '#fff',
  fontSize: 14,
  fontWeight: 700,
  whiteSpace: 'nowrap',
  zIndex: 15,
  pointerEvents: 'none',
  boxShadow: '0 4px 10px rgba(0,0,0,0.5)',
};


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
