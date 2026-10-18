// Mesa de 3 jugadores (todos contra todos) y de 2 contra 2.
// Cada jugador tiene su recuadro: arriba los demás y abajo (más grande) el tuyo.
// En cada recuadro van juntas la carta de vida, la biblioteca y el cementerio, al lado
// de la mano, y encima (o debajo) su zona de juego. Las posiciones de las cartas en
// juego se guardan en las medidas de la mesa de 1 contra 1 (PLAY_W x PLAY_H) y se
// estiran al tamaño de cada recuadro, así todos ven las cartas en el mismo sitio.
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  BookOpen,
  Copy,
  Crosshair,
  Eye,
  EyeOff,
  Hand,
  Maximize,
  Menu,
  MessageSquare,
  Minimize,
  LogOut,
  RefreshCw,
  RotateCw,
  Shuffle,
  Smile,
  Swords,
  Trophy,
  X,
} from 'lucide-react';
import type { CardTemplate } from '../types';
import type { CardBackInfo, LogEntry, MultiState, OnlinePlayCard, PeekResult, Seat, ServerLibrary } from './types';
import { CARD_H, CARD_W, LIFE_CARD_RATIO, LIFE_MAX, LIFE_MIN, LIFE_TRACK, PLAY_H, PLAY_W, clamp } from './layout';
import { inviteLink } from './server';
import { EmojiPicker, MicButton, RecordingBar, VoiceMessage, isEmojiOnly, useVoiceRecorder } from './ChatExtras';
import { Overlay, brushArrow, playChatSound, seededRandom, useBackColor, type BrushArrow } from './OnlineTable';
import { IOS_FULLSCREEN_HINT, fullscreenSupported, toggleFullscreen, useIsFullscreen } from '../fullscreen';
import { appPoint, appRect } from '../rotation';
import type { ConnectionStatus } from './useOnlineGame';

