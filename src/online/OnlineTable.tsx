import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Copy,
  Eye,
  Hand,
  LogOut,
  MessageSquare,
  RotateCcw,
  RotateCw,
  Search,
  Shuffle,
  Trash2,
  UserPlus,
  Layers,
  RefreshCw,
  X,
} from 'lucide-react';
import { Tabletop } from '../components/Tabletop';
import type { BoardCard, CardTemplate, Position } from '../types';
import type { OnlineState, PeekCard, Seat, ServerLibrary } from './types';
import { HandBar, OpponentHand } from './HandBar';
import { inviteLink } from './server';
import type { ConnectionStatus } from './useOnlineGame';

const hiddenTemplateId = (deckId: string, backType: string) => `hidden:${deckId}:${backType}`;

interface OnlineTableProps {
  state: OnlineState;
  status: ConnectionStatus;
  library: ServerLibrary;
  serverUrl: string;
  send: (msg: object) => void;
  moveItems: (kind: 'card' | 'counter', updates: { id: string; x: number; y: number }[]) => void;
  flushMoves: () => void;
  patchState: (fn: (s: OnlineState) => OnlineState) => void;
  shufflingIds: Set<string>;
  selectRequest: string[] | null;
  peek: PeekCard[] | null;
  onClosePeek: () => void;
  reveal: { by: Seat; templateId: string } | null;
  onCloseReveal: () => void;
  onReloadLibrary: () => void;
  onLeave: () => void;
  confirm: (title: string, message: string, onConfirm: () => void) => void;
  toast: (message: string) => void;
}

