import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArrowDown,
  ArrowUp,
  BookOpen,
  Crosshair,
  Swords,
  Copy,
  Eye,
  EyeOff,
  History,
  Hand,
  Layers,
  Maximize,
  Menu,
  Minimize,
  LogOut,
  MessageSquare,
  Smile,
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
  type Rect,
  type SideKey,
  type ZoneKey,
} from './layout';
import { inviteLink } from './server';
import { EmojiPicker, MicButton, RecordingBar, VoiceMessage, isEmojiOnly, useVoiceRecorder } from './ChatExtras';
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
  // Mensajes de chat ya vistos (por id: el registro tiene un límite y se recorta por el principio)
  const [seenChat, setSeenChat] = useState(() => new Set(state.log.filter((e) => e.kind === 'chat').map((e) => e.id)));
  // Mensajes de chat del rival que aparecen en el lateral aunque el chat esté cerrado
  const [chatToasts, setChatToasts] = useState<{ id: string; text: string; leaving?: boolean }[]>([]);
  // Selector de emojis (en la mesa se envían al momento; en el chat se añaden al texto)
  const [emojiOpen, setEmojiOpen] = useState<'board' | 'panel' | null>(null);
  // Emojis sueltos que suben por la mesa al enviarlos
  const [bursts, setBursts] = useState<{ id: string; text: string; mine: boolean }[]>([]);
  const burstSeen = useRef(new Set(state.log.filter((e) => e.kind === 'chat').map((e) => e.id)));
  const [micSlide, setMicSlide] = useState(0);
  const toastedChat = useRef(new Set(state.log.filter((e) => e.kind === 'chat').map((e) => e.id)));
  const [hoverTemplate, setHoverTemplate] = useState<{ cardId: string; templateId: string } | null>(null);
  const [hoverHandId, setHoverHandId] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const justDropped = useRef(new Map<string, number>());
  // En tablet (pantalla táctil) los controles se hacen más grandes y la vista
  // ampliada se abre manteniendo el dedo sobre la carta
  const isTouch = useMemo(() => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches, []);
  const [pressPreview, setPressPreview] = useState<string | null>(null);
  const [pressCard, setPressCard] = useState<string | null>(null); // carta en juego de la vista ampliada tocada
  const [previewDrag, setPreviewDrag] = useState<{ id: string; rx: number; ry: number } | null>(null); // token movido en la vista ampliada
  const hoverHideTimer = useRef<number | undefined>(undefined);
  const [pickClosed, setPickClosed] = useState(false); // menú de elegir campeón cerrado a mano
  // Un jugador: lado al que se le está eligiendo campeón (al empezar, primero el de abajo)
  const [soloPick, setSoloPick] = useState<SideKey | null>(() =>
    solo && !state.players.p1?.deckId && !state.players.p2?.deckId ? 'me' : null,
  );
  useEffect(() => {
    if (!myInfo?.deckId) setPickClosed(false); // al reiniciar la partida se vuelve a preguntar
  }, [myInfo?.deckId]);
  const [previewBig, setPreviewBig] = useState(false); // vista previa tocada: a pantalla grande
  const pressTimer = useRef<number | undefined>(undefined);
  const [selectedHandId, setSelectedHandId] = useState<string | null>(null);
  // Móvil: el menú de la carta sale al volver a tocar la carta ya seleccionada
  const [cardMenu, setCardMenu] = useState<string | null>(null);
  // Señalar: la carta `from` apunta a las cartas que se van tocando (hasta 3)
  const [pointing, setPointing] = useState<{ from: string; targets: string[] } | null>(null);
  const [hiddenPointRev, setHiddenPointRev] = useState(-1);
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
  const LIFE_SETTLE = 600; // ms sin tocar la vida para dar por buena la del servidor
  const [lifePending, setLifePending] = useState<Partial<Record<SideKey, { value: number; at: number }>>>({});
  const [lifeBig, setLifeBig] = useState<SideKey | null>(null); // carta de vida ampliada
  const [lifeCheck, setLifeCheck] = useState(0);
  useEffect(() => {
    // Se suelta el valor pendiente cuando el servidor ya tiene ese valor y hace un rato que no se toca
    // (las respuestas a los toques anteriores llegan con valores intermedios), o si tarda demasiado
    setLifePending((p) => {
      let changed = false;
      const next = { ...p };
      for (const side of ['me', 'opp'] as SideKey[]) {
        const v = p[side];
        const age = v ? Date.now() - v.at : 0;
        if (v && ((v.value === state.life[side] && age >= LIFE_SETTLE) || age > 3000)) {
          delete next[side];
          changed = true;
        }
      }
      return changed ? next : p;
    });
  }, [state.life, lifeCheck]);
  useEffect(() => {
    // Mientras quede un valor pendiente se vuelve a mirar cada poco
    if (!lifePending.me && !lifePending.opp) return;
    const t = window.setTimeout(() => setLifeCheck((n) => n + 1), 250);
    return () => window.clearTimeout(t);
  }, [lifePending, lifeCheck]);
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
    setPreviewBig(false);
  };
  const clearSelections = () => {
    setSelectedId(null);
    setCardMenu(null);
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
    grave: Record<SideKey, number>;
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
    const grave = { me: state.me.graveyard.length, opp: state.opp.graveyard.length };
    flipPrev.current = { pos, ids, lib, grave, oppHand: state.oppHand.length };
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

    // Cementerio barajado en la biblioteca: las cartas vuelan una tras otra y el mazo se agita
    const recycled = new Set<string>();
    for (const side of ['me', 'opp'] as SideKey[]) {
      if (!(prev.grave[side] > 1 && grave[side] === 0 && lib[side] > prev.lib[side])) continue;
      const pile = vanished.filter(([, b]) => b.side === side && b.zone === 'graveyard');
      if (!pile.length) continue;
      pile.forEach(([id]) => recycled.add(id));
      const top = pile[pile.length - 1][1];
      const to = libCenter(side);
      const n = Math.min(prev.grave[side], 14);
      const step = Math.min(70, 900 / n);
      for (let i = 0; i < n; i++) {
        const el = top.el.cloneNode(true) as HTMLElement;
        el.removeAttribute('data-fid');
        el.className = '';
        el.style.left = `${top.x - SMALL_W / 2}px`;
        el.style.top = `${top.y - SMALL_H / 2}px`;
        el.style.opacity = '1';
        el.style.pointerEvents = 'none';
        el.style.zIndex = String(500000 + i);
        board.appendChild(el);
        const dx = to.x - top.x;
        const dy = to.y - top.y;
        const lift = (side === 'me' ? -1 : 1) * (40 + (i % 3) * 12); // un pequeño arco al volar
        const anim = el.animate(
          [
            { translate: '0px 0px', rotate: '0deg', scale: '1', opacity: 1 },
            { translate: `${dx * 0.5}px ${dy * 0.5 + lift}px`, rotate: `${45 + ((i * 37) % 30) - 15}deg`, scale: '1.08', opacity: 1, offset: 0.5 },
            { translate: `${dx}px ${dy}px`, rotate: '90deg', scale: '1', opacity: 0.9 },
          ],
          { duration: 520, delay: i * step, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'backwards' },
        );
        anim.onfinish = anim.oncancel = () => el.remove();
      }
      // Al llegar todas, el mazo se baraja (se agita un momento)
      const libEl = board.querySelector<HTMLElement>(`[data-lib="${side}"]`);
      libEl?.animate(
        [
          { translate: '0px 0px', rotate: '0deg' },
          { translate: '-6px 0px', rotate: '-4deg' },
          { translate: '6px 0px', rotate: '4deg' },
          { translate: '-4px 0px', rotate: '-2deg' },
          { translate: '0px 0px', rotate: '0deg' },
        ],
        { duration: 450, delay: (n - 1) * step + 480, easing: 'ease-in-out' },
      );
      for (const [, b] of pile) b.el.remove();
    }

    // Cartas que se van a una biblioteca o a la mano oculta del rival
    for (const [id, before] of vanished) {
      if (paired.has(id) || recycled.has(id)) continue;
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
    // Solo cuando cambia la partida (o el tamaño de la mesa), no en cada movimiento del arrastre
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, fit.scale, fit.compact]);

  // ---------- Datos derivados ----------

  const templateMap = useMemo(() => new Map<string, CardTemplate>(library.templates.map((t) => [t.id, t])), [library.templates]);
  // Precargar las imágenes para que al voltear una carta se vea al instante
  useEffect(() => {
    for (const t of library.templates) if (t.imageUrl) new Image().src = t.imageUrl;
    for (const url of Object.values(library.backs)) new Image().src = url;
  }, [library]);

  const selectedHand = state.hand.find((c) => c.id === selectedHandId) || null;
  const selectedOppHand = solo ? state.oppHand.find((c) => c.id && c.id === selectedHandId) || null : null;
  // Se puede seleccionar cualquier carta en juego (también las del rival, para ponerles tokens o mandarlas a su cementerio)
  const allPlay = [...state.me.play, ...state.opp.play];
  const selectedCard = allPlay.find((c) => c.id === selectedId) || null;
  const selectedSide: SideKey = selectedCard && state.opp.play.includes(selectedCard) ? 'opp' : 'me';

  // ---------- Zona de juego ordenada ----------
  // Las cartas en juego se colocan en fila, alineadas y centradas. La x guardada
  // solo sirve para el orden (de izquierda a derecha vista por el dueño).
  const PLAY_MAX_X = PLAY_W - CARD_W;
  // Tokens de una carta: proporción respecto al ancho de la carta (en móvil, como un círculo de habilidad)
  const attachedTokenRatio = compact ? 0.22 : 0.23;
  const attachedTokenSize = L.cardW * attachedTokenRatio;
  const PLAY_MID_Y = (PLAY_H - CARD_H) / 2;
  // Las dos zonas de juego se ven en el mismo orden para los dos jugadores: la
  // primera carta a la izquierda y las siguientes a su derecha.
  const playInViewOrder = (side: SideKey, list?: OnlinePlayCard[]) => {
    return [...(list ?? (side === 'me' ? state.me : state.opp).play)].sort((a, b) => a.x - b.x || a.order - b.order);
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
    placeInPlay(side, (side === 'me' ? state.me : state.opp).play.length, { msg });

  useEffect(() => {
    if (selectedId && !allPlay.some((c) => c.id === selectedId)) setSelectedId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.me.play, state.opp.play, selectedId]);
  // El rival ve qué carta tienes seleccionada
  const sentSelection = useRef<string | null>(null);
  useEffect(() => {
    if (solo || sentSelection.current === selectedId) return;
    sentSelection.current = selectedId;
    send({ t: 'select', id: selectedId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, solo]);

  useEffect(() => {
    if (selectRequest && selectRequest.length) setSelectedId(selectRequest[selectRequest.length - 1]);
  }, [selectRequest]);

  useEffect(() => {
    if (showLog) {
      setSeenChat(new Set(state.log.filter((e) => e.kind === 'chat').map((e) => e.id)));
      logEndRef.current?.scrollIntoView({ block: 'end' });
    }
  }, [state.log, showLog]);

  // ---------- Acciones ----------

  const draw = (side: SideKey = 'me') => sendAs(side, { t: 'draw', count: 1 });
  const flip = () => selectedCard && canControl(selectedSide) && sendAs(selectedSide, { t: 'flip', id: selectedCard.id });
  const tokenOnCard = () => selectedCard && sendAs(selectedSide, { t: 'tokenAdd', cardId: selectedCard.id });
  const moveSelected = (to: ZoneKey) => {
    if (!selectedCard) return;
    if (!canControl(selectedSide)) {
      // Carta del rival: solo se puede mandar a su cementerio
      if (to === 'graveyard') send({ t: 'move', id: selectedCard.id, to, toSeat: seatOf('opp') });
      setSelectedId(null);
      return;
    }
    sendAs(selectedSide, { t: 'move', id: selectedCard.id, to });
    setSelectedId(null);
  };
  const startPointing = () => {
    if (!selectedCard) return;
    setPointing({ from: selectedCard.id, targets: [] });
    setSelectedId(null);
    setCardMenu(null);
  };
  // Las flechas se quitan solas a los 5 segundos del último cambio
  const pointer = state.pointer;
  useEffect(() => {
    if (!pointer) return;
    const rev = pointer.rev;
    const t = window.setTimeout(() => {
      setHiddenPointRev(rev);
      setPointing((p) => (p && p.targets.length ? null : p));
    }, 5000);
    return () => window.clearTimeout(t);
  }, [pointer?.rev]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (pointing && !allPlay.some((c) => c.id === pointing.from)) setPointing(null);
  });
  // Al tocar rápido +/− el servidor responde con valores intermedios ya viejos: se muestra el último
  // valor pulsado hasta que el servidor lo confirma, así el contador no salta hacia atrás y hacia delante
  const setLife = (side: SideKey, value: number) => {
    const v = clamp(value, LIFE_MIN, LIFE_MAX);
    setLifePending((p) => ({ ...p, [side]: { value: v, at: Date.now() } }));
    sendAs(side, { t: 'life', value: v });
  };
  const lifeOf = (side: SideKey) => {
    const p = lifePending[side];
    return p ? p.value : side === 'me' ? state.life.me : state.life.opp;
  };
  // Enseñar la mano pide confirmación; ocultarla no
  const toggleHand = () => {
    if (handRevealed) send({ t: 'showHand', value: false });
    else confirm('Enseñar tu mano', 'Tu rival verá todas las cartas de tu mano hasta que la vuelvas a ocultar. ¿Seguro?', () => send({ t: 'showHand', value: true }));
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
    else if (k === 'escape') {
      setSelectedId(null);
      setPointing(null);
    }
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
    if (e.pointerType === 'touch' && !pointing) {
      // Tocar una carta con el dedo: vista ampliada al momento (se quita si se arrastra)
      if (previewTemplateId) {
        window.clearTimeout(previewTimer.current);
        setPressPreview(previewTemplateId);
        setPressCard(src.kind === 'play' ? src.id : null);
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
      if (pointing && src.kind === 'play') {
        // Eligiendo a qué cartas señalar
        if (src.id === pointing.from) return;
        const targets = pointing.targets.includes(src.id) ? pointing.targets.filter((t) => t !== src.id) : [...pointing.targets, src.id].slice(0, 3);
        send({ t: 'point', from: pointing.from, targets });
        setPointing(targets.length >= 3 ? null : { ...pointing, targets });
        return;
      }
      const wasToken = selectedTokenId;
      const again = src.kind === 'play' && selectedId === src.id;
      const menuWasOpen = cardMenu === selectedId;
      clearSelections();
      if (src.kind === 'library') draw(src.side);
      else if (src.kind === 'play') {
        setSelectedId(src.id);
        if (again && !menuWasOpen) setCardMenu(src.id);
      }
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
    if (!to && !solo && inRect(zoneRect('opp', 'graveyard'), d.x, d.y) && !(src.kind === 'graveyard' && src.side === 'opp')) {
      // Al cementerio del rival
      const r = src.kind === 'library' ? { from: 'library', fromSide: seatOf(src.side) } : { id: src.id };
      send({ t: 'move', ...r, to: 'graveyard', toSeat: seatOf('opp') });
      return;
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
      // (la Especial no se reordena: siempre está en su hueco)
      if (state.hand.find((c) => c.id === src.id)?.isSpecial) return;
      const normal = state.hand.filter((c) => !c.isSpecial);
      const ids = normal.map((c) => c.id).filter((id) => id !== src.id);
      const xs = handPositions(state.hand, zoneRect('me', 'hand'), true).xs.filter((_, i) => !state.hand[i].isSpecial);
      let index = xs.filter((sx) => sx + SMALL_W / 2 < d.x).length;
      index = clamp(index, 0, ids.length);
      ids.splice(index, 0, src.id);
      ids.push(...state.hand.filter((c) => c.isSpecial).map((c) => c.id));
      patchState((s) => ({ ...s, hand: ids.map((id) => s.hand.find((c) => c.id === id)!).filter(Boolean) }));
      send({ t: 'handOrder', ids });
      return;
    }
    if (to === 'graveyard' && src.kind === 'graveyard' && src.side === toSide) return;
    if (to === 'library' && src.kind === 'library' && src.side === toSide) return;
    sendAs(toSide, { t: 'move', ...ref, to });
  };

  const dragging = drag !== null;
  const moveFrame = useRef(0);
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
      // Un repintado por fotograma como mucho: en el móvil llegan muchos más eventos
      if (!moveFrame.current)
        moveFrame.current = requestAnimationFrame(() => {
          moveFrame.current = 0;
          if (dragRef.current) setDrag(dragRef.current);
        });
    };
    const up = (e: PointerEvent) => {
      cancelAnimationFrame(moveFrame.current);
      moveFrame.current = 0;
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
    window.clearTimeout(hoverHideTimer.current);
    setHoverTemplate({ cardId, templateId });
  };
  // Se quita con un pequeño retraso: así da tiempo a llevar el ratón a los tokens de la vista ampliada
  const hidePreview = () => {
    window.clearTimeout(hoverHideTimer.current);
    hoverHideTimer.current = window.setTimeout(() => setHoverTemplate(null), 250);
  };

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

  // Animación de barajar: se lanza cuando cambia el contador de la biblioteca (para los dos jugadores)
  const shuffleSeen = useRef({ me: state.me.library.shuffles || 0, opp: state.opp.library.shuffles || 0 });
  const [shuffling, setShuffling] = useState<{ me?: number; opp?: number }>({});
  useEffect(() => {
    for (const side of ['me', 'opp'] as SideKey[]) {
      const n = (side === 'me' ? state.me : state.opp).library.shuffles || 0;
      if (n === shuffleSeen.current[side]) continue;
      shuffleSeen.current[side] = n;
      const at = Date.now();
      setShuffling((s) => ({ ...s, [side]: at }));
      window.setTimeout(() => setShuffling((s) => (s[side] === at ? { ...s, [side]: undefined } : s)), 1000);
    }
  }, [state.me.library.shuffles, state.opp.library.shuffles]);

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
            data-lib={side}
            title={canControl(side) ? 'Clic: robar · Arrastrar: coger la carta de arriba' : undefined}
            onPointerDown={
              canControl(side)
                ? (e) => startDrag(e, { kind: 'library', back: top, side }, cx, cy, top.templateId)
                : top.templateId
                  ? (e) => startDrag(e, { kind: 'view' }, 0, 0, top.templateId)
                  : undefined
            }
            onPointerEnter={(e) => top.templateId && showPreview(e, `special-lib-${side}`, top.templateId)}
            onPointerLeave={hidePreview}
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
            {/* La carta Especial se ve boca arriba también en la biblioteca */}
            {cardImage(top.templateId, top, !!top.templateId)}
          </div>
        )}
        {top &&
          shuffling[side] &&
          // Unas cuantas cartas del montón se separan a los lados y se mezclan
          [0, 1, 2, 3, 4, 5].map((i) => {
            const dir = i % 2 === 0 ? -1 : 1;
            return (
              <div
                key={`${shuffling[side]}-${i}`}
                className="ol-shuffle-card"
                style={
                  {
                    ...cardFrame,
                    left: cx,
                    top: cy,
                    width: SMALL_W,
                    height: SMALL_H,
                    zIndex: 13 + i,
                    animationDelay: `${i * 25}ms`,
                    boxShadow: '0 4px 10px rgba(0,0,0,0.45)',
                    '--dx': `${dir * (SMALL_W * 0.55 + i * 3)}px`,
                    '--rot': `${dir * (6 + i)}deg`,
                    '--z1': 13 + (5 - i),
                    '--z2': 13 + i,
                  } as React.CSSProperties
                }
              >
                {cardImage(undefined, top, false)}
              </div>
            );
          })}
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
              onPointerDown={isTop ? (e) => startDrag(e, { kind: 'graveyard', id: c.id, side, back: c }, x, y, c.templateId) : undefined}
              onPointerEnter={(e) => isTop && c.templateId && showPreview(e, `special-grave-${c.id}`, c.templateId)}
              onPointerLeave={hidePreview}
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
              {cardImage(c.templateId, c, !!c.templateId)}
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
      const selected = c.id === selectedId;
      const oppSel = !solo && c.id === state.oppSelected; // la tiene seleccionada el rival
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
              boxShadow: [
                selected ? '0 0 0 3px var(--color-accent), 0 0 24px var(--color-accent-glow)' : '',
                oppSel ? `0 0 0 ${selected ? 7 : 3}px #f97316, 0 0 22px rgba(249,115,22,0.6)` : '',
              ]
                .filter(Boolean)
                .join(', ') || 'none',
            }}
          >
            {flipCard(c.templateId, c, c.isFaceUp)}
          </div>
        </div>
      );
    });

  // Bandeja de la mano propia (como en un jugador, pero dentro de su franja)
  // Hueco reservado de la carta Especial en la mano
  const specialSlotFrame = (x: number, y: number) => (
    <div
      key={`special-slot-${x}`}
      style={{ position: 'absolute', left: x - 6, top: y - 6, width: SMALL_W + 12, height: SMALL_H + 12, borderRadius: 12, border: '2px dashed rgba(250, 204, 21, 0.55)', background: 'rgba(250, 204, 21, 0.06)', pointerEvents: 'none' }}
    />
  );
  const myHandTray = () => {
    const r = zoneRect('me', 'hand');
    const { xs: slots, specialX } = handPositions(state.hand, r, true);
    const handCount = state.hand.filter((c) => !c.isSpecial).length;
    const y = r.y + 36;
    return (
      <React.Fragment key="my-hand">
        <div className="glass-panel" style={{ position: 'absolute', left: r.x, top: r.y, width: r.w, height: r.h, borderRadius: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: isTouch ? '4px 10px' : '6px 14px', fontSize: isTouch ? 17 : 15 }}>
            <Hand size={16} />
            <strong>{solo ? `Mano de ${myInfo?.name}` : 'Tu mano'} ({handCount})</strong>
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
                onClick={toggleHand}
                title={handRevealed ? 'Volver a ocultar tu mano' : 'Enseñar todas las cartas de tu mano al rival hasta que la vuelvas a ocultar'}
                style={smallBtn}
              >
                {handRevealed ? <EyeOff size={ui.icon} /> : <Eye size={ui.icon} />} {handRevealed ? 'Ocultar mi mano' : 'Enseñar mi mano'}
              </button>
            )}
          </div>
        </div>
        {specialX !== null && specialSlotFrame(specialX, y)}
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
    const { xs: slots, specialX } = handPositions(state.oppHand, r, false);
    const y = r.y + 8;
    return (
      <React.Fragment key="opp-hand">
        <div className="glass-panel" style={{ position: 'absolute', left: r.x, top: r.y, width: r.w, height: r.h, borderRadius: 18 }}>
          <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: isTouch ? '4px 10px' : '6px 14px', fontSize: isTouch ? 17 : 15 }}>
            <Hand size={16} />
            <strong>
              Mano de {oppInfo?.name} ({state.oppHand.filter((c) => !c.isSpecial).length})
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
        {specialX !== null && specialSlotFrame(specialX, y)}
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

  // Presencia del rival: verde si está viendo la partida, naranja si tiene la
  // ventana en segundo plano y rojo si no está conectado
  const presence = !oppInfo || oppInfo.left || !oppInfo.connected ? 'off' : oppInfo.visible === false ? 'away' : 'on';
  const presenceDot = (
    <span
      className={`ol-presence ol-presence-${presence}`}
      title={presence === 'on' ? 'Está viendo la partida' : presence === 'away' ? 'Conectado, pero sin la partida a la vista' : oppInfo?.left ? 'Ha salido de la sala' : 'No está conectado'}
    />
  );
  const oppHandTray = () => {
    if (solo) return soloOppHandTray();
    const r = zoneRect('opp', 'hand');
    const { xs: slots, specialX } = handPositions(state.oppHand, r, false);
    const n = state.oppHand.filter((c) => !c.isSpecial).length;
    const y = r.y + 8;
    return (
      <React.Fragment key="opp-hand">
        <div className="glass-panel" style={{ position: 'absolute', left: r.x, top: r.y, width: r.w, height: r.h, borderRadius: 18 }}>
          <div style={{ position: 'absolute', bottom: 6, left: 0, right: 0, textAlign: 'center', fontSize: 14, color: 'var(--text-muted)' }}>
            Mano de <strong style={{ color: '#fff' }}>{oppInfo?.name || 'tu rival'}</strong>
            {presenceDot}: {n} {n === 1 ? 'carta' : 'cartas'}
            {oppInfo?.handRevealed && <span style={{ color: 'var(--color-accent)' }}> · te la está enseñando</span>}
          </div>
        </div>
        {specialX !== null && specialSlotFrame(specialX, y)}
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
  const backUrlOf = (side: SideKey) => {
    const deckId = state.players[seatOf(side)]?.deckId;
    return deckId ? library.backs[`backA-${deckId}`] || library.backs[`backB-${deckId}`] : undefined;
  };
  const myBackColor = useBackColor(backUrlOf('me'));
  const oppBackColor = useBackColor(backUrlOf('opp'));
  const lifeTemplateOf = (side: SideKey) => {
    const deckId = state.players[seatOf(side)]?.deckId;
    return deckId ? library.templates.find((t) => t.deckId === deckId && t.isLife && t.imageUrl) : undefined;
  };
  const lifeCard = (side: SideKey, tpl: CardTemplate) => {
    const mine = canControl(side);
    const value = clamp(lifeOf(side), LIFE_MIN, LIFE_MAX);
    const info = side === 'me' ? myInfo : oppInfo;
    const h = compact ? 226 : 300;
    const w = h * LIFE_CARD_RATIO;
    const cx = side === 'me' ? SIDE_W / 2 : BOARD_W - SIDE_W / 2;
    const pr = zoneRect(side, 'play');
    const top = pr.y + pr.h / 2 - h / 2 - (compact ? 0 : 14);
    const left = cx - w / 2;
    const [tx, ty] = LIFE_TRACK[value];
    const token = w * 0.16;
    const btnStyle: React.CSSProperties = compact ? { width: 54, height: 54, fontSize: 30 } : { width: ui.life + 6, height: ui.life + 6, fontSize: isTouch ? 26 : 22 };
    return (
      <React.Fragment key={`life-${side}`}>
        <LifeAura left={left} top={top} w={w} h={h} color={(side === 'me' ? myBackColor : oppBackColor) || '#facc15'} />
        <div
          title={mine ? undefined : `Vida: ${value}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setLifeBig(side)}
          style={{
            position: 'absolute',
            left,
            top,
            width: w,
            height: h,
            borderRadius: 14,
            overflow: 'hidden',
            zIndex: 50,
            cursor: 'zoom-in',
            boxShadow: '0 10px 25px rgba(0,0,0,0.5)',
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
              transition: 'left 0.3s ease-out, top 0.3s ease-out',
              pointerEvents: 'none',
            }}
          />
        </div>
        <div style={{ ...pill, left: cx, top: top - 30, zIndex: 51 }}>
          {solo ? deckNameOf(side) || info?.name : info ? info.name : 'Esperando…'} · {value}
        </div>
        {/* + y − siempre debajo de la carta, también en el móvil */}
        {mine && (
          <div onPointerDown={(e) => e.stopPropagation()} style={{ position: 'absolute', left: cx, top: top + h + 8, transform: 'translateX(-50%)', display: 'flex', gap: compact ? 18 : 14, zIndex: 51 }}>
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
    // Sin mazo puesto todavía no hay vida que llevar
    if (!state.players[seatOf(side)]?.deckId) return null;
    const lifeTpl = lifeTemplateOf(side);
    if (lifeTpl) return lifeCard(side, lifeTpl);
    const mine = canControl(side);
    const value = lifeOf(side);
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
      const ry = t.ry ?? Math.max(0.1, 0.88 - k * 0.16);
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
            border: `${compact ? 2 : 3}px solid #000`,
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

  const voice = useVoiceRecorder(
    (clip) => send({ t: 'voice', ...clip }),
    (message) => toast(message),
  );
  const audioUrl = (id: string) => `${serverUrl}/api/audio?room=${encodeURIComponent(state.code)}&id=${encodeURIComponent(id)}`;
  const voiceOf = (entry: (typeof state.log)[number], color?: string) =>
    entry.audio && (
      <VoiceMessage
        id={entry.audio.id}
        url={audioUrl(entry.audio.id)}
        dur={entry.audio.dur}
        wave={entry.audio.wave}
        mine={entry.by === state.you}
        heard={entry.audio.heard}
        color={color}
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

  // Al entrar en la sala se recargan los mazos del servidor (por si se han publicado nuevos)
  useEffect(() => {
    if (!solo) onReloadLibrary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Avisa al rival de si esta ventana tiene la partida a la vista
  useEffect(() => {
    if (solo || status !== 'open') return;
    const report = () => send({ t: 'visibility', visible: document.visibilityState === 'visible' });
    report();
    document.addEventListener('visibilitychange', report);
    return () => document.removeEventListener('visibilitychange', report);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [solo, status]);
  useEffect(() => {
    const chats = state.log.filter((e) => e.kind === 'chat');
    const unseen = chats.filter((e) => !toastedChat.current.has(e.id));
    for (const e of unseen) toastedChat.current.add(e.id);
    if (solo || showLog) return;
    const fresh = unseen.filter((e) => e.by && e.by !== state.you && !e.reaction);
    if (!fresh.length) return;
    playChatSound();
    setChatToasts((prev) => [...prev, ...fresh.map((e) => ({ id: e.id, text: e.text }))].slice(-3));
    for (const e of fresh) {
      // Los audios se quedan más tiempo para poder escucharlos sin abrir el chat
      const wait = e.audio ? 15000 : 5000;
      window.setTimeout(() => setChatToasts((prev) => prev.map((t) => (t.id === e.id ? { ...t, leaving: true } : t))), wait);
      window.setTimeout(() => setChatToasts((prev) => prev.filter((t) => t.id !== e.id)), wait + 400);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.log]);
  useEffect(() => {
    if (showLog) setChatToasts([]);
  }, [showLog]);
  // El selector de emojis de la mesa se cierra al tocar fuera
  useEffect(() => {
    if (emojiOpen !== 'board') return;
    const close = () => setEmojiOpen(null);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [emojiOpen]);
  // Mensajes solo de emojis: además salen grandes por la mesa (para los dos)
  useEffect(() => {
    const fresh = state.log.filter((e) => e.kind === 'chat' && !burstSeen.current.has(e.id));
    for (const e of fresh) burstSeen.current.add(e.id);
    if (solo) return;
    const emo = fresh
      .filter((e) => !e.audio && e.by)
      .map((e) => ({ id: e.id, text: e.text.slice((state.players[e.by!]?.name || '').length + 2), mine: e.by === state.you }))
      .filter((b) => isEmojiOnly(b.text));
    if (!emo.length) return;
    setBursts((prev) => [...prev, ...emo].slice(-4));
    for (const b of emo) window.setTimeout(() => setBursts((prev) => prev.filter((x) => x.id !== b.id)), 2600);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.log]);
  const chatBody = (entry: (typeof state.log)[number]) => {
    if (entry.kind !== 'chat' || !entry.by) return null;
    const name = state.players[entry.by]?.name || '';
    const prefix = `${name}: `;
    if (!entry.text.startsWith(prefix)) return null;
    const rest = entry.text.slice(prefix.length);
    const color = (entry.by === state.you ? myBackColor : oppBackColor) || undefined;
    if (entry.audio)
      return (
        <>
          {logText(prefix)}
          <div style={{ marginTop: 4 }}>{voiceOf(entry, color)}</div>
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

  const handRevealed = !!myInfo?.handRevealed;
  // Solo cuentan los mensajes del rival sin leer
  const unread = showLog ? 0 : state.log.filter((e) => e.kind === 'chat' && e.by && e.by !== state.you && !e.reaction && !seenChat.has(e.id)).length;
  const btn: React.CSSProperties = { padding: ui.pad, fontSize: ui.font };
  // La vista ampliada solo se muestra si la carta sigue donde estaba (y boca arriba)
  const hoverStillThere =
    !!hoverTemplate &&
    !drag &&
    (state.hand.some((c) => c.id === hoverTemplate.cardId) ||
      state.oppHand.some((c, i) => (c.id ?? `opp-hand-${i}`) === hoverTemplate.cardId && c.templateId === hoverTemplate.templateId) ||
      [...state.me.play, ...state.opp.play].some((c) => c.id === hoverTemplate.cardId && c.isFaceUp) ||
      // Carta Especial arriba de una biblioteca o en un cementerio
      (hoverTemplate.cardId.startsWith('special-') &&
        [state.me, state.opp].some((sd) => sd.library.top?.templateId === hoverTemplate.templateId || sd.graveyard.some((g) => g.templateId === hoverTemplate.templateId))));
  // Con ratón, la carta seleccionada se queda ampliada aunque el ratón salga de ella (para mover sus tokens desde ahí)
  const selectedPreview = !isTouch && selectedCard?.isFaceUp && selectedCard.templateId ? selectedCard : null;
  // Mientras se señala no se amplía ninguna carta (vuelve al terminar de señalar)
  const previewTemplate = pointing
    ? undefined
    : pressPreview
    ? templateMap.get(pressPreview)
    : hoverStillThere
      ? templateMap.get(hoverTemplate!.templateId)
      : selectedPreview
        ? templateMap.get(selectedPreview.templateId!)
        : undefined;
  const previewCardId = pointing ? null : pressPreview ? pressCard : hoverStillThere ? hoverTemplate!.cardId : selectedPreview ? selectedPreview.id : null;
  // Tokens de la carta ampliada: se ven y se pueden mover desde ahí
  const previewTokens = (big: boolean) => {
    if (!previewCardId) return null;
    const list = state.tokens.filter((t) => t.cardId === previewCardId);
    if (!list.length) return null;
    const pos = (e: React.PointerEvent) => {
      const box = (e.currentTarget as HTMLElement).parentElement!;
      const r = appRect(box);
      const p = appPoint(e.clientX, e.clientY);
      return { rx: clamp((p.x - r.left) / r.width, 0, 1), ry: clamp((p.y - r.top) / r.height, 0, 1) };
    };
    return list.map((t, k) => {
      const moving = previewDrag?.id === t.id ? previewDrag : null;
      const rx = moving ? moving.rx : t.rx ?? 0.8;
      const ry = moving ? moving.ry : t.ry ?? Math.max(0.1, 0.88 - k * 0.16);
      return (
        <div
          key={t.id}
          className="ol-preview-token"
          title="Arrastra para mover el token"
          onPointerEnter={() => window.clearTimeout(hoverHideTimer.current)}
          onPointerLeave={() => !previewDrag && !pressPreview && hidePreview()}
          onPointerDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            window.clearTimeout(previewTimer.current);
            window.clearTimeout(hoverHideTimer.current);
            setPreviewDrag({ id: t.id, ...pos(e) });
          }}
          onPointerMove={(e) => previewDrag?.id === t.id && setPreviewDrag({ id: t.id, ...pos(e) })}
          onPointerUp={(e) => {
            if (previewDrag?.id !== t.id) return;
            const p = pos(e);
            setPreviewDrag(null);
            patchState((st) => ({ ...st, tokens: st.tokens.map((x) => (x.id === t.id ? { ...x, ...p } : x)) }));
            send({ t: 'tokenMove', id: t.id, ...p });
            if (pressPreview && !big) previewTimer.current = window.setTimeout(() => setPressPreview(null), 8000);
          }}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            left: `${rx * 100}%`,
            top: `${ry * 100}%`,
            width: `${attachedTokenRatio * 100}%`,
            aspectRatio: '1',
            transform: `translate(-50%, -50%)${moving ? ' scale(1.15)' : ''}`,
            borderRadius: '50%',
            background: '#facc15',
            border: '3px solid #000',
            boxShadow: '0 4px 12px rgba(0,0,0,0.6)',
            cursor: moving ? 'grabbing' : 'grab',
            pointerEvents: 'auto',
            touchAction: 'none',
          }}
        />
      );
    });
  };

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
  // Elegir mazo lo pone ya barajado en la biblioteca
  const pickDeck = (side: SideKey, deckId: string) => {
    const go = () => {
      sendAs(side, { t: 'chooseDeck', deckId });
      sendAs(side, { t: 'spawnDeck' });
    };
    const who = solo ? `de ${state.players[seatOf(side)]?.name}` : 'tus';
    if (cardsOf(side) > 0)
      confirm('Cambiar de mazo', `Se retirarán todas las cartas ${who} (biblioteca, mano, mesa y cementerio) y se pondrá el nuevo mazo barajado. ¿Seguro?`, go);
    else go();
  };

  // Campeón de un lado en el panel de un jugador: su reverso, nombre y botón para cambiarlo
  const soloSeat = (side: SideKey) => {
    const p = state.players[seatOf(side)];
    const deckId = p?.deckId;
    const cover = deckId ? library.backs[`backA-${deckId}`] || library.backs[`backB-${deckId}`] : undefined;
    const life = deckId ? lifeOf(side) : null;
    return (
      <button key={side} className="ol-solo-seat" onClick={() => setSoloPick(side)} title="Elegir o cambiar el campeón">
        <span className="ol-solo-cover" style={{ boxShadow: deckId ? `0 0 0 2px ${(side === 'me' ? myBackColor : oppBackColor) || 'transparent'}` : undefined }}>
          {cover ? <img src={cover} alt="" /> : <Layers size={16} />}
        </span>
        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
          <span style={{ fontSize: isTouch ? 13 : 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            {p?.name} · {side === 'me' ? 'abajo' : 'arriba'}
          </span>
          <strong style={{ fontSize: isTouch ? 17 : 15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>
            {deckId ? library.deckNames[deckId] || 'Mazo' : 'Elegir campeón'}
          </strong>
        </span>
        {life !== null ? <span className="ol-solo-life">{life}</span> : <Swords size={16} style={{ color: 'var(--color-accent)' }} />}
      </button>
    );
  };
  const soloPanel = (
    <div
      className="glass-panel"
      onPointerDown={(e) => e.stopPropagation()}
      style={panelBox}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: '#fff' }}>Un jugador</div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn-secondary" onClick={onLeave} title="Editor de mazos" style={btn}>
            <BookOpen size={14} /> Mazos
          </button>
          {fullscreenBtn}
        </div>
      </div>
      {soloSeat('opp')}
      {soloSeat('me')}
      <div style={{ height: 1, background: 'var(--glass-border)' }} />
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn-primary" onClick={() => setShowEnd(true)} style={{ ...btn, flex: 1 }} title="Registrar qué campeón ha ganado">
          <Trophy size={14} /> Terminar partida
        </button>
        <button className="btn-secondary" onClick={() => setShowHistory(true)} style={{ ...btn, flex: 1 }} title="Ver qué campeones han ganado">
          <History size={14} /> Historial
        </button>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn-secondary" onClick={() => setShowLog((v) => !v)} style={{ ...btn, flex: 1 }}>
          <MessageSquare size={14} /> Registro
        </button>
        <button
          className="btn-danger"
          onClick={() => confirm('Reiniciar mesa', 'Se retirarán todas las cartas y tokens de los dos jugadores y las vidas volverán a 10. ¿Seguro?', () => send({ t: 'reset' }))}
          style={{ ...btn, flex: 1 }}
        >
          Reiniciar
        </button>
      </div>
      {onOpenOnline && (
        <button className="btn-danger" onClick={onOpenOnline} title="Volver a la portada" style={btn}>
          <LogOut size={14} /> Salir
        </button>
      )}
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
          onClick={toggleHand}
          style={btn}
        >
          {handRevealed ? <EyeOff size={ui.icon} /> : <Eye size={ui.icon} />} {handRevealed ? 'Ocultar mi mano' : 'Enseñar mi mano al rival'}
        </button>
      )}
      <div style={{ height: 1, background: 'var(--glass-border)' }} />
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
    </div>
  );

  // Registro más vistoso: nombres de los jugadores en negrita con el color de su campeón y cambios de vida resaltados
  const logText = (text: string) => {
    const people = (['me', 'opp'] as SideKey[])
      .map((side) => ({ name: state.players[seatOf(side)]?.name, color: (side === 'me' ? myBackColor : oppBackColor) || '#e5e7eb' }))
      .filter((p): p is { name: string; color: string } => !!p.name)
      .sort((a, b) => b.name.length - a.name.length);
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = [...people.map((p) => esc(p.name)), 'vida \\d+ → \\d+(?: \\([+-]?\\d+\\))?'];
    const re = new RegExp(`(${parts.join('|')})`, 'g');
    // split con un grupo: las posiciones impares son lo encontrado
    return text.split(re).map((piece, i) => {
      if (!piece) return null;
      if (i % 2 === 1) {
        const who = people.find((p) => p.name === piece);
        return (
          <strong key={i} style={{ color: who ? `color-mix(in srgb, ${who.color} 75%, white)` : '#fde047' }}>
            {piece}
          </strong>
        );
      }
      return <React.Fragment key={i}>{piece}</React.Fragment>;
    });
  };
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
      <button className="btn-secondary" onClick={tokenOnCard} title="Poner un token en esta carta (T)" style={btn}>
        <span style={tokenDot} /> Token
      </button>
      {canControl(selectedSide) && (
        <button className="btn-secondary" onClick={() => moveSelected('hand')} title="A la mano (H)" style={btn}>
          <Hand size={ui.icon} /> A la mano
        </button>
      )}
      <button className="btn-secondary" onClick={() => moveSelected('graveyard')} title="Al cementerio (G)" style={btn}>
        <Archive size={ui.icon} /> Cementerio
      </button>
      {canControl(selectedSide) && (
        <button className="btn-secondary" onClick={startPointing} title="Señalar hasta 3 cartas con flechas" style={btn}>
          <Crosshair size={ui.icon} /> Señalar
        </button>
      )}
    </div>
  );

  // Barra de acciones a tamaño normal para móvil (fuera de la mesa escalada)
  const barBtn: React.CSSProperties = { padding: '6px 10px', fontSize: 14 };
  const sideName = (side: SideKey) => (solo ? state.players[seatOf(side)]?.name : side === 'me' ? 'tu' : oppInfo?.name);
  let barTitle = '';
  let barContent: React.ReactNode = null;
  if (compact) {
    if (selectedCard && cardMenu === selectedCard.id) {
      barTitle = 'Carta';
      barContent = (
        <>
          <button className="btn-secondary" onClick={tokenOnCard} style={barBtn}>
            <span style={tokenDot} /> Token
          </button>
          {canControl(selectedSide) && (
            <button className="btn-secondary" onClick={() => moveSelected('hand')} style={barBtn}>
              <Hand size={16} /> Mano
            </button>
          )}
          <button className="btn-secondary" onClick={() => moveSelected('graveyard')} style={barBtn}>
            <Archive size={16} /> Cementerio
          </button>
          {canControl(selectedSide) && (
            <button className="btn-secondary" onClick={startPointing} style={barBtn}>
              <Crosshair size={16} /> Señalar
            </button>
          )}
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
      const value = lifeOf(lifeSel);
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

  // Flechas de "señalar": trazos como hechos a mano, de la carta que señala a la parte baja de cada objetivo
  const pointerArrows = () => {
    const p = pointer && pointer.rev !== hiddenPointRev ? pointer : null;
    if (!p) return null;
    const color = (p.by === seatOf('me') ? myBackColor : oppBackColor) || '#ef4444';
    const arrows: (BrushArrow & { key: string })[] = [];
    {
      const a = playLayout.get(p.from);
      if (a)
        for (const t of p.targets) {
          const b = playLayout.get(t);
          if (!b) continue;
          // Mismo dibujo para los dos jugadores y siempre igual para esta pareja de cartas
          // (añadir otro objetivo no cambia las flechas que ya estaban)
          const rand = seededRandom(`${p.from}:${t}`);
          const from = { x: a.x + L.cardW * (0.4 + rand() * 0.2), y: a.y + L.cardH * (0.42 + rand() * 0.16) };
          // La punta se queda justo fuera del borde que mira hacia la carta de origen,
          // para no tapar las habilidades de la parte de abajo de la carta
          const gap = 4;
          const ax = a.x + L.cardW / 2;
          const ay = a.y + L.cardH / 2;
          // `into`: la dirección en la que la punta entra en la carta (perpendicular a ese borde)
          const vertical = Math.abs(ay - (b.y + L.cardH / 2)) > L.cardH * 0.6;
          const below = ay > b.y + L.cardH / 2;
          const right = ax > b.x + L.cardW / 2;
          const to = vertical
            ? { x: b.x + L.cardW * (0.3 + rand() * 0.4), y: below ? b.y + L.cardH + gap : b.y - gap }
            : { x: right ? b.x + L.cardW + gap : b.x - gap, y: b.y + L.cardH * (0.3 + rand() * 0.2) };
          const into = vertical ? { x: 0, y: below ? -1 : 1 } : { x: right ? -1 : 1, y: 0 };
          arrows.push({ key: `${p.from}-${t}`, ...brushArrow(from, to, rand, L.cardH, into) });
        }
    }
    return (
      <svg width={BOARD_W} height={L.boardH} style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none', zIndex: 440000, overflow: 'visible', color }}>
        <defs>
          <filter id="ol-arrow-shadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="4" stdDeviation="4" floodColor="#000" floodOpacity="0.6" />
          </filter>
        </defs>
        {arrows.map((a) => (
          <g key={a.key} filter="url(#ol-arrow-shadow)">
            <mask id={`ol-mask-${a.key}`} maskUnits="userSpaceOnUse">
              <path d={a.spine} fill="none" stroke="#fff" strokeWidth={40} strokeLinecap="round" pathLength={1} className="ol-arrow-draw" />
            </mask>
            <g mask={`url(#ol-mask-${a.key})`}>
              <path d={a.body} fill="currentColor" stroke="rgba(0,0,0,0.65)" strokeWidth={2.5} strokeLinejoin="round" />
            </g>
            <path d={a.head} fill="currentColor" stroke="rgba(0,0,0,0.65)" strokeWidth={2.5} strokeLinejoin="round" className="ol-arrow-head" style={{ transformOrigin: `${a.tip.x}px ${a.tip.y}px` }} />
          </g>
        ))}
      </svg>
    );
  };

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
          setPointing(null);
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
          {pointerArrows()}
          {tokens}
          {ghost()}
          {solo && cardsOf('me') + cardsOf('opp') === 0 && (
            <div style={{ position: 'absolute', left: SIDE_W, top: L.boardH / 2 - 20, width: PLAY_W, textAlign: 'center', color: 'rgba(255,255,255,0.4)', fontSize: 22, pointerEvents: 'none' }}>
              Elige el campeón de cada jugador en el panel para empezar
            </div>
          )}
          {/* Quién empieza el primer turno; pulsarlo cambia al otro jugador */}
          {!solo && state.starter && oppInfo && !state.started && (() => {
            const mine = state.starter === me;
            const top = (zoneRect('opp', 'play').y + zoneRect('opp', 'play').h + zoneRect('me', 'play').y) / 2;
            return (
              <button
                className="btn-secondary ol-starter"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => send({ t: 'toggleStarter' })}
                title="Pulsa para que empiece el otro jugador"
                style={{
                  position: 'absolute',
                  left: SIDE_W + PLAY_W - 20,
                  top,
                  transform: 'translate(-100%, -50%)',
                  zIndex: 400,
                  padding: compact ? '8px 16px' : '6px 14px',
                  fontSize: compact ? 22 : 15,
                  background: 'rgba(18,24,38,0.92)',
                  border: '2px solid #ef4444',
                  boxShadow: '0 0 18px rgba(239,68,68,0.45)',
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <span className="ol-starter-arrow" style={{ display: 'flex', color: '#ef4444' }}>
                  {mine ? <ArrowDown size={compact ? 30 : 20} strokeWidth={3} /> : <ArrowUp size={compact ? 30 : 20} strokeWidth={3} />}
                </span>
                {mine ? 'Empiezas tú' : `Empieza ${oppInfo.name}`}
              </button>
            );
          })()}
          {!solo && !myInfo?.deckId && (
            <div style={{ position: 'absolute', left: SIDE_W, top: zoneRect('me', 'play').y + zoneRect('me', 'play').h * 0.4, width: PLAY_W, textAlign: 'center', zIndex: 300 }}>
              <button className="btn-primary" onPointerDown={(e) => e.stopPropagation()} onClick={() => setPickClosed(false)} style={{ fontSize: compact ? 24 : 18, padding: '10px 22px' }}>
                Elegir campeón
              </button>
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


        {/* Carta de vida ampliada (con su token); otro toque la cierra */}
        {lifeBig && (() => {
          const tpl = lifeTemplateOf(lifeBig);
          if (!tpl?.imageUrl) return null;
          const [tx, ty] = LIFE_TRACK[clamp(lifeOf(lifeBig), LIFE_MIN, LIFE_MAX)];
          return (
            <div
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setLifeBig(null)}
              style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 700500, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <div
                className="ol-preview-big ol-life-big"
                style={{ position: 'relative', height: 'calc(100% - 16px)', maxWidth: 'calc(100% - 16px)', aspectRatio: `${LIFE_CARD_RATIO}`, borderRadius: 18, overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,0.9)' }}
              >
                <img src={tpl.imageUrl} alt={tpl.name} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                <div
                  style={{
                    position: 'absolute',
                    left: `${(tx - 0.08) * 100}%`,
                    top: `calc(${ty * 100}% - ${8 * LIFE_CARD_RATIO}%)`,
                    width: '16%',
                    aspectRatio: '1',
                    borderRadius: '50%',
                    background: 'radial-gradient(circle at 35% 30%, #fde68a, #facc15 55%, #ca8a04)',
                    border: '4px solid #000',
                    boxShadow: '0 8px 16px rgba(0,0,0,0.55)',
                    transition: 'left 0.3s ease-out, top 0.3s ease-out',
                  }}
                />
              </div>
            </div>
          );
        })()}
        {/* Vista ampliada de la carta tocada, a pantalla grande para leerla bien; otro toque la cierra */}
        {previewBig && pressPreview && previewTemplate?.imageUrl && (
          <div
            onPointerDown={(e) => e.stopPropagation()}
            onClick={hidePressPreview}
            style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 700500, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <div className="ol-preview-big" style={{ position: 'relative', height: 'calc(100% - 16px)', maxWidth: 'calc(100% - 16px)', aspectRatio: `${CARD_W} / ${CARD_H}` }}>
              <img
                src={previewTemplate.imageUrl}
                alt={previewTemplate.name}
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', borderRadius: 16, boxShadow: '0 20px 60px rgba(0,0,0,0.9)' }}
              />
              {previewTokens(true)}
            </div>
          </div>
        )}
        {/* Vista ampliada de la carta bajo el ratón (o tocada: un toque en ella la agranda) */}
        {previewTemplate?.imageUrl && !previewBig && (
          <div
            style={{
              position: 'absolute',
              top: solo ? 12 : compact ? 56 : 58, // por debajo de los botones de emojis, audio y chat
              right: 12, // siempre en la misma esquina
              height: 'min(480px, 62%)',
              aspectRatio: `${CARD_W} / ${CARD_H}`,
              pointerEvents: 'none',
              zIndex: 600000,
            }}
          >
            <img
              src={previewTemplate.imageUrl}
              alt={previewTemplate.name}
              onPointerDown={pressPreview ? (e) => e.stopPropagation() : undefined}
              onClick={
                pressPreview
                  ? () => {
                      window.clearTimeout(previewTimer.current);
                      setPreviewBig(true);
                    }
                  : undefined
              }
              style={{
                width: '100%',
                height: '100%',
                display: 'block',
                objectFit: 'cover',
                borderRadius: 14,
                boxShadow: '0 20px 50px rgba(0,0,0,0.8)',
                pointerEvents: pressPreview ? 'auto' : 'none',
              }}
            />
            {previewTokens(false)}
          </div>
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
                  {chatBody(entry) ?? logText(entry.text)}
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
            {!solo && <form onSubmit={sendChat} style={{ position: 'relative', display: 'flex', gap: 6, padding: 8, borderTop: '1px solid var(--glass-border)', alignItems: 'center' }}>
              {emojiOpen === 'panel' && (
                <EmojiPicker
                  onPick={(e) => setChatText((t) => (t + e).slice(0, 300))}
                  style={{ position: 'absolute', left: 8, right: 8, bottom: 'calc(100% + 6px)' }}
                />
              )}
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
              </>
              )}
              {chatText.trim() && voice.phase === 'idle' ? (
                <button className="btn-primary" type="submit" style={{ padding: '6px 10px', fontSize: '0.75rem' }}>
                  Enviar
                </button>
              ) : (
                <MicButton rec={voice} size={16} onSlide={setMicSlide} style={{ padding: 6 }} />
              )}
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

        {/* Botón de chat siempre a mano arriba a la derecha */}
        {!solo && !showLog && (
          <div style={{ position: 'absolute', top: compact ? 8 : 12, right: compact ? 8 : 12, zIndex: 650000, display: 'flex', gap: 6, alignItems: 'center' }}>
            {voice.phase !== 'idle' && <RecordingBar rec={voice} slide={micSlide} />}
            {voice.phase === 'idle' && (
              <button
                className="btn-secondary"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => setEmojiOpen((o) => (o === 'board' ? null : 'board'))}
                title="Enviar un emoji"
                style={{ padding: compact ? 9 : 8, background: emojiOpen === 'board' ? 'rgba(60,70,95,0.95)' : 'rgba(18,24,38,0.92)', display: 'flex' }}
              >
                <Smile size={compact ? 20 : 16} />
              </button>
            )}
            <MicButton rec={voice} size={compact ? 20 : 16} onSlide={setMicSlide} style={{ padding: compact ? 9 : 8, background: voice.phase === 'idle' ? 'rgba(18,24,38,0.92)' : undefined }} />
            <button
              className="btn-secondary"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                setEmojiOpen(null);
                setShowLog(true);
              }}
              title="Abrir el chat"
              style={{ padding: compact ? 9 : '8px 12px', background: 'rgba(18,24,38,0.92)', display: 'flex', alignItems: 'center', gap: 6 }}
            >
              <MessageSquare size={compact ? 20 : 16} />
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
                style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, width: compact ? 330 : 300 }}
              />
            )}
          </div>
        )}

        {/* Emojis enviados: suben grandes por la mesa */}
        {bursts.map((b) => (
          <div key={b.id} className="ol-emoji-burst" style={{ left: b.mine ? '38%' : '62%', top: b.mine ? '62%' : '30%' }}>
            {b.text}
          </div>
        ))}

        {/* Avisos de chat del rival: entran por la derecha y se van solos; al pulsarlos se abre el chat */}
        {chatToasts.length > 0 && (
          <div style={{ position: 'absolute', right: 12, top: compact ? 60 : 64, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end', zIndex: 760000, pointerEvents: 'none' }}>
            {chatToasts.map((t) => (
              <div
                key={t.id}
                className={`glass-panel ol-chat-toast${t.leaving ? ' ol-chat-toast-out' : ''}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => setShowLog(true)}
                title="Abrir el chat"
                style={{ pointerEvents: 'auto', cursor: 'pointer', maxWidth: compact ? 260 : 340, padding: '10px 14px', fontSize: compact ? 14 : 15, display: 'flex', gap: 8, alignItems: 'flex-start', boxShadow: '0 10px 30px rgba(0,0,0,0.5)' }}
              >
                <MessageSquare size={16} style={{ flexShrink: 0, marginTop: 2, color: 'var(--color-accent)' }} />
                {(() => {
                  const entry = state.log.find((e) => e.id === t.id);
                  if (entry?.audio)
                    return (
                      <span>
                        {logText(t.text.replace(/mensaje de voz$/, ''))}
                        <div style={{ marginTop: 4 }}>{voiceOf(entry, oppBackColor || undefined)}</div>
                      </span>
                    );
                  return <span style={{ wordBreak: 'break-word' }}>{t.text}</span>;
                })()}
              </div>
            ))}
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
      {/* Al entrar en la sala: elegir campeón y queda todo listo para jugar */}
      {((!solo && !myInfo?.deckId && !pickClosed) || (solo && soloPick)) && Object.keys(library.deckNames).length > 0 && (() => {
        const side: SideKey = solo ? soloPick! : 'me';
        const other = state.players[seatOf(side === 'me' ? 'opp' : 'me')];
        const close = () => (solo ? setSoloPick(null) : setPickClosed(true));
        const champH = compact ? 'min(230px, calc(var(--app-h, 100vh) - 132px))' : 'min(270px, calc(var(--app-h, 100vh) - 170px))';
        return (
        <Overlay onClose={close}>
          <h3 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: 4 }}>
            {solo ? `Campeón de ${state.players[seatOf(side)]?.name} (${side === 'me' ? 'abajo' : 'arriba'})` : 'Elige tu campeón'}
          </h3>
          <div style={{ display: 'flex', gap: compact ? 10 : 14, justifyContent: 'center', flexWrap: 'wrap', marginTop: compact ? 10 : 16 }}>
            {Object.entries(library.deckNames).map(([id, name]) => {
              const tpls = library.templates.filter((t) => t.deckId === id);
              // Reverso del mazo (siempre el tipo A; el B si no hay A)
              const cover = library.backs[`backA-${id}`] || library.backs[`backB-${id}`];
              const count = tpls.filter((t) => !t.isLife).reduce((n, t) => n + (t.quantity || 1), 0);
              const taken = !solo && oppInfo?.deckId === id;
              const current = state.players[seatOf(side)]?.deckId === id;
              const note = taken ? 'Lo usa tu rival' : solo && other?.deckId === id ? `Lo usa ${other.name}` : current ? 'Elegido' : '';
              return (
                <button
                  key={id}
                  className="btn-secondary ol-champion"
                  disabled={taken || count === 0}
                  onClick={() => {
                    if (!current) pickDeck(side, id);
                    if (!solo) return;
                    // Después del de abajo, el de arriba (si aún no tiene)
                    const next = side === 'me' && !state.players[seatOf('opp')]?.deckId ? 'opp' : null;
                    setSoloPick(next);
                  }}
                  style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: compact ? 6 : 8, opacity: taken || count === 0 ? 0.45 : 1, outline: current ? '2px solid var(--color-accent)' : undefined }}
                >
                  {/* Alto según la pantalla para que los reversos quepan enteros sin desplazarse */}
                  {cover ? (
                    <img src={cover} alt={name} style={{ height: champH, aspectRatio: `${CARD_W} / ${CARD_H}`, objectFit: 'cover', borderRadius: 8 }} />
                  ) : (
                    <div style={{ height: champH, aspectRatio: `${CARD_W} / ${CARD_H}`, borderRadius: 8, background: 'rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Layers size={28} />
                    </div>
                  )}
                  <span style={{ fontWeight: 700, fontSize: compact ? 14 : 15 }}>{name}</span>
                  {note && <span style={{ fontSize: 12, color: current ? 'var(--color-accent)' : 'var(--text-muted)' }}>{note}</span>}
                </button>
              );
            })}
          </div>
        </Overlay>
        );
      })()}

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
                  style={(() => {
                    // Cada botón con el color del reverso de su campeón: se ve quién gana sin leer
                    const c = seat === me ? myBackColor : oppBackColor;
                    return c
                      ? { padding: '10px 18px', fontSize: '0.95rem', background: c, borderColor: c, color: '#fff', textShadow: '0 1px 3px rgba(0,0,0,0.7)', boxShadow: `0 4px 16px ${c}` }
                      : { padding: '10px 18px', fontSize: '0.95rem' };
                  })()}
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
// Posiciones de las cartas de una mano: la Especial va en su hueco fijo (a la derecha del dueño;
// la mano del rival se ve girada, así que allí queda a la izquierda) y el resto se reparte en lo que queda
const SPECIAL_SLOT = SMALL_W + 30;
function handPositions(list: { isSpecial?: boolean }[], r: Rect, specialRight: boolean): { xs: number[]; specialX: number | null } {
  const hasSpecial = list.some((c) => c.isSpecial);
  const rest = hasSpecial ? { ...r, w: r.w - SPECIAL_SLOT, x: specialRight ? r.x : r.x + SPECIAL_SLOT } : r;
  const slots = handSlots(list.filter((c) => !c.isSpecial).length, rest);
  const specialX = hasSpecial ? (specialRight ? r.x + r.w - SPECIAL_SLOT + 12 : r.x + SPECIAL_SLOT - 12 - SMALL_W) : null;
  let k = 0;
  return { xs: list.map((c) => (c.isSpecial ? specialX! : slots[k++])), specialX };
}

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

// Sonido suave al recibir un mensaje (dos notas cortas, sin archivos de audio)
let chatAudio: AudioContext | null = null;
export function playChatSound() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    chatAudio = chatAudio || new Ctx();
    const ctx = chatAudio;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const now = ctx.currentTime;
    [880, 1318.5].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t0 = now + i * 0.12;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(0.08, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.4);
    });
  } catch {
    // sin sonido si el navegador no lo permite
  }
}

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


export const Overlay: React.FC<{ onClose: () => void; children: React.ReactNode }> = ({ onClose, children }) => (
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
      style={{ maxWidth: 'min(900px, calc(var(--app-w, 100vw) * 0.94))', maxHeight: 'calc(var(--app-h, 100vh) - 16px)', overflowY: 'auto', padding: 'clamp(12px, 3vh, 22px) clamp(18px, 4vw, 44px)', borderRadius: 16, position: 'relative', textAlign: 'center' }}
    >
      <button className="btn-secondary" onClick={onClose} style={{ position: 'absolute', top: 10, right: 10, padding: 4 }}>
        <X size={14} />
      </button>
      {children}
    </div>
  </div>
);

// Borde animado de la carta de vida: un brillo que gira lento con el color del reverso del campeón
export function LifeAura({ left, top, w, h, color }: { left: number; top: number; w: number; h: number; color: string }) {
  const m = 6; // separación entre la carta y el borde
  return (
    <div className="ol-aura" style={{ left: left - m, top: top - m, width: w + m * 2, height: h + m * 2, ['--aura-c' as string]: color } as React.CSSProperties}>
      <div className="ol-aura-ring" />
    </div>
  );
}

// Color del reverso: los reversos son rayas de dos tonos del mismo color más el blanco de los iconos.
// Se juntan los píxeles con color en grupos y, de los dos tonos más repetidos, se elige el más oscuro.
const backColorCache = new Map<string, string | null>();
export function useBackColor(url: string | undefined): string | null {
  const [, force] = useState(0);
  useEffect(() => {
    if (!url || backColorCache.has(url)) return;
    backColorCache.set(url, null);
    const img = new Image();
    if (!url.startsWith('data:') && !url.startsWith('blob:')) img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const S = 48;
        const cv = document.createElement('canvas');
        cv.width = S;
        cv.height = S;
        const ctx = cv.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(img, 0, 0, S, S);
        const d = ctx.getImageData(0, 0, S, S).data;
        const groups = new Map<number, { n: number; r: number; g: number; b: number }>();
        for (let i = 0; i < d.length; i += 4) {
          const [r, g, b, a] = [d[i], d[i + 1], d[i + 2], d[i + 3]];
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          if (a < 200 || max < 40 || max - min < 40) continue; // transparente, negro o blanco/gris
          const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
          const e = groups.get(key) || { n: 0, r: 0, g: 0, b: 0 };
          e.n++;
          e.r += r;
          e.g += g;
          e.b += b;
          groups.set(key, e);
        }
        const top = [...groups.values()].sort((x, y) => y.n - x.n).slice(0, 2).map((e) => [e.r / e.n, e.g / e.n, e.b / e.n]);
        if (top.length) {
          const lum = (c: number[]) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
          const c = top.length > 1 && lum(top[1]) < lum(top[0]) ? top[1] : top[0];
          backColorCache.set(url, `rgb(${c.map(Math.round).join(', ')})`);
          force((n) => n + 1);
        }
      } catch {
        /* imagen de otro origen sin permiso: se queda el color por defecto */
      }
    };
    img.src = url;
  }, [url]);
  return url ? backColorCache.get(url) || null : null;
}

// ---------- Flechas hechas a mano ----------

export type Pt = { x: number; y: number };
export type BrushArrow = { body: string; spine: string; head: string; tip: Pt };

// Números al azar repetibles a partir de un texto (igual en los dos jugadores)
export function seededRandom(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Trazo de pincel de `from` a `to`: curva con algo de azar (a veces en S), grosor que
// crece y se afina, un ligero temblor y una punta de flecha con las alas algo curvadas
export function brushArrow(from: Pt, to: Pt, rand: () => number, scale: number, into: Pt): BrushArrow {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const rot = (x: number, y: number, a: number) => ({ x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) });
  // Ángulos de salida y llegada al azar, a cada lado sin preferencia
  const a1 = (rand() < 0.5 ? -1 : 1) * (0.25 + rand() * 0.55);
  // Llegada casi de frente al borde de la carta (solo un poco ladeada), para que la punta mire a la carta
  const a2 = (rand() < 0.5 ? -1 : 1) * rand() * 0.22;
  const d1 = rot(ux, uy, a1);
  const d2 = rot(into.x, into.y, a2);
  const headLen = Math.min(scale * 0.2, 16 + len * 0.12);
  // El cuerpo termina donde empieza la punta
  const end = { x: to.x - d2.x * headLen * 0.75, y: to.y - d2.y * headLen * 0.75 };
  const c1 = { x: from.x + d1.x * len * (0.3 + rand() * 0.15), y: from.y + d1.y * len * (0.3 + rand() * 0.15) };
  const c2 = { x: end.x - d2.x * len * (0.25 + rand() * 0.15), y: end.y - d2.y * len * (0.25 + rand() * 0.15) };
  const at = (t: number) => {
    const m = 1 - t;
    return {
      x: m * m * m * from.x + 3 * m * m * t * c1.x + 3 * m * t * t * c2.x + t * t * t * end.x,
      y: m * m * m * from.y + 3 * m * m * t * c1.y + 3 * m * t * t * c2.y + t * t * t * end.y,
    };
  };
  const N = 36;
  const curve = Array.from({ length: N + 1 }, (_, i) => at(i / N));
  // El tronco sigue un poco por dentro de la punta para que no se vean separados
  const tail = curve[N];
  const pre = curve[N - 2];
  const tl0 = Math.hypot(tail.x - pre.x, tail.y - pre.y) || 1;
  const ext = (k: number) => ({ x: tail.x + ((tail.x - pre.x) / tl0) * headLen * k, y: tail.y + ((tail.y - pre.y) / tl0) * headLen * k });
  const pts = [...curve, ext(0.25), ext(0.5)];
  const M = pts.length - 1;
  const wobble = [rand() * 6, rand() * 6, 2 + rand() * 2];
  const maxW = Math.max(7, Math.min(13, scale * 0.07));
  const left: Pt[] = [];
  const right: Pt[] = [];
  pts.forEach((pt, i) => {
    const t = Math.min(1, i / N);
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(M, i + 1)];
    let tx = next.x - prev.x;
    let ty = next.y - prev.y;
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl;
    ty /= tl;
    // Fino al salir, más grueso hacia el final y algo irregular, como un pincel
    const w = (maxW / 2) * (0.25 + 0.75 * Math.sin(Math.min(1, t * 1.15) * Math.PI * 0.55)) * (1 + 0.12 * Math.sin(t * wobble[2] * Math.PI * 2 + wobble[0]));
    left.push({ x: pt.x - ty * w, y: pt.y + tx * w });
    right.push({ x: pt.x + ty * w, y: pt.y - tx * w });
  });
  const f = (n: number) => n.toFixed(1);
  const poly = (list: Pt[]) => list.map((q) => `${f(q.x)} ${f(q.y)}`).join(' L ');
  const body = `M ${poly(left)} L ${poly(right.reverse())} Z`;
  const spine = `M ${poly(pts)}`;
  // Punta: sigue la dirección del final de la curva
  const last = curve[N];
  const before = curve[N - 3];
  let hx = last.x - before.x;
  let hy = last.y - before.y;
  const hl = Math.hypot(hx, hy) || 1;
  hx /= hl;
  hy /= hl;
  const tip = { x: last.x + hx * headLen, y: last.y + hy * headLen };
  const half = headLen * (0.55 + rand() * 0.12);
  const back = { x: last.x - hx * headLen * 0.2, y: last.y - hy * headLen * 0.2 };
  const wingL = { x: back.x - hy * half, y: back.y + hx * half };
  const wingR = { x: back.x + hy * half, y: back.y - hx * half };
  const notch = { x: last.x + hx * headLen * 0.12, y: last.y + hy * headLen * 0.12 };
  const bow = (p1: Pt, p2: Pt, k: number) => ({ x: (p1.x + p2.x) / 2 - (p2.y - p1.y) * k, y: (p1.y + p2.y) / 2 + (p2.x - p1.x) * k });
  const qL = bow(tip, wingL, -0.12);
  const qR = bow(wingR, tip, -0.12);
  const head = `M ${f(tip.x)} ${f(tip.y)} Q ${f(qL.x)} ${f(qL.y)} ${f(wingL.x)} ${f(wingL.y)} L ${f(notch.x)} ${f(notch.y)} L ${f(wingR.x)} ${f(wingR.y)} Q ${f(qR.x)} ${f(qR.y)} ${f(tip.x)} ${f(tip.y)} Z`;
  return { body, spine, head, tip };
}