interface MultiTableProps {
  state: MultiState;
  status: ConnectionStatus;
  library: ServerLibrary;
  serverUrl: string;
  send: (msg: object) => void;
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

type Rect = { x: number; y: number; w: number; h: number };
type DropZone = 'play' | 'hand' | 'graveyard' | 'library';

// Lo que se puede arrastrar o tocar
type Src =
  | { kind: 'hand'; id: string; templateId?: string; back: CardBackInfo }
  | { kind: 'play'; id: string; seat: Seat; card: OnlinePlayCard }
  | { kind: 'library'; back: CardBackInfo }
  | { kind: 'graveyard'; seat: Seat; id: string; back: CardBackInfo };

type Sel = { kind: 'play'; id: string; seat: Seat } | { kind: 'hand'; id: string } | { kind: 'library' } | { kind: 'graveyard' } | null;

interface Drag {
  src: Src;
  startX: number; // pantalla
  startY: number;
  x: number; // puntero en la mesa lógica
  y: number;
  gx: number; // dónde se ha cogido el objeto
  gy: number;
  w: number;
  h: number;
  moved: boolean;
}

const BOARD_W = 1920;
const TEAM_COLORS = { A: '#38bdf8', B: '#f97316' } as const;
const backKey = (b: CardBackInfo) => `${b.backType}-${b.deckId}`;
const isTarget = (el: Element | null) => el?.closest('[data-drop]') as HTMLElement | null;

// Medidas de cada recuadro: franja (datos, vida, biblioteca, cementerio y mano) y zona de juego
function boxParts(r: Rect, top: boolean, big: boolean, compact: boolean) {
  const pad = 10;
  const stripH = big ? Math.min(compact ? 215 : 200, r.h * 0.42) : Math.min(compact ? 135 : 150, r.h * 0.38);
  const stripY = top ? r.y + pad : r.y + r.h - pad - stripH;
  const play: Rect = { x: r.x + pad, y: top ? stripY + stripH + pad : r.y + pad, w: r.w - 2 * pad, h: r.h - stripH - 3 * pad };
  const ph = stripH - 8;
  const pw = (ph * CARD_W) / CARD_H;
  const lw = ph * LIFE_CARD_RATIO;
  const infoW = big ? (compact ? 250 : 215) : compact ? 175 : 175;
  const y = stripY + 4;
  const info: Rect = { x: r.x + pad, y, w: infoW, h: ph };
  const life: Rect = { x: info.x + infoW + 8, y, w: lw, h: ph };
  const lib: Rect = { x: life.x + lw + 12, y, w: pw, h: ph };
  const grave: Rect = { x: lib.x + pw + 10, y, w: pw, h: ph };
  const hand: Rect = { x: grave.x + pw + 18, y, w: Math.max(pw, r.x + r.w - pad - (grave.x + pw + 18)), h: ph };
  return { play, info, life, lib, grave, hand, strip: { x: r.x + pad, y: stripY, w: r.w - 2 * pad, h: stripH } };
}

export const MultiTable: React.FC<MultiTableProps> = ({
  state,
  status,
  library,
  serverUrl,
  send,
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
  const seats = state.seats;
  const myInfo = state.players[me];
  const teamOf = (s: Seat): 'A' | 'B' | null => (state.teams ? (state.teams.A.includes(s) ? 'A' : 'B') : null);
  const ally = state.teams ? seats.find((s) => s !== me && teamOf(s) === teamOf(me)) : undefined;
  // Los demás en el orden de la ronda, empezando por el siguiente a ti
  const others = useMemo(() => {
    const i = seats.indexOf(me);
    return [...seats.slice(i + 1), ...seats.slice(0, i)];
  }, [seats, me]);
  const nameOf = (s: Seat) => state.players[s]?.name || 'Esperando…';

  const templateMap = useMemo(() => new Map<string, CardTemplate>(library.templates.map((t) => [t.id, t])), [library.templates]);
  useEffect(() => {
    for (const url of Object.values(library.backs)) new Image().src = url;
  }, [library.backs]);

  // Color de cada jugador: el del reverso de su campeón (en 2 contra 2, el de su equipo)
  const backUrlOf = (s: Seat) => {
    const id = state.players[s]?.deckId;
    return id ? library.backs[`backA-${id}`] || library.backs[`backB-${id}`] : undefined;
  };
  const c1 = useBackColor(backUrlOf('p1'));
  const c2 = useBackColor(backUrlOf('p2'));
  const c3 = useBackColor(backUrlOf('p3'));
  const c4 = useBackColor(backUrlOf('p4'));
  const backColor: Record<Seat, string> = { p1: c1 || '#a78bfa', p2: c2 || '#f87171', p3: c3 || '#34d399', p4: c4 || '#fbbf24' };
  // Si dos jugadores llevan el mismo campeón, cada uno con un color propio para distinguirlos
  const SEAT_COLORS: Record<Seat, string> = { p1: '#f472b6', p2: '#fbbf24', p3: '#34d399', p4: '#60a5fa' };
  const sameDeck = (s: Seat) => !!state.players[s]?.deckId && seats.some((o) => o !== s && state.players[o]?.deckId === state.players[s]?.deckId);
  const colorOf = (s: Seat) => (state.teams ? TEAM_COLORS[teamOf(s)!] : sameDeck(s) ? SEAT_COLORS[s] : backColor[s]);

  // ---------- Escalado ----------
  const areaRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState({ scale: 1, left: 0, top: 0, h: 1080, compact: false });
  const compact = fit.compact;
  const boardH = fit.h;
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (!w || !h) return;
      const compactNow = Math.min(w / BOARD_W, h / 1080) < 0.55;
      // La mesa se estira en alto para ocupar toda la pantalla
      const bh = clamp((BOARD_W * h) / w, compactNow ? 720 : 860, 1250);
      const scale = Math.min(w / BOARD_W, h / bh);
      setFit({ scale, left: (w - BOARD_W * scale) / 2, top: (h - bh * scale) / 2, h: bh, compact: compactNow });
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

  // ---------- Recuadros de cada jugador ----------
  const boxes = useMemo(() => {
    const out = {} as Record<Seat, { r: Rect; top: boolean; big: boolean }>;
    const H = boardH;
    if (compact) {
      // Móvil: los demás en una fila arriba y tú grande abajo (en 2 contra 2, tu compañero primero)
      const row = ally ? [ally, ...others.filter((s) => s !== ally)] : others;
      const topH = Math.round(H * 0.38);
      row.forEach((s, i) => (out[s] = { r: { x: (BOARD_W / row.length) * i, y: 0, w: BOARD_W / row.length, h: topH }, top: true, big: false }));
      out[me] = { r: { x: 0, y: topH, w: BOARD_W, h: H - topH }, top: false, big: true };
    } else if (ally) {
      // 2 contra 2: los rivales arriba, tú abajo a la izquierda y tu compañero abajo a la derecha
      const rivals = others.filter((s) => s !== ally);
      const half = H / 2;
      rivals.forEach((s, i) => (out[s] = { r: { x: (BOARD_W / 2) * i, y: 0, w: BOARD_W / 2, h: half }, top: true, big: false }));
      out[me] = { r: { x: 0, y: half, w: BOARD_W / 2, h: half }, top: false, big: true };
      out[ally] = { r: { x: BOARD_W / 2, y: half, w: BOARD_W / 2, h: half }, top: false, big: false };
    } else {
      const topH = Math.round(H * 0.45);
      others.forEach((s, i) => (out[s] = { r: { x: (BOARD_W / others.length) * i, y: 0, w: BOARD_W / others.length, h: topH }, top: true, big: false }));
      out[me] = { r: { x: 0, y: topH, w: BOARD_W, h: H - topH }, top: false, big: true };
    }
    return out;
  }, [boardH, compact, ally, others, me]);
  const parts = useMemo(() => {
    const out = {} as Record<Seat, ReturnType<typeof boxParts>>;
    for (const s of seats) if (boxes[s]) out[s] = boxParts(boxes[s].r, boxes[s].top, boxes[s].big, compact);
    return out;
  }, [boxes, seats, compact]);
  // Escala de la zona de juego de cada jugador: posición estirada, cartas sin deformar
  const playScale = (s: Seat) => {
    const z = parts[s].play;
    const sx = z.w / PLAY_W;
    const sy = z.h / PLAY_H;
    return { sx, sy, k: Math.min(sx, sy) };
  };
  const playRect = (s: Seat, c: { x: number; y: number }) => {
    const z = parts[s].play;
    const { sx, sy, k } = playScale(s);
    return { x: z.x + c.x * sx, y: z.y + c.y * sy, w: CARD_W * k, h: CARD_H * k };
  };

  // ---------- Estado de la mesa ----------
  const [sel, setSel] = useState<Sel>(null);
  const [pointing, setPointing] = useState<{ from: string; targets: string[] } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [hover, setHover] = useState<string | null>(null); // templateId bajo el ratón
  const [previewBig, setPreviewBig] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showEnd, setShowEnd] = useState(false);
  const [endReset, setEndReset] = useState(true);
  const [pickClosed, setPickClosed] = useState(false);
  const [forcePick, setForcePick] = useState(false); // elegir otro campeón desde el menú
  const isTouch = useMemo(() => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches, []);
  const fullscreen = useIsFullscreen();

  useEffect(() => {
    if (!myInfo?.deckId) setPickClosed(false);
  }, [myInfo?.deckId]);

  const allPlay = useMemo(() => seats.flatMap((s) => state.sides[s]?.play.map((c) => ({ c, s })) || []), [seats, state.sides]);
  const myHand = state.sides[me]?.hand || [];
  // La selección se quita sola si la carta ya no está donde estaba
  useEffect(() => {
    if (sel?.kind === 'play' && !allPlay.some((p) => p.c.id === sel.id)) setSel(null);
    if (sel?.kind === 'hand' && !myHand.some((c) => c.id === sel.id)) setSel(null);
    if (pointing && !allPlay.some((p) => p.c.id === pointing.from)) setPointing(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allPlay, myHand]);

  const clearSel = () => {
    if (sel?.kind === 'play') send({ t: 'select', id: null });
    setSel(null);
    setPreviewBig(false);
  };

  // ---------- Acciones ----------
  const freeSpot = () => {
    const n = state.sides[me]?.play.length || 0;
    const perRow = Math.floor((PLAY_W - 40) / (CARD_W + 20));
    return { x: 30 + (n % perRow) * (CARD_W + 20), y: (PLAY_H - CARD_H) / 2 };
  };
  const playFromHand = (id: string, faceUp: boolean) => send({ t: 'move', id, to: 'play', faceUp, ...freeSpot() });
  const toGraveyard = (id: string, owner: Seat) => send({ t: 'move', id, to: 'graveyard', toSeat: owner });
  const tokensOf = (id: string) => state.tokens.filter((t) => t.cardId === id);
  const setLife = (value: number) => send({ t: 'life', value: clamp(value, LIFE_MIN, LIFE_MAX) });
  const pickDeck = (deckId: string) => {
    const go = () => {
      send({ t: 'chooseDeck', deckId });
      send({ t: 'spawnDeck' });
    };
    const mine = allPlay.filter((p) => p.c.owner === me).length + myHand.length + (state.sides[me]?.library.count || 0);
    if (mine > 0 && myInfo?.deckId) confirm('Cambiar de mazo', 'Se retirarán todas tus cartas y se pondrá el nuevo mazo barajado. ¿Seguro?', go);
    else go();
  };
  const sendPoint = (from: string, targets: string[]) => {
    setPointing({ from, targets });
    send({ t: 'point', from, targets });
  };
  const togglePointTarget = (id: string) => {
    if (!pointing) return;
    const has = pointing.targets.includes(id);
    if (!has && pointing.targets.length >= 3) return toast('Como mucho 3 objetivos');
    sendPoint(pointing.from, has ? pointing.targets.filter((t) => t !== id) : [...pointing.targets, id]);
  };

  // ---------- Arrastrar y tocar ----------
  const startDrag = (e: React.PointerEvent, src: Src, rect: Rect) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const p = toBoard(e.clientX, e.clientY);
    const d: Drag = { src, startX: e.clientX, startY: e.clientY, x: p.x, y: p.y, gx: p.x - rect.x, gy: p.y - rect.y, w: rect.w, h: rect.h, moved: false };
    dragRef.current = d;
    setDrag(d);
  };

  const tap = (src: Src) => {
    if (pointing) {
      if (src.kind === 'play' && src.id !== pointing.from) togglePointTarget(src.id);
      return;
    }
    if (src.kind === 'play') {
      if (sel?.kind === 'play' && sel.id === src.id) return clearSel();
      setSel({ kind: 'play', id: src.id, seat: src.seat });
      send({ t: 'select', id: src.id });
    } else if (src.kind === 'hand') {
      if (sel?.kind === 'hand' && sel.id === src.id) return setSel(null);
      if (sel?.kind === 'play') send({ t: 'select', id: null });
      setSel({ kind: 'hand', id: src.id });
    } else if (src.kind === 'library') {
      setSel(sel?.kind === 'library' ? null : { kind: 'library' });
    } else if (src.kind === 'graveyard' && src.seat === me) {
      setSel(sel?.kind === 'graveyard' ? null : { kind: 'graveyard' });
    }
  };

  const drop = (src: Src, zone: DropZone, seat: Seat, at: { x: number; y: number }) => {
    const base = src.kind === 'library' ? { from: 'library' } : { id: src.id };
    if (zone === 'play') {
      if (seat !== me) return;
      const z = parts[me].play;
      const { sx, sy } = playScale(me);
      const x = clamp((at.x - z.x) / sx - CARD_W / 2, 0, PLAY_W - CARD_W);
      const y = clamp((at.y - z.y) / sy - CARD_H / 2, 0, PLAY_H - CARD_H);
      return send({ t: 'move', ...base, to: 'play', x, y });
    }
    if (zone === 'graveyard') {
      // A tu cementerio, o al del dueño de la carta
      const owner = src.kind === 'play' ? src.card.owner : me;
      if (seat !== me && seat !== owner) return;
      if (src.kind === 'graveyard' && src.seat === seat) return;
      return send({ t: 'move', ...base, to: 'graveyard', toSeat: seat });
    }
    if (seat !== me) return;
    if (zone === 'hand' && src.kind !== 'hand') return send({ t: 'move', ...base, to: 'hand' });
    if (zone === 'library' && src.kind !== 'library') return send({ t: 'move', ...base, to: 'library' });
  };

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const p = toBoard(e.clientX, e.clientY);
      const moved = d.moved || Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > 7;
      const next = { ...d, x: p.x, y: p.y, moved };
      dragRef.current = next;
      if (moved) setDrag(next);
    };
    const up = (e: PointerEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!d) return;
      if (!d.moved) return tap(d.src);
      const el = document.elementsFromPoint(e.clientX, e.clientY).map(isTarget).find(Boolean);
      if (!el) return;
      const [zone, seat] = (el.dataset.drop || '').split(':') as [DropZone, Seat];
      drop(d.src, zone, seat, toBoard(e.clientX, e.clientY));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!drag, toBoard]);

  // ---------- Chat, emojis y audios (igual que en 1 contra 1) ----------
  const [showLog, setShowLog] = useState(false);
  const [chatText, setChatText] = useState('');
  const [emojiOpen, setEmojiOpen] = useState<'board' | 'panel' | null>(null);
  const [micSlide, setMicSlide] = useState(0);
  const chatIds = () => new Set(state.log.filter((e) => e.kind === 'chat').map((e) => e.id));
  const [seenChat, setSeenChat] = useState(chatIds);
  const toastedChat = useRef(chatIds());
  const burstSeen = useRef(chatIds());
  const [chatToasts, setChatToasts] = useState<{ id: string; text: string; leaving?: boolean }[]>([]);
  const [bursts, setBursts] = useState<{ id: string; text: string; by: Seat }[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);

  const voice = useVoiceRecorder(
    (clip) => send({ t: 'voice', ...clip }),
    (message) => toast(message),
  );
  const audioUrl = (id: string) => `${serverUrl}/api/audio?room=${encodeURIComponent(state.code)}&id=${encodeURIComponent(id)}`;
  const voiceOf = (entry: LogEntry) =>
    entry.audio && (
      <VoiceMessage
        id={entry.audio.id}
        url={audioUrl(entry.audio.id)}
        dur={entry.audio.dur}
        wave={entry.audio.wave}
        mine={entry.by === me}
        heard={entry.audio.heard}
        color={entry.by ? colorOf(entry.by) : undefined}
        onPlayed={() => !entry.audio?.heard && send({ t: 'voiceHeard', id: entry.audio?.id })}
      />
    );
  const sendChat = (e: React.FormEvent) => {
    e.preventDefault();
    const text = chatText.trim();
    if (!text) return;
    send({ t: 'chat', text });
    setChatText('');
    setEmojiOpen(null);
  };

  useEffect(() => {
    onReloadLibrary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Presencia: si esta ventana tiene la partida a la vista
  useEffect(() => {
    if (status !== 'open') return;
    const report = () => send({ t: 'visibility', visible: document.visibilityState === 'visible' });
    report();
    document.addEventListener('visibilitychange', report);
    return () => document.removeEventListener('visibilitychange', report);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);
  useEffect(() => {
    if (showLog) {
      setSeenChat(chatIds());
      logEndRef.current?.scrollIntoView({ block: 'end' });
      setChatToasts([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showLog, state.log]);
  useEffect(() => {
    const unseen = state.log.filter((e) => e.kind === 'chat' && !toastedChat.current.has(e.id));
    for (const e of unseen) toastedChat.current.add(e.id);
    if (showLog) return;
    const fresh = unseen.filter((e) => e.by && e.by !== me && !e.reaction);
    if (!fresh.length) return;
    playChatSound();
    setChatToasts((prev) => [...prev, ...fresh.map((e) => ({ id: e.id, text: e.text }))].slice(-3));
    for (const e of fresh) {
      const wait = e.audio ? 15000 : 5000;
      window.setTimeout(() => setChatToasts((prev) => prev.map((t) => (t.id === e.id ? { ...t, leaving: true } : t))), wait);
      window.setTimeout(() => setChatToasts((prev) => prev.filter((t) => t.id !== e.id)), wait + 400);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.log]);
  // Emojis sueltos: salen grandes en el recuadro de quien los manda
  useEffect(() => {
    const fresh = state.log.filter((e) => e.kind === 'chat' && !burstSeen.current.has(e.id));
    for (const e of fresh) burstSeen.current.add(e.id);
    const emo = fresh
      .filter((e) => !e.audio && e.by)
      .map((e) => ({ id: e.id, text: e.text.slice((state.players[e.by!]?.name || '').length + 2), by: e.by! }))
      .filter((b) => isEmojiOnly(b.text));
    if (!emo.length) return;
    setBursts((prev) => [...prev, ...emo].slice(-4));
    for (const b of emo) window.setTimeout(() => setBursts((prev) => prev.filter((x) => x.id !== b.id)), 2600);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.log]);
  useEffect(() => {
    if (emojiOpen !== 'board') return;
    const close = () => setEmojiOpen(null);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [emojiOpen]);
  const unread = showLog ? 0 : state.log.filter((e) => e.kind === 'chat' && e.by && e.by !== me && !e.reaction && !seenChat.has(e.id)).length;

  // Nombres de los jugadores con su color en el registro
  const logText = (text: string) => {
    const people = seats
      .map((s) => ({ name: state.players[s]?.name, color: colorOf(s) }))
      .filter((p): p is { name: string; color: string } => !!p.name)
      .sort((a, b) => b.name.length - a.name.length);
    if (!people.length) return text;
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(${people.map((p) => esc(p.name)).join('|')})`, 'g');
    return text.split(re).map((piece, i) => {
      if (!piece) return null;
      const who = i % 2 === 1 ? people.find((p) => p.name === piece) : null;
      return who ? (
        <b key={i} style={{ color: who.color }}>
          {piece}
        </b>
      ) : (
        <React.Fragment key={i}>{piece}</React.Fragment>
      );
    });
  };
  const chatBody = (entry: LogEntry) => {
    if (entry.kind !== 'chat' || !entry.by) return null;
    const prefix = `${state.players[entry.by]?.name || ''}: `;
    if (!entry.text.startsWith(prefix)) return null;
    const rest = entry.text.slice(prefix.length);
    if (entry.audio)
      return (
        <>
          {logText(prefix)}
          <div style={{ marginTop: 4 }}>{voiceOf(entry)}</div>
        </>
      );
    if (isEmojiOnly(rest))
      return (
        <>
          {logText(prefix)}
          <span style={{ fontSize: '1.9rem', lineHeight: 1.15, verticalAlign: 'middle' }}>{rest}</span>
        </>
      );
    return null;
  };

  // ---------- Pintado ----------
  const fs = compact ? 30 : 20; // letra dentro de la mesa (en medidas lógicas)
  const cardFace = (templateId: string | undefined, back: CardBackInfo, radius: number) => {
    const t = templateId ? templateMap.get(templateId) : undefined;
    const url = t?.imageUrl || library.backs[backKey(back)];
    return url ? (
      <img src={url} alt={t?.name || 'Reverso'} draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: radius, display: 'block', pointerEvents: 'none' }} />
    ) : (
      <div style={{ width: '100%', height: '100%', borderRadius: radius, background: 'linear-gradient(135deg,#1e293b,#0f172a)', border: '2px solid rgba(255,255,255,0.15)' }} />
    );
  };
  const countBadge = (n: number) => (
    <div
      style={{
        position: 'absolute',
        right: 4,
        bottom: 4,
        background: 'rgba(0,0,0,0.75)',
        borderRadius: 8,
        padding: '0 8px',
        fontSize: fs * 0.95,
        fontWeight: 700,
        pointerEvents: 'none',
      }}
    >
      {n}
    </div>
  );
  const hoverProps = (templateId?: string) =>
    !isTouch && templateId ? { onPointerEnter: () => setHover(templateId), onPointerLeave: () => setHover((h) => (h === templateId ? null : h)) } : {};

  // Rectángulos de las cartas en juego y de las cartas de vida (para las flechas)
  const targetRects = new Map<string, Rect>();

  const renderBox = (s: Seat) => {
    const box = boxes[s];
    const P = parts[s];
    if (!box || !P) return null;
    const info = state.players[s];
    const side = state.sides[s];
    const mine = s === me;
    const color = colorOf(s);
    const team = teamOf(s);
    const presence = !info || info.left || !info.connected ? 'off' : info.visible === false ? 'away' : 'on';
    const value = clamp(state.lives[s] ?? 10, LIFE_MIN, LIFE_MAX);
    const lifeTpl = info?.deckId ? library.templates.find((t) => t.deckId === info.deckId && t.isLife && t.imageUrl) : undefined;
    const deckName = info?.deckId ? library.deckNames[info.deckId] : null;
    const { k } = playScale(s);
    targetRects.set(`life:${s}`, P.life);
    const lifeTargeted = !!pointing?.targets.includes(`life:${s}`) || !!(state.pointer && state.pointer.targets.includes(`life:${s}`));
    const btn = compact ? 64 : 42;
    const libTop = side?.library.top;
    const graveTop = side?.graveyard[side.graveyard.length - 1];
    const hand = side?.hand || [];
    const step = hand.length > 1 ? Math.min(P.hand.h * (CARD_W / CARD_H) + 8, (P.hand.w - P.lib.w) / (hand.length - 1)) : 0;
    const handW = P.lib.w;

    return (
      <React.Fragment key={s}>
        {/* Fondo del recuadro */}
        <div
          style={{
            position: 'absolute',
            left: box.r.x + 4,
            top: box.r.y + 4,
            width: box.r.w - 8,
            height: box.r.h - 8,
            borderRadius: 18,
            border: `3px solid ${color}${mine ? '' : '88'}`,
            background: mine ? 'rgba(255,255,255,0.045)' : 'rgba(0,0,0,0.18)',
            boxShadow: mine ? `0 0 26px ${color}55` : undefined,
          }}
        />
        {/* Zona de juego */}
        <div
          data-drop={`play:${s}`}
          style={{ position: 'absolute', left: P.play.x, top: P.play.y, width: P.play.w, height: P.play.h, borderRadius: 14, background: 'rgba(0,0,0,0.22)', border: '2px dashed rgba(255,255,255,0.08)' }}
        />
        {side?.play.map((c) => {
          const r = playRect(s, c);
          targetRects.set(c.id, r);
          const selected = sel?.kind === 'play' && sel.id === c.id;
          const otherSel = seats.find((o) => o !== me && state.sides[o]?.selected === c.id);
          const targeted = !!pointing?.targets.includes(c.id);
          const isFrom = pointing?.from === c.id;
          const toks = tokensOf(c.id);
          const outline = selected || isFrom ? `0 0 0 4px #fff, 0 0 18px ${colorOf(me)}` : targeted ? '0 0 0 4px #ef4444' : otherSel ? `0 0 0 4px ${colorOf(otherSel)}` : '0 6px 14px rgba(0,0,0,0.5)';
          return (
            <div
              key={c.id}
              data-play={s}
              onPointerDown={(e) => startDrag(e, { kind: 'play', id: c.id, seat: s, card: c }, r)}
              {...hoverProps(c.isFaceUp ? c.templateId : undefined)}
              style={{
                position: 'absolute',
                left: r.x,
                top: r.y,
                width: r.w,
                height: r.h,
                zIndex: 100 + c.order,
                transform: `rotate(${c.rotation}deg)`,
                transition: 'transform 0.25s',
                borderRadius: 8 * k + 2,
                boxShadow: outline,
                cursor: 'grab',
                opacity: drag?.moved && drag.src.kind === 'play' && drag.src.id === c.id ? 0.35 : 1,
              }}
            >
              {cardFace(c.isFaceUp ? c.templateId : undefined, c, 8 * k + 2)}
              {toks.map((t) => (
                <div
                  key={t.id}
                  style={{
                    position: 'absolute',
                    left: (t.rx ?? 0.8) * r.w - r.w * 0.12,
                    top: (t.ry ?? 0.8) * r.h - r.w * 0.12,
                    width: r.w * 0.24,
                    height: r.w * 0.24,
                    borderRadius: '50%',
                    background: 'radial-gradient(circle at 35% 30%, #fde68a, #facc15 55%, #ca8a04)',
                    border: `${Math.max(2, r.w * 0.025)}px solid #000`,
                    pointerEvents: 'none',
                  }}
                />
              ))}
            </div>
          );
        })}

        {/* Datos del jugador */}
        <div style={{ position: 'absolute', left: P.info.x, top: P.info.y, width: P.info.w, height: P.info.h, display: 'flex', flexDirection: 'column', gap: compact ? 6 : 4, fontSize: fs, lineHeight: 1.15 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden' }}>
            <span className={`ol-presence ol-presence-${presence}`} style={{ width: fs * 0.55, height: fs * 0.55, flexShrink: 0 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', color }}>{nameOf(s)}</span>
          </div>
          <div style={{ fontSize: fs * 0.75, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {mine ? 'Tú' : team ? (teamOf(me) === team ? 'Compañero' : 'Rival') : 'Rival'}
            {team && <span style={{ color: TEAM_COLORS[team] }}> · Equipo {team}</span>}
            {deckName && ` · ${deckName}`}
          </div>
          {state.starter === s && !state.started && (
            <div style={{ fontSize: fs * 0.75, color: '#facc15', fontWeight: 700 }}>
              <Swords size={fs * 0.7} style={{ verticalAlign: 'middle' }} /> Empieza
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 'auto' }}>
            <span style={{ fontSize: fs * 1.5, fontWeight: 800 }}>♥ {value}</span>
          </div>
          {mine && (
            <div onPointerDown={(e) => e.stopPropagation()} style={{ display: 'flex', gap: compact ? 14 : 10 }}>
              <button className="life-counter-btn" style={{ width: btn, height: btn, fontSize: btn * 0.6 }} onClick={() => setLife(value - 1)} disabled={value <= LIFE_MIN} title="Restar vida">
                −
              </button>
              <button className="life-counter-btn" style={{ width: btn, height: btn, fontSize: btn * 0.6 }} onClick={() => setLife(value + 1)} disabled={value >= LIFE_MAX} title="Sumar vida">
                +
              </button>
            </div>
          )}
        </div>

        {/* Carta de vida: también se puede señalar (si es de otro jugador) */}
        <div
          data-life={s}
          onPointerDown={(e) => {
            if (!pointing || mine) return;
            e.stopPropagation();
            togglePointTarget(`life:${s}`);
          }}
          style={{
            position: 'absolute',
            left: P.life.x,
            top: P.life.y,
            width: P.life.w,
            height: P.life.h,
            borderRadius: 10,
            overflow: 'hidden',
            boxShadow: lifeTargeted ? '0 0 0 4px #ef4444, 0 0 20px #ef4444' : `0 0 0 2px ${color}88`,
            cursor: pointing && !mine ? 'crosshair' : 'default',
            background: 'rgba(0,0,0,0.3)',
          }}
        >
          {lifeTpl?.imageUrl ? (
            <>
              <img src={lifeTpl.imageUrl} alt="Vida" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }} />
              <div
                style={{
                  position: 'absolute',
                  left: LIFE_TRACK[value][0] * P.life.w - P.life.w * 0.09,
                  top: LIFE_TRACK[value][1] * P.life.h - P.life.w * 0.09,
                  width: P.life.w * 0.18,
                  height: P.life.w * 0.18,
                  borderRadius: '50%',
                  background: 'radial-gradient(circle at 35% 30%, #fde68a, #facc15 55%, #ca8a04)',
                  border: '2px solid #000',
                  transition: 'left 0.3s, top 0.3s',
                  pointerEvents: 'none',
                }}
              />
            </>
          ) : (
            <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: fs * 2, fontWeight: 800 }}>{value}</div>
          )}
        </div>

        {/* Biblioteca */}
        <div
          data-drop={`library:${s}`}
          onPointerDown={mine && libTop ? (e) => startDrag(e, { kind: 'library', back: libTop }, P.lib) : undefined}
          title={mine ? 'Tu biblioteca: tócala para robar, barajar o mirar' : `Biblioteca de ${nameOf(s)}`}
          style={{
            position: 'absolute',
            left: P.lib.x,
            top: P.lib.y,
            width: P.lib.w,
            height: P.lib.h,
            borderRadius: 8,
            cursor: mine ? 'pointer' : 'default',
            boxShadow: sel?.kind === 'library' && mine ? '0 0 0 4px #fff' : '0 4px 10px rgba(0,0,0,0.5)',
            border: libTop ? undefined : '2px dashed rgba(255,255,255,0.2)',
          }}
        >
          {libTop && cardFace(undefined, libTop, 8)}
          {countBadge(side?.library.count || 0)}
        </div>

        {/* Cementerio */}
        <div
          data-drop={`graveyard:${s}`}
          onPointerDown={graveTop ? (e) => startDrag(e, { kind: 'graveyard', seat: s, id: graveTop.id, back: graveTop }, P.grave) : undefined}
          title={`Cementerio de ${nameOf(s)}`}
          style={{
            position: 'absolute',
            left: P.grave.x,
            top: P.grave.y,
            width: P.grave.w,
            height: P.grave.h,
            borderRadius: 8,
            cursor: graveTop ? 'grab' : 'default',
            boxShadow: sel?.kind === 'graveyard' && mine ? '0 0 0 4px #fff' : undefined,
            border: '2px dashed rgba(255,255,255,0.2)',
          }}
        >
          {graveTop && <div style={{ width: '100%', height: '100%', filter: 'grayscale(0.6) brightness(0.7)' }}>{cardFace(undefined, graveTop, 8)}</div>}
          <Archive size={fs * 1.1} style={{ position: 'absolute', left: 6, top: 6, opacity: 0.75, pointerEvents: 'none' }} />
          {countBadge(side?.graveyard.length || 0)}
        </div>

        {/* Mano */}
        <div data-drop={`hand:${s}`} style={{ position: 'absolute', left: P.hand.x - 6, top: P.hand.y - 4, width: P.hand.w + 12, height: P.hand.h + 8, borderRadius: 10, background: mine ? 'rgba(255,255,255,0.03)' : undefined }} />
        {hand.map((c, i) => {
          const r = { x: P.hand.x + i * step, y: P.hand.y, w: handW, h: P.hand.h };
          const id = c.id || `${s}-hand-${i}`;
          const selected = sel?.kind === 'hand' && sel.id === c.id;
          return (
            <div
              key={id}
              data-hand={s}
              onPointerDown={
                mine && c.id
                  ? (e) => startDrag(e, { kind: 'hand', id: c.id!, templateId: c.templateId, back: c }, r)
                  : c.templateId
                    ? (e) => {
                        e.stopPropagation();
                        setHover(c.templateId!);
                      }
                    : undefined
              }
              {...hoverProps(c.templateId)}
              style={{
                position: 'absolute',
                left: r.x,
                top: r.y - (selected ? 14 : 0),
                width: r.w,
                height: r.h,
                zIndex: 50 + i,
                borderRadius: 8,
                boxShadow: selected ? '0 0 0 4px #fff, 0 8px 18px rgba(0,0,0,0.6)' : '0 4px 10px rgba(0,0,0,0.5)',
                cursor: mine ? 'grab' : 'default',
                transition: 'top 0.15s',
                opacity: drag?.moved && drag.src.kind === 'hand' && drag.src.id === c.id ? 0.35 : 1,
              }}
            >
              {cardFace(c.templateId, c, 8)}
            </div>
          );
        })}
        {!info && (
          <div style={{ position: 'absolute', left: P.play.x, top: P.play.y, width: P.play.w, height: P.play.h, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: fs * 1.2, color: 'var(--text-muted)' }}>
            Esperando a que se una un jugador…
          </div>
        )}
        {bursts
          .filter((b) => b.by === s)
          .map((b) => (
            <div key={b.id} className="ol-emoji-burst" style={{ left: box.r.x + box.r.w / 2, top: box.r.y + box.r.h / 2, fontSize: compact ? 150 : 110 }}>
              {b.text}
            </div>
          ))}
      </React.Fragment>
    );
  };

  // Flechas de "señalar": de la carta a las cartas o cartas de vida elegidas
  const pointerArrows = () => {
    const p = pointing ? { ...pointing, by: me } : state.pointer;
    if (!p) return null;
    const a = targetRects.get(p.from);
    if (!a) return null;
    const arrows: (BrushArrow & { key: string })[] = [];
    for (const t of p.targets) {
      const b = targetRects.get(t);
      if (!b) continue;
      const rand = seededRandom(`${p.from}:${t}`);
      const from = { x: a.x + a.w * (0.4 + rand() * 0.2), y: a.y + a.h * (0.42 + rand() * 0.16) };
      const ax = a.x + a.w / 2;
      const ay = a.y + a.h / 2;
      const vertical = Math.abs(ay - (b.y + b.h / 2)) > b.h * 0.6;
      const below = ay > b.y + b.h / 2;
      const right = ax > b.x + b.w / 2;
      const to = vertical ? { x: b.x + b.w * (0.3 + rand() * 0.4), y: below ? b.y + b.h + 4 : b.y - 4 } : { x: right ? b.x + b.w + 4 : b.x - 4, y: b.y + b.h * (0.3 + rand() * 0.2) };
      const into = vertical ? { x: 0, y: below ? -1 : 1 } : { x: right ? -1 : 1, y: 0 };
      arrows.push({ key: `${p.from}-${t}`, ...brushArrow(from, to, rand, Math.max(a.h, 150), into) });
    }
    return (
      <svg width={BOARD_W} height={boardH} style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none', zIndex: 440000, overflow: 'visible', color: colorOf(p.by) }}>
        <defs>
          <filter id="ml-arrow-shadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="4" stdDeviation="4" floodColor="#000" floodOpacity="0.6" />
          </filter>
        </defs>
        {arrows.map((ar) => (
          <g key={ar.key} filter="url(#ml-arrow-shadow)">
            <mask id={`ml-mask-${ar.key}`} maskUnits="userSpaceOnUse">
              <path d={ar.spine} fill="none" stroke="#fff" strokeWidth={40} strokeLinecap="round" pathLength={1} className="ol-arrow-draw" />
            </mask>
            <g mask={`url(#ml-mask-${ar.key})`}>
              <path d={ar.body} fill="currentColor" stroke="rgba(0,0,0,0.65)" strokeWidth={2.5} strokeLinejoin="round" />
            </g>
            <path d={ar.head} fill="currentColor" stroke="rgba(0,0,0,0.65)" strokeWidth={2.5} strokeLinejoin="round" className="ol-arrow-head" style={{ transformOrigin: `${ar.tip.x}px ${ar.tip.y}px` }} />
          </g>
        ))}
      </svg>
    );
  };

  // ---------- Barra de acciones de lo seleccionado ----------
  const ui = compact ? { font: 13, pad: '7px 9px', icon: 15 } : { font: 14, pad: '7px 11px', icon: 15 };
  const act = (label: string, icon: React.ReactNode, onClick: () => void, opts: { primary?: boolean; disabled?: boolean } = {}) => (
    <button
      key={label}
      className={opts.primary ? 'btn-primary' : 'btn-secondary'}
      disabled={opts.disabled}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onClick}
      style={{ padding: ui.pad, fontSize: ui.font, display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}
    >
      {icon}
      {label}
    </button>
  );
  const actions = (): React.ReactNode[] | null => {
    const I = ui.icon;
    if (pointing)
      return [
        <span key="hint" style={{ fontSize: ui.font, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
          {compact ? 'Toca objetivos' : 'Toca hasta 3 cartas o cartas de vida'} ({pointing.targets.length}/3)
        </span>,
        act('Listo', null, () => setPointing(null), { primary: true }),
        act('Quitar', <X size={I} />, () => {
          send({ t: 'point', from: pointing.from, targets: [] });
          setPointing(null);
        }),
      ];
    if (!sel) return null;
    if (sel.kind === 'play') {
      const p = allPlay.find((x) => x.c.id === sel.id);
      if (!p) return null;
      const own = p.s === me;
      const hasTok = tokensOf(sel.id).length > 0;
      const list = [
        act('Token', <span style={{ fontWeight: 800 }}>+</span>, () => send({ t: 'tokenAdd', cardId: sel.id })),
        hasTok && act('Token', <span style={{ fontWeight: 800 }}>−</span>, () => send({ t: 'tokenDelete', id: tokensOf(sel.id).slice(-1)[0].id })),
      ];
      if (own)
        list.push(
          act('Voltear', <RefreshCw size={I} />, () => send({ t: 'flip', id: sel.id })),
          act('Girar', <RotateCw size={I} />, () => send({ t: 'rotate', id: sel.id, deg: 90 })),
          act('Señalar', <Crosshair size={I} />, () => {
            setPointing({ from: sel.id, targets: state.pointer?.from === sel.id ? state.pointer.targets : [] });
            setSel(null);
          }),
          act('A la mano', <Hand size={I} />, () => send({ t: 'move', id: sel.id, to: 'hand' })),
        );
      else list.push(act('A mi mano', <Hand size={I} />, () => send({ t: 'move', id: sel.id, to: 'hand' })));
      list.push(act('Cementerio', <Archive size={I} />, () => toGraveyard(sel.id, p.c.owner)));
      return list.filter(Boolean) as React.ReactNode[];
    }
    if (sel.kind === 'hand') {
      const c = myHand.find((h) => h.id === sel.id);
      if (!c) return null;
      return [
        act('Jugar', null, () => playFromHand(sel.id, true), { primary: true }),
        !c.isSpecial && act('Boca abajo', null, () => playFromHand(sel.id, false)),
        act('Enseñar', <Eye size={I} />, () => send({ t: 'reveal', id: sel.id })),
        act('Cementerio', <Archive size={I} />, () => send({ t: 'move', id: sel.id, to: 'graveyard' })),
      ].filter(Boolean) as React.ReactNode[];
    }
    if (sel.kind === 'library')
      return [
        act('Robar', <Hand size={I} />, () => send({ t: 'draw', count: 1 }), { primary: true }),
        act('Barajar', <Shuffle size={I} />, () => send({ t: 'shuffleLibrary' })),
        act('Mirar', <Eye size={I} />, () => send({ t: 'peek', zone: 'library' })),
      ];
    if (sel.kind === 'graveyard')
      return [
        act('Mirar', <Eye size={I} />, () => send({ t: 'peek', zone: 'graveyard' })),
        act('A la biblioteca', <BookOpen size={I} />, () =>
          confirm('Devolver el cementerio', 'Tu cementerio vuelve a la biblioteca y se baraja. ¿Seguro?', () => send({ t: 'recycleGraveyard' })),
        ),
      ];
    return null;
  };

  // ---------- Vista ampliada ----------
  const selTemplate = (() => {
    if (sel?.kind === 'play') {
      const p = allPlay.find((x) => x.c.id === sel.id);
      return p?.c.isFaceUp ? p.c.templateId : undefined;
    }
    if (sel?.kind === 'hand') return myHand.find((h) => h.id === sel.id)?.templateId;
    return undefined;
  })();
  const previewTpl = templateMap.get((drag?.moved ? undefined : hover) || selTemplate || '');
  // En el móvil la carta tocada de otra mano se ve un momento
  useEffect(() => {
    if (!isTouch || !hover) return;
    const t = window.setTimeout(() => setHover(null), 3500);
    return () => window.clearTimeout(t);
  }, [hover, isTouch]);

  const copyInvite = async () => {
    const link = inviteLink(serverUrl, state.code);
    try {
      await navigator.clipboard.writeText(link);
      toast('Enlace de invitación copiado');
    } catch {
      toast(link);
    }
  };
  const joined = seats.filter((s) => state.players[s]).length;
  const modeName = state.mode === 'team4' ? '2 contra 2' : '3 jugadores';
  const barH = compact ? 46 : 52;
  const list = actions();
  const dragTpl = drag?.moved ? drag.src : null;

  return (
    <div className="tabletop-container" style={{ display: 'flex', flexDirection: 'column', cursor: 'default', userSelect: 'none' }}>
      {/* Barra de arriba: sala, acciones de lo seleccionado y chat */}
      <div
        style={{ height: barH, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px', background: 'rgba(8,12,22,0.85)', borderBottom: '1px solid var(--glass-border)', position: 'relative', zIndex: 5 }}
      >
        <button className="btn-secondary" onClick={() => setMenuOpen(true)} title="Sala" style={{ padding: ui.pad, display: 'flex', alignItems: 'center', gap: 6, fontSize: ui.font }}>
          <Menu size={16} />
          {!compact && `Sala ${state.code}`}
        </button>
        {joined < seats.length && (
          <button className="btn-primary" onClick={copyInvite} style={{ padding: ui.pad, fontSize: ui.font, display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
            <Copy size={14} /> Invitar ({joined}/{seats.length})
          </button>
        )}
        <div style={{ flex: 1, display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'center', overflowX: 'auto', minWidth: 0 }}>
          {list ??
            (!compact && (
              <span style={{ fontSize: 13, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                {modeName}
                {!state.started && state.starter && state.players[state.starter] ? ` · Empieza ${nameOf(state.starter)}` : ''}
              </span>
            ))}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', position: 'relative' }}>
          {voice.phase !== 'idle' && <RecordingBar rec={voice} slide={micSlide} />}
          {voice.phase === 'idle' && (
            <button
              className="btn-secondary"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setEmojiOpen((o) => (o === 'board' ? null : 'board'))}
              title="Enviar un emoji"
              style={{ padding: 8, display: 'flex', background: emojiOpen === 'board' ? 'rgba(60,70,95,0.95)' : undefined }}
            >
              <Smile size={18} />
            </button>
          )}
          <MicButton rec={voice} size={18} onSlide={setMicSlide} style={{ padding: 8 }} />
          <button
            className="btn-secondary"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => {
              setEmojiOpen(null);
              setShowLog((v) => !v);
            }}
            title="Chat"
            style={{ padding: compact ? 8 : '8px 12px', display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <MessageSquare size={18} />
            {!compact && 'Chat'}
            {unread > 0 && <span style={{ background: 'var(--color-accent)', borderRadius: 10, padding: '0 6px', fontSize: 12, color: '#fff' }}>{unread}</span>}
          </button>
          {emojiOpen === 'board' && (
            <EmojiPicker
              big={compact}
              onPick={(e) => {
                send({ t: 'chat', text: e, reaction: true });
                setEmojiOpen(null);
              }}
              style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, width: compact ? 330 : 300, zIndex: 800000 }}
            />
          )}
        </div>
      </div>

      {/* Mesa */}
      <div
        ref={areaRef}
        style={{ flex: 1, position: 'relative', overflow: 'hidden', touchAction: 'none' }}
        onPointerDown={() => {
          if (!pointing) clearSel();
          setHover(null);
        }}
      >
        <div
          ref={boardRef}
          style={{ position: 'absolute', left: fit.left, top: fit.top, width: BOARD_W, height: boardH, transform: `scale(${fit.scale})`, transformOrigin: '0 0' }}
        >
          {seats.map(renderBox)}
          {pointerArrows()}
          {dragTpl && drag && (
            <div style={{ position: 'absolute', left: drag.x - drag.gx, top: drag.y - drag.gy, width: drag.w, height: drag.h, zIndex: 500000, pointerEvents: 'none', opacity: 0.9, filter: 'drop-shadow(0 12px 20px rgba(0,0,0,0.7))' }}>
              {cardFace(
                dragTpl.kind === 'hand' ? dragTpl.templateId : dragTpl.kind === 'play' && dragTpl.card.isFaceUp ? dragTpl.card.templateId : undefined,
                dragTpl.kind === 'play' ? dragTpl.card : dragTpl.back,
                8,
              )}
            </div>
          )}
        </div>

        {/* Vista ampliada de la carta (toque: a pantalla grande) */}
        {previewTpl?.imageUrl && !previewBig && !showLog && (
          <img
            src={previewTpl.imageUrl}
            alt={previewTpl.name}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setPreviewBig(true)}
            style={{
              position: 'absolute',
              right: 10,
              top: 10,
              height: compact ? 'min(260px, 70%)' : 'min(440px, 58%)',
              aspectRatio: `${CARD_W} / ${CARD_H}`,
              objectFit: 'cover',
              borderRadius: 12,
              boxShadow: '0 20px 50px rgba(0,0,0,0.8)',
              zIndex: 600000,
              cursor: 'zoom-in',
            }}
          />
        )}
        {previewBig && previewTpl?.imageUrl && (
          <div
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setPreviewBig(false)}
            style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 700500, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <img src={previewTpl.imageUrl} alt={previewTpl.name} style={{ height: 'calc(100% - 16px)', maxWidth: 'calc(100% - 16px)', aspectRatio: `${CARD_W} / ${CARD_H}`, objectFit: 'cover', borderRadius: 16 }} />
          </div>
        )}

        {/* Registro y chat */}
        {showLog && (
          <div
            className="glass-panel"
            onPointerDown={(e) => e.stopPropagation()}
            style={{ position: 'absolute', top: 8, right: 8, width: compact ? 300 : 320, height: 'calc(100% - 16px)', maxHeight: 520, display: 'flex', flexDirection: 'column', zIndex: 700000 }}
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
                <div key={entry.id} style={{ fontSize: '0.75rem', lineHeight: 1.35, color: entry.kind === 'chat' ? '#fff' : entry.kind === 'reveal' ? 'var(--color-accent)' : 'var(--text-muted)' }}>
                  <span style={{ opacity: 0.5, marginRight: 4 }}>{new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  {chatBody(entry) ?? logText(entry.text)}
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
            <form onSubmit={sendChat} style={{ position: 'relative', display: 'flex', gap: 6, padding: 8, borderTop: '1px solid var(--glass-border)', alignItems: 'center' }}>
              {emojiOpen === 'panel' && <EmojiPicker onPick={(e) => setChatText((t) => (t + e).slice(0, 300))} style={{ position: 'absolute', left: 8, right: 8, bottom: 'calc(100% + 6px)' }} />}
              {voice.phase !== 'idle' ? (
                <RecordingBar rec={voice} slide={micSlide} style={{ flex: 1, padding: '4px 8px', border: 'none', background: 'transparent', overflow: 'hidden' }} />
              ) : (
                <>
                  <button
                    type="button"
                    className="btn-secondary"
                    title="Emojis"
                    onClick={() => setEmojiOpen((o) => (o === 'panel' ? null : 'panel'))}
                    style={{ padding: 6, display: 'flex', background: emojiOpen === 'panel' ? 'rgba(255,255,255,0.15)' : undefined }}
                  >
                    <Smile size={16} />
                  </button>
                  <input
                    value={chatText}
                    onChange={(e) => setChatText(e.target.value)}
                    placeholder="Escribe a la mesa…"
                    maxLength={300}
                    style={{ flex: 1, minWidth: 0, background: 'rgba(0,0,0,0.35)', color: '#fff', border: '1px solid var(--glass-border)', borderRadius: 6, padding: '6px 8px', fontSize: '0.8rem', fontFamily: 'var(--font-family)', outline: 'none' }}
                  />
                </>
              )}
              {chatText.trim() && voice.phase === 'idle' ? (
                <button className="btn-primary" type="submit" style={{ padding: '6px 10px', fontSize: '0.75rem' }}>
                  Enviar
                </button>
              ) : (
                <MicButton rec={voice} size={16} onSlide={setMicSlide} style={{ padding: 6 }} />
              )}
            </form>
          </div>
        )}

        {/* Avisos de chat de los demás */}
        {chatToasts.length > 0 && (
          <div style={{ position: 'absolute', right: 10, top: 10, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end', zIndex: 760000, pointerEvents: 'none' }}>
            {chatToasts.map((t) => {
              const entry = state.log.find((e) => e.id === t.id);
              return (
                <div
                  key={t.id}
                  className={`glass-panel ol-chat-toast${t.leaving ? ' ol-chat-toast-out' : ''}`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => setShowLog(true)}
                  style={{ pointerEvents: 'auto', cursor: 'pointer', maxWidth: compact ? 260 : 340, padding: '10px 14px', fontSize: compact ? 14 : 15, display: 'flex', gap: 8, alignItems: 'flex-start', boxShadow: '0 10px 30px rgba(0,0,0,0.5)' }}
                >
                  <MessageSquare size={16} style={{ flexShrink: 0, marginTop: 2, color: 'var(--color-accent)' }} />
                  {entry?.audio ? (
                    <span>
                      {logText(t.text.replace(/mensaje de voz$/, ''))}
                      <div style={{ marginTop: 4 }}>{voiceOf(entry)}</div>
                    </span>
                  ) : (
                    <span style={{ wordBreak: 'break-word' }}>{logText(t.text)}</span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {status === 'reconnecting' && (
          <div className="glass-panel" style={{ position: 'absolute', top: '45%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 800000, padding: '14px 22px', fontSize: '0.9rem' }}>
            Conexión perdida. Reconectando…
          </div>
        )}
      </div>

      {/* Sala: jugadores, equipos y opciones */}
      {menuOpen && (
        <Overlay onClose={() => setMenuOpen(false)}>
          <h3 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: 2 }}>
            Sala {state.code} · {modeName}
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '12px 0', textAlign: 'left' }}>
            {seats.map((s) => {
              const p = state.players[s];
              const presence = !p || p.left || !p.connected ? 'off' : p.visible === false ? 'away' : 'on';
              const team = teamOf(s);
              return (
                <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.9rem' }}>
                  <span className={`ol-presence ol-presence-${presence}`} />
                  <b style={{ color: colorOf(s) }}>{p ? p.name : 'Sitio libre'}</b>
                  {s === me && <span style={{ color: 'var(--text-muted)' }}>(tú)</span>}
                  {team && <span style={{ color: TEAM_COLORS[team], fontSize: '0.8rem' }}>Equipo {team}</span>}
                  <span style={{ flex: 1 }} />
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>{p?.deckId ? library.deckNames[p.deckId] : ''}</span>
                </div>
              );
            })}
          </div>
          <div className="ml-menu" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <button className="btn-secondary" onClick={copyInvite}>
              <Copy size={14} /> Invitar
            </button>
            <button
              className="btn-secondary"
              onClick={() => {
                setMenuOpen(false);
                setForcePick(true);
              }}
            >
              <Swords size={14} /> Campeón
            </button>
            <button className="btn-secondary" onClick={() => send({ t: 'showHand', value: !myInfo?.handRevealed })}>
              {myInfo?.handRevealed ? <EyeOff size={14} /> : <Eye size={14} />} {myInfo?.handRevealed ? 'Ocultar mano' : 'Enseñar mano'}
            </button>
            <button className="btn-secondary" onClick={() => send({ t: 'toggleStarter' })}>
              <Swords size={14} /> Cambiar quién empieza
            </button>
            <button
              className="btn-primary"
              onClick={() => {
                setMenuOpen(false);
                setShowEnd(true);
              }}
            >
              <Trophy size={14} /> Terminar partida
            </button>
            <button
              className="btn-secondary"
              onClick={() =>
                confirm('Reiniciar la mesa', 'Se quitan todas las cartas y tokens, las vidas vuelven a 10 y cada jugador elige campeón otra vez. ¿Seguro?', () => {
                  setMenuOpen(false);
                  send({ t: 'reset' });
                })
              }
            >
              <RefreshCw size={14} /> Reiniciar mesa
            </button>
            <button
              className="btn-secondary"
              onClick={async () => {
                if (!fullscreenSupported()) return toast(IOS_FULLSCREEN_HINT);
                if (!(await toggleFullscreen())) toast('El navegador no ha permitido la pantalla completa');
              }}
            >
              {fullscreen ? <Minimize size={14} /> : <Maximize size={14} />} Pantalla completa
            </button>
            <button
              className="btn-secondary"
              onClick={() => {
                setMenuOpen(false);
                onLeave();
              }}
            >
              <LogOut size={14} /> Salir
            </button>
          </div>
        </Overlay>
      )}

      {/* Fin de partida: gana un jugador o un equipo */}
      {showEnd && (
        <Overlay onClose={() => setShowEnd(false)}>
          <h3 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: 14 }}>¿Quién ha ganado?</h3>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
            {(state.teams ? (['A', 'B'] as const).map((t) => ({ id: t, label: state.teams![t].map((s) => state.players[s]?.name || '—').join(' y '), color: TEAM_COLORS[t] })) : seats.filter((s) => state.players[s]).map((s) => ({ id: s, label: nameOf(s), color: colorOf(s) }))).map((o) => (
              <button
                key={o.id}
                className="btn-primary"
                style={{ padding: '10px 18px', fontSize: '0.95rem', background: o.color, borderColor: o.color, color: '#fff', textShadow: '0 1px 3px rgba(0,0,0,0.7)' }}
                onClick={() => {
                  send({ t: 'endMatch', winner: o.id, reset: endReset });
                  setShowEnd(false);
                }}
              >
                <Trophy size={15} /> {o.label}
              </button>
            ))}
            <button
              className="btn-secondary"
              style={{ padding: '10px 18px' }}
              onClick={() => {
                send({ t: 'endMatch', winner: 'draw', reset: endReset });
                setShowEnd(false);
              }}
            >
              Empate
            </button>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center', fontSize: '0.85rem' }}>
            <input type="checkbox" checked={endReset} onChange={(e) => setEndReset(e.target.checked)} /> Reiniciar la mesa para jugar otra
          </label>
        </Overlay>
      )}

      {/* Carta enseñada por otro jugador */}
      {reveal && templateMap.get(reveal.templateId)?.imageUrl && (
        <Overlay onClose={onCloseReveal}>
          <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: 10 }}>{reveal.by === me ? 'Has enseñado esta carta' : `${nameOf(reveal.by)} enseña esta carta`}</h3>
          <img src={templateMap.get(reveal.templateId)!.imageUrl} alt="" style={{ height: 'min(420px, calc(var(--app-h, 100vh) - 150px))', aspectRatio: `${CARD_W} / ${CARD_H}`, objectFit: 'cover', borderRadius: 12 }} />
        </Overlay>
      )}

      {/* Mirar tu biblioteca o tu cementerio */}
      {peek && (
        <Overlay onClose={onClosePeek}>
          <h3 style={{ fontSize: '1.05rem', fontWeight: 700, marginBottom: 12 }}>
            {peek.zone === 'library' ? 'Tu biblioteca' : 'Tu cementerio'}: {peek.cards.length} {peek.cards.length === 1 ? 'carta' : 'cartas'} (de arriba a abajo)
          </h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, maxHeight: '60vh', overflowY: 'auto', justifyContent: 'center' }}>
            {peek.cards.map((c) => {
              const t = templateMap.get(c.templateId);
              return (
                <div key={c.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                  {t?.imageUrl ? <img src={t.imageUrl} alt={c.name} style={{ width: 110, height: 174, objectFit: 'cover', borderRadius: 10 }} /> : <div style={{ width: 110, height: 174 }}>{c.name}</div>}
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

      {/* Elegir campeón (en 3 y 4 jugadores se puede repetir mazo) */}
      {((!myInfo?.deckId && !pickClosed) || forcePick) && Object.keys(library.deckNames).length > 0 && (
        <Overlay
          onClose={() => {
            setPickClosed(true);
            setForcePick(false);
          }}
        >
          <h3 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: 4 }}>Elige tu campeón</h3>
          <div style={{ display: 'flex', gap: compact ? 10 : 14, justifyContent: 'center', flexWrap: 'wrap', marginTop: compact ? 10 : 16 }}>
            {Object.entries(library.deckNames).map(([id, name]) => {
              const cover = library.backs[`backA-${id}`] || library.backs[`backB-${id}`];
              const current = myInfo?.deckId === id;
              const users = seats.filter((s) => s !== me && state.players[s]?.deckId === id).map(nameOf);
              const champH = compact ? 'min(230px, calc(var(--app-h, 100vh) - 132px))' : 'min(270px, calc(var(--app-h, 100vh) - 170px))';
              return (
                <button
                  key={id}
                  className="btn-secondary ol-champion"
                  onClick={() => {
                    if (!current) pickDeck(id);
                    setForcePick(false);
                  }}
                  style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: compact ? 6 : 8, outline: current ? '2px solid var(--color-accent)' : undefined }}
                >
                  {cover ? (
                    <img src={cover} alt={name} style={{ height: champH, aspectRatio: `${CARD_W} / ${CARD_H}`, objectFit: 'cover', borderRadius: 8 }} />
                  ) : (
                    <div style={{ height: champH, aspectRatio: `${CARD_W} / ${CARD_H}`, borderRadius: 8, background: 'rgba(255,255,255,0.06)' }} />
                  )}
                  <span style={{ fontWeight: 700, fontSize: compact ? 14 : 15 }}>{name}</span>
                  {(current || users.length > 0) && (
                    <span style={{ fontSize: 12, color: current ? 'var(--color-accent)' : 'var(--text-muted)' }}>{current ? 'Elegido' : `Lo usa ${users.join(' y ')}`}</span>
                  )}
                </button>
              );
            })}
          </div>
        </Overlay>
      )}
    </div>
  );
};