export const OnlineTable: React.FC<OnlineTableProps> = ({
  state,
  status,
  library,
  serverUrl,
  send,
  moveItems,
  flushMoves,
  patchState,
  shufflingIds,
  selectRequest,
  peek,
  onClosePeek,
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

  const [selectedCardIds, setSelectedCardIds] = useState<Set<string>>(new Set());
  const [selectedCounterIds, setSelectedCounterIds] = useState<Set<string>>(new Set());
  const [isBoardDragging, setIsBoardDragging] = useState(false);
  const [playFaceUp, setPlayFaceUp] = useState(true);
  const [showLog, setShowLog] = useState(true);
  const [chatText, setChatText] = useState('');
  const [seenLog, setSeenLog] = useState(state.log.length);

  const handBarRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<{ clientToBoard: (x: number, y: number) => Position } | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  // ---------- Datos derivados ----------

  const templates = useMemo(() => {
    const list: CardTemplate[] = [...library.templates];
    const hidden = new Set<string>();
    const addHidden = (deckId: string, backType: 'backA' | 'backB') => {
      const id = hiddenTemplateId(deckId, backType);
      if (hidden.has(id)) return;
      hidden.add(id);
      list.push({ id, name: '', deckId, backType, quantity: 1, createdAt: 0 });
    };
    state.cards.forEach((c) => !c.templateId && addHidden(c.deckId, c.backType));
    return list;
  }, [library.templates, state.cards]);

  const templateMap = useMemo(() => new Map(templates.map((t) => [t.id, t])), [templates]);

  const boardCards: BoardCard[] = useMemo(
    () =>
      state.cards.map((c) => ({
        id: c.id,
        templateId: c.templateId ?? hiddenTemplateId(c.deckId, c.backType),
        x: c.x,
        y: c.y,
        isFaceUp: c.isFaceUp,
        rotation: c.rotation,
        zIndex: c.zIndex,
      })),
    [state.cards],
  );

  // Quitar de la selección lo que ya no está en la mesa
  useEffect(() => {
    const ids = new Set(state.cards.map((c) => c.id));
    setSelectedCardIds((prev) => {
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
    const cIds = new Set(state.counters.map((c) => c.id));
    setSelectedCounterIds((prev) => {
      const next = new Set([...prev].filter((id) => cIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [state.cards, state.counters]);

  useEffect(() => {
    if (selectRequest) {
      setSelectedCardIds(new Set(selectRequest));
      setSelectedCounterIds(new Set());
    }
  }, [selectRequest]);

  useEffect(() => {
    if (showLog) {
      setSeenLog(state.log.length);
      logEndRef.current?.scrollIntoView({ block: 'end' });
    }
  }, [state.log, showLog]);

  // ---------- Acciones sobre la mesa ----------

  const selectedIds = () => [...selectedCardIds];

  const bringToFront = (ids: string[], kind: 'card' | 'counter') => {
    patchState((s) => {
      let z = Math.max(0, ...s.cards.map((c) => c.zIndex), ...s.counters.map((c) => c.zIndex));
      if (kind === 'card') {
        const order = s.cards.filter((c) => ids.includes(c.id)).sort((a, b) => a.zIndex - b.zIndex);
        const newZ = new Map(order.map((c) => [c.id, ++z]));
        return { ...s, cards: s.cards.map((c) => (newZ.has(c.id) ? { ...c, zIndex: newZ.get(c.id)! } : c)) };
      }
      const order = s.counters.filter((c) => ids.includes(c.id)).sort((a, b) => a.zIndex - b.zIndex);
      const newZ = new Map(order.map((c) => [c.id, ++z]));
      return { ...s, counters: s.counters.map((c) => (newZ.has(c.id) ? { ...c, zIndex: newZ.get(c.id)! } : c)) };
    });
    send({ t: kind === 'card' ? 'front' : 'counterFront', ids });
  };

  const handleFlip = () => selectedCardIds.size && send({ t: 'flip', ids: selectedIds() });
  const handleRotate = (deg: number) => selectedCardIds.size && send({ t: 'rotate', ids: selectedIds(), deg });
  const handleShuffle = () => selectedCardIds.size > 1 && send({ t: 'shuffle', ids: selectedIds() });
  const handleDelete = () => {
    if (selectedCardIds.size === 0 && selectedCounterIds.size === 0) return;
    send({ t: 'delete', cardIds: selectedIds(), counterIds: [...selectedCounterIds] });
    setSelectedCardIds(new Set());
    setSelectedCounterIds(new Set());
  };
  const handleToHand = () => selectedCardIds.size && send({ t: 'toHand', ids: selectedIds() });
  const handleDraw = () => send({ t: 'draw', ids: selectedCardIds.size > 1 ? selectedIds() : [] });
  const handlePeek = () => send({ t: 'peek', ids: selectedIds() });

  const handleDoubleClickCard = (id: string) => {
    const target = state.cards.find((c) => c.id === id);
    if (!target) return;
    setSelectedCardIds(new Set(state.cards.filter((c) => c.x === target.x && c.y === target.y).map((c) => c.id)));
    setSelectedCounterIds(new Set());
  };

  const handleCardsDropped = (ids: string[], clientX: number, clientY: number) => {
    const rect = handBarRef.current?.getBoundingClientRect();
    if (!rect) return false;
    const inside = clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
    if (!inside) return false;
    send({ t: 'toHand', ids });
    return true;
  };

  const handleDragState = useCallback(
    (dragging: boolean) => {
      setIsBoardDragging(dragging);
      if (!dragging) flushMoves();
    },
    [flushMoves],
  );

  const handlePlay = (id: string, clientX: number, clientY: number, faceUp: boolean) => {
    const p = viewportRef.current?.clientToBoard(clientX, clientY) || { x: 500, y: 300 };
    send({ t: 'play', id, x: p.x - 65, y: p.y - 103, faceUp });
  };

  const handleExtraKey = (key: string) => {
    if (key === 'r') {
      handleDraw();
      return true;
    }
    if (key === 'h') {
      handleToHand();
      return true;
    }
    return false;
  };

  const sendChat = (e: React.FormEvent) => {
    e.preventDefault();
    const text = chatText.trim();
    if (!text) return;
    send({ t: 'chat', text });
    setChatText('');
  };

  const copyInvite = async () => {
    const link = inviteLink(serverUrl, state.code);
    try {
      await navigator.clipboard.writeText(link);
      toast('Enlace de invitación copiado');
    } catch {
      toast(link);
    }
  };

  // ---------- Selección ----------

  const selectedCards = state.cards.filter((c) => selectedCardIds.has(c.id));
  const canPeek = selectedCards.length > 0 && selectedCards.every((c) => c.owner === me && !c.isFaceUp);
  const hasSelection = selectedCardIds.size > 0 || selectedCounterIds.size > 0;
  const unread = showLog ? 0 : Math.max(0, state.log.length - seenLog);
  const myDeckOnTable = state.cards.some((c) => c.owner === me) || state.hand.length > 0;
  const btn = { padding: '6px 12px', fontSize: '0.8rem' } as const;

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative', overflow: 'hidden' }}>
      <Tabletop
        cards={boardCards}
        counters={state.counters}
        templates={templates}
        selectedCardIds={selectedCardIds}
        selectedCounterIds={selectedCounterIds}
        shufflingCardIds={shufflingIds}
        backUrls={library.backs}
        onSelectItems={(cards, counters) => {
          setSelectedCardIds(cards);
          setSelectedCounterIds(counters);
        }}
        onClearSelection={() => {
          setSelectedCardIds(new Set());
          setSelectedCounterIds(new Set());
        }}
        onUpdateCardPositions={(u) => moveItems('card', u)}
        onUpdateCounterPositions={(u) => moveItems('counter', u)}
        onUpdateCounterValue={(id, value) => {
          patchState((s) => ({ ...s, counters: s.counters.map((c) => (c.id === id ? { ...c, value } : c)) }));
          send({ t: 'counterValue', id, value });
        }}
        onUpdateCounterLabel={(id, label) => {
          patchState((s) => ({ ...s, counters: s.counters.map((c) => (c.id === id ? { ...c, label } : c)) }));
          send({ t: 'counterLabel', id, label });
        }}
        onUpdateCardsZIndex={(ids) => bringToFront(ids, 'card')}
        onUpdateCountersZIndex={(ids) => bringToFront(ids, 'counter')}
        onDoubleClickCard={handleDoubleClickCard}
        onFlipSelected={handleFlip}
        onRotateSelected={handleRotate}
        onDeleteSelected={handleDelete}
        onShuffleSelected={handleShuffle}
        onCardsDropped={handleCardsDropped}
        onDragStateChange={handleDragState}
        onExtraKey={handleExtraKey}
        viewportRef={viewportRef}
      />

      {/* Panel de la sala */}
      <div
        className="glass-panel"
        style={{ position: 'absolute', top: 12, left: 12, zIndex: 1006, width: 270, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Sala online</div>
            <div style={{ fontSize: '1.3rem', fontWeight: 700, letterSpacing: '3px', color: '#fff' }}>{state.code}</div>
          </div>
          <button className="btn-secondary" onClick={copyInvite} title="Copiar enlace de invitación" style={{ padding: '6px 10px', fontSize: '0.75rem' }}>
            <Copy size={13} /> Invitar
          </button>
        </div>

        {(['p1', 'p2'] as Seat[]).map((seat) => {
          const p = state.players[seat];
          return (
            <div key={seat} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.8rem' }}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: p ? (p.connected ? 'var(--color-success)' : 'var(--color-danger)') : 'var(--text-muted)',
                  flexShrink: 0,
                }}
              />
              <span style={{ flex: 1, color: p ? '#fff' : 'var(--text-muted)' }}>
                {p ? p.name : 'Esperando rival…'}
                {seat === me ? ' (tú)' : ''}
                {p && !p.connected ? ' · desconectado' : ''}
              </span>
              {p && <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>{p.handCount} en mano</span>}
            </div>
          );
        })}

        <div style={{ height: 1, background: 'var(--glass-border)' }} />

        <label style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Tu mazo</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <select
            value={myInfo?.deckId || ''}
            onChange={(e) => send({ t: 'chooseDeck', deckId: e.target.value })}
            style={{
              flex: 1,
              background: 'rgba(0,0,0,0.35)',
              color: '#fff',
              border: '1px solid var(--glass-border)',
              borderRadius: 6,
              padding: '6px',
              fontSize: '0.8rem',
              fontFamily: 'var(--font-family)',
            }}
          >
            <option value="" disabled>
              {Object.keys(library.deckNames).length ? 'Elige un mazo…' : 'No hay mazos publicados'}
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
        </div>
        <button
          className="btn-primary"
          disabled={!myInfo?.deckId}
          onClick={() => {
            const doSpawn = () => send({ t: 'spawnDeck' });
            if (myDeckOnTable) confirm('Poner otro mazo', 'Ya tienes cartas en juego. ¿Quieres añadir otra copia completa de tu mazo a la mesa?', doSpawn);
            else doSpawn();
          }}
          style={{ padding: '8px', fontSize: '0.8rem', opacity: myInfo?.deckId ? 1 : 0.5 }}
        >
          <Layers size={14} /> Poner mi mazo barajado en la mesa
        </button>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn-secondary" onClick={() => send({ t: 'counterAdd' })} style={{ flex: 1, padding: '6px', fontSize: '0.75rem' }}>
            <UserPlus size={13} /> Contador
          </button>
          <button
            className="btn-danger"
            onClick={() =>
              confirm('Reiniciar mesa', 'Se retirarán todas las cartas de la mesa y de las dos manos, y los contadores volverán a 10. ¿Seguro?', () =>
                send({ t: 'reset' }),
              )
            }
            style={{ flex: 1, padding: '6px', fontSize: '0.75rem' }}
          >
            Reiniciar mesa
          </button>
        </div>
        <button className="btn-secondary" onClick={onLeave} style={{ padding: '6px', fontSize: '0.75rem' }}>
          <LogOut size={13} /> Salir al modo un jugador
        </button>
        <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
          R: robar · H: a la mano · F: voltear · Q/E: rotar · Z: barajar · Doble clic: coger montón
        </div>
      </div>

      {oppInfo && <OpponentHand name={oppInfo.name} cards={state.oppHand} backUrls={library.backs} />}

      {/* Barra de acciones de la selección */}
      {hasSelection && (
        <div
          className="glass-panel"
          style={{
            position: 'absolute',
            top: 112,
            left: '50%',
            transform: 'translateX(-50%)',
            padding: '10px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            zIndex: 1003,
            border: '1px solid rgba(255, 255, 255, 0.15)',
            boxShadow: '0 10px 30px rgba(0,0,0,0.6)',
            flexWrap: 'wrap',
            justifyContent: 'center',
            maxWidth: 'calc(100vw - 640px)',
          }}
        >
          <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)' }}>
            Selección:{' '}
            <span style={{ color: '#fff' }}>
              {selectedCardIds.size > 0 ? `${selectedCardIds.size} c.` : ''}
              {selectedCardIds.size > 0 && selectedCounterIds.size > 0 ? ' + ' : ''}
              {selectedCounterIds.size > 0 ? `${selectedCounterIds.size} cont.` : ''}
            </span>
          </div>
          {selectedCardIds.size > 0 && (
            <>
              <button className="btn-secondary" onClick={handleFlip} title="Voltear (F)" style={btn}>
                <Eye size={14} /> Voltear
              </button>
              <button className="btn-secondary" onClick={() => handleRotate(-90)} title="Rotar Izq. (Q)" style={btn}>
                <RotateCcw size={14} />
              </button>
              <button className="btn-secondary" onClick={() => handleRotate(90)} title="Rotar Der. (E)" style={btn}>
                <RotateCw size={14} />
              </button>
              {selectedCardIds.size > 1 && (
                <button className="btn-secondary" onClick={handleShuffle} title="Barajar (Z)" style={btn}>
                  <Shuffle size={14} /> Barajar
                </button>
              )}
              {selectedCardIds.size > 1 && (
                <button className="btn-secondary" onClick={handleDraw} title="Robar la carta de arriba (R)" style={btn}>
                  Robar 1
                </button>
              )}
              <button className="btn-secondary" onClick={handleToHand} title="Coger a la mano (H)" style={btn}>
                <Hand size={14} /> A la mano
              </button>
              {canPeek && (
                <button className="btn-secondary" onClick={handlePeek} title="Mirar en privado (el rival verá que lo haces)" style={btn}>
                  <Search size={14} /> Mirar
                </button>
              )}
            </>
          )}
          <div style={{ width: 1, height: 20, background: 'var(--glass-border)' }} />
          <button className="btn-danger" onClick={handleDelete} title="Retirar de la mesa (Supr)" style={btn}>
            <Trash2 size={14} />
          </button>
        </div>
      )}

      {/* Registro de la partida y chat */}
      <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 1006, width: showLog ? 290 : 'auto' }}>
        {showLog ? (
          <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', height: 'min(460px, calc(100vh - 260px))' }}>
            <div style={{ display: 'flex', alignItems: 'center', padding: '10px 12px', borderBottom: '1px solid var(--glass-border)', fontSize: '0.8rem', fontWeight: 600 }}>
              <MessageSquare size={14} style={{ marginRight: 6 }} />
              <span style={{ flex: 1 }}>Partida y chat</span>
              <button className="btn-secondary" onClick={() => setShowLog(false)} style={{ padding: 4 }} title="Ocultar">
                <X size={12} />
              </button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 5 }}>
              {state.log.map((entry) => (
                <div
                  key={entry.id}
                  style={{
                    fontSize: '0.75rem',
                    lineHeight: 1.35,
                    color: entry.kind === 'chat' ? '#fff' : entry.kind === 'reveal' ? 'var(--color-accent)' : 'var(--text-muted)',
                  }}
                >
                  <span style={{ opacity: 0.5, marginRight: 4 }}>
                    {new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
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
        ) : (
          <button className="btn-secondary glass-panel" onClick={() => setShowLog(true)} style={{ padding: '8px 12px', fontSize: '0.8rem', position: 'relative' }}>
            <MessageSquare size={14} /> Partida y chat
            {unread > 0 && (
              <span style={{ marginLeft: 6, background: 'var(--color-accent)', borderRadius: 10, padding: '0 6px', fontSize: '0.7rem', color: '#fff' }}>{unread}</span>
            )}
          </button>
        )}
      </div>

      <HandBar
        hand={state.hand}
        templateMap={templateMap}
        backUrls={library.backs}
        barRef={handBarRef}
        isBoardDragging={isBoardDragging}
        playFaceUp={playFaceUp}
        onTogglePlayFaceUp={() => setPlayFaceUp((v) => !v)}
        onPlay={handlePlay}
        onReveal={(id) => send({ t: 'reveal', id })}
        onDraw={() => send({ t: 'draw', ids: [] })}
      />

      {status === 'reconnecting' && (
        <div
          className="glass-panel"
          style={{ position: 'absolute', top: '45%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 300000, padding: '14px 22px', fontSize: '0.9rem' }}
        >
          Conexión perdida. Reconectando…
        </div>
      )}

      {/* Mirar cartas propias boca abajo */}
      {peek && (
        <Overlay onClose={onClosePeek}>
          <h3 style={{ fontSize: '1.05rem', fontWeight: 700, marginBottom: 4 }}>Mirando {peek.length} {peek.length === 1 ? 'carta' : 'cartas'} (de arriba a abajo)</h3>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 14 }}>
            Solo tú las ves; tu rival sabe que las estás mirando. Puedes coger cualquiera a tu mano. Recuerda barajar después si corresponde.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, maxHeight: '60vh', overflowY: 'auto', justifyContent: 'center' }}>
            {peek.map((c) => {
              const t = templateMap.get(c.templateId);
              return (
                <div key={c.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                  {t?.imageUrl ? (
                    <img src={t.imageUrl} alt={c.name} style={{ width: 130, height: 206, objectFit: 'cover', borderRadius: 10 }} />
                  ) : (
                    <div style={{ width: 130, height: 206, borderRadius: 10, background: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem' }}>
                      {c.name}
                    </div>
                  )}
                  <button
                    className="btn-secondary"
                    style={{ padding: '4px 10px', fontSize: '0.72rem' }}
                    onClick={() => {
                      send({ t: 'toHand', ids: [c.id] });
                      onClosePeek();
                    }}
                  >
                    <Hand size={12} /> A mi mano
                  </button>
                </div>
              );
            })}
          </div>
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
      zIndex: 400000,
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
