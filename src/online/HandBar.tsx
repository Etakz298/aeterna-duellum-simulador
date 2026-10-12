import React, { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Hand } from 'lucide-react';
import type { CardTemplate } from '../types';
import type { OnlineHandCard, OpponentHandCard } from './types';

const HAND_W = 100;
const HAND_H = 158;

interface HandBarProps {
  hand: OnlineHandCard[];
  templateMap: Map<string, CardTemplate>;
  backUrls: Record<string, string>;
  barRef: React.RefObject<HTMLDivElement | null>;
  isBoardDragging: boolean;
  playFaceUp: boolean;
  onTogglePlayFaceUp: () => void;
  onPlay: (id: string, clientX: number, clientY: number, faceUp: boolean) => void;
  onReveal: (id: string) => void;
  onDraw: () => void;
}

function CardBack({ url, width, height }: { url?: string; width: number; height: number }) {
  return url ? (
    <img src={url} alt="Reverso" draggable={false} style={{ width, height, objectFit: 'cover', borderRadius: 8, display: 'block' }} />
  ) : (
    <div className="card-back-pattern" style={{ width, height, borderRadius: 8 }}>
      <span className="card-back-logo" style={{ fontSize: Math.round(width / 4) }}>
        AD
      </span>
    </div>
  );
}

// Mano propia: solo este jugador recibe del servidor qué cartas son
export const HandBar: React.FC<HandBarProps> = ({
  hand,
  templateMap,
  backUrls,
  barRef,
  isBoardDragging,
  playFaceUp,
  onTogglePlayFaceUp,
  onPlay,
  onReveal,
  onDraw,
}) => {
  const [hover, setHover] = useState<{ id: string; rect: DOMRect } | null>(null);
  const hoverId = hover?.id ?? null;
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const dragInfo = useRef<{ id: string; startX: number; startY: number; moved: boolean } | null>(null);
  const playRef = useRef(onPlay);
  playRef.current = onPlay;
  const faceUpRef = useRef(playFaceUp);
  faceUpRef.current = playFaceUp;

  useEffect(() => {
    if (!drag) return;
    const handleMove = (e: PointerEvent) => {
      const info = dragInfo.current;
      if (!info) return;
      if (Math.hypot(e.clientX - info.startX, e.clientY - info.startY) > 6) info.moved = true;
      setDrag({ id: info.id, x: e.clientX, y: e.clientY });
    };
    const handleUp = (e: PointerEvent) => {
      const info = dragInfo.current;
      dragInfo.current = null;
      setDrag(null);
      if (!info || !info.moved) return;
      const rect = barRef.current?.getBoundingClientRect();
      const overHand = rect && e.clientY >= rect.top && e.clientX >= rect.left && e.clientX <= rect.right;
      if (overHand) return;
      // Mayús invierte la cara con la que se juega
      const faceUp = e.shiftKey ? !faceUpRef.current : faceUpRef.current;
      playRef.current(info.id, e.clientX, e.clientY, faceUp);
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };
  }, [drag !== null, barRef]); // eslint-disable-line react-hooks/exhaustive-deps

  const n = hand.length;
  // Solapar las cartas cuando no caben
  const maxWidth = Math.min(window.innerWidth * 0.62, 1000);
  const overlap = n > 1 ? Math.min(8, (maxWidth - HAND_W) / (n - 1) - HAND_W) : 8;

  const dragCard = drag ? hand.find((c) => c.id === drag.id) : undefined;
  const dragTemplate = dragCard ? templateMap.get(dragCard.templateId) : undefined;

  return (
    <>
      <div
        ref={barRef}
        className="glass-panel"
        style={{
          position: 'absolute',
          left: '50%',
          bottom: 12,
          transform: 'translateX(-50%)',
          zIndex: 1005,
          padding: '8px 16px 12px',
          minWidth: 360,
          maxWidth: '72vw',
          border: isBoardDragging ? '1px dashed var(--color-accent)' : '1px solid var(--glass-border)',
          boxShadow: isBoardDragging ? '0 0 24px var(--color-accent-glow)' : 'var(--glass-shadow)',
          pointerEvents: isBoardDragging ? 'none' : 'auto',
          transition: 'border-color 0.2s, box-shadow 0.2s',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, fontSize: '0.78rem', color: 'var(--text-muted)' }}>
          <Hand size={14} />
          <span style={{ fontWeight: 600, color: '#fff' }}>Tu mano ({n})</span>
          <span style={{ flex: 1 }}>
            {isBoardDragging ? 'Suelta aquí para coger las cartas' : 'Solo tú ves estas cartas. Arrástralas a la mesa para jugarlas.'}
          </span>
          <button
            className="btn-secondary"
            onClick={onTogglePlayFaceUp}
            title="Cara con la que se juegan las cartas al soltarlas (Mayús la invierte)"
            style={{ padding: '3px 8px', fontSize: '0.72rem' }}
          >
            {playFaceUp ? <Eye size={12} /> : <EyeOff size={12} />} {playFaceUp ? 'Jugar boca arriba' : 'Jugar boca abajo'}
          </button>
          <button className="btn-primary" onClick={onDraw} title="Robar de tu mazo (R)" style={{ padding: '3px 10px', fontSize: '0.72rem' }}>
            Robar
          </button>
        </div>

        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'flex-end', height: HAND_H, minWidth: HAND_W }}>
          {n === 0 && (
            <div style={{ alignSelf: 'center', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
              Tu mano está vacía. Pulsa Robar o arrastra cartas de la mesa hasta aquí.
            </div>
          )}
          {hand.map((card, i) => {
            const template = templateMap.get(card.templateId);
            const isHover = hoverId === card.id && !drag;
            const isDragged = drag?.id === card.id;
            return (
              <div
                key={card.id}
                onPointerEnter={(e) => setHover({ id: card.id, rect: e.currentTarget.getBoundingClientRect() })}
                onPointerLeave={() => setHover((h) => (h?.id === card.id ? null : h))}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  e.preventDefault();
                  dragInfo.current = { id: card.id, startX: e.clientX, startY: e.clientY, moved: false };
                  setDrag({ id: card.id, x: e.clientX, y: e.clientY });
                }}
                style={{
                  position: 'relative',
                  width: HAND_W,
                  height: HAND_H,
                  marginLeft: i === 0 ? 0 : overlap,
                  flexShrink: 0,
                  cursor: 'grab',
                  zIndex: isHover ? 100 : i,
                  opacity: isDragged ? 0.35 : 1,
                  transform: isHover ? 'translateY(-10px)' : 'none',
                  transition: 'transform 0.12s ease-out',
                  touchAction: 'none',
                }}
              >
                {template?.imageUrl ? (
                  <img
                    src={template.imageUrl}
                    alt={template.name}
                    draggable={false}
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      borderRadius: 8,
                      boxShadow: '0 6px 16px rgba(0,0,0,0.6)',
                      border: '1px solid rgba(255,255,255,0.15)',
                      display: 'block',
                    }}
                  />
                ) : (
                  <div style={{ width: '100%', height: '100%', borderRadius: 8, background: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.7rem', textAlign: 'center', padding: 6 }}>
                    {template?.name || 'Carta'}
                  </div>
                )}
                {isHover && (
                  <button
                    className="btn-secondary"
                    title="Enseñar esta carta al rival sin jugarla"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => onReveal(card.id)}
                    style={{
                      position: 'absolute',
                      top: 4,
                      right: 4,
                      padding: '2px 6px',
                      fontSize: '0.65rem',
                      background: 'rgba(10,14,22,0.85)',
                    }}
                  >
                    <Eye size={11} /> Enseñar
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {hover && !drag && (() => {
        const card = hand.find((c) => c.id === hover.id);
        const template = card ? templateMap.get(card.templateId) : undefined;
        if (!template?.imageUrl) return null;
        const w = 260;
        const h = Math.round((w * 206) / 130);
        const left = Math.max(8, Math.min(window.innerWidth - w - 8, hover.rect.left + hover.rect.width / 2 - w / 2));
        const top = Math.max(8, hover.rect.top - h - 24);
        return (
          <img
            src={template.imageUrl}
            alt={template.name}
            style={{
              position: 'fixed',
              left,
              top,
              width: w,
              height: h,
              objectFit: 'cover',
              borderRadius: 14,
              boxShadow: '0 20px 50px rgba(0,0,0,0.7)',
              pointerEvents: 'none',
              zIndex: 200000,
            }}
          />
        );
      })()}

      {drag && dragCard && dragInfo.current?.moved && (
        <div
          style={{
            position: 'fixed',
            left: drag.x - 65,
            top: drag.y - 103,
            width: 130,
            height: 206,
            pointerEvents: 'none',
            zIndex: 200000,
            opacity: 0.9,
            transform: 'rotate(-3deg)',
            filter: 'drop-shadow(0 12px 24px rgba(0,0,0,0.6))',
          }}
        >
          {playFaceUp && dragTemplate?.imageUrl ? (
            <img src={dragTemplate.imageUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 12 }} />
          ) : (
            <CardBack
              url={backUrls[`${dragCard.backType}-${dragCard.deckId}`]}
              width={130}
              height={206}
            />
          )}
        </div>
      )}
    </>
  );
};

// Mano del rival: solo se ven los reversos y el número de cartas
export const OpponentHand: React.FC<{ name: string; cards: OpponentHandCard[]; backUrls: Record<string, string> }> = ({
  name,
  cards,
  backUrls,
}) => {
  const n = cards.length;
  const overlap = n > 1 ? Math.min(4, (360 - 44) / (n - 1) - 44) : 4;
  return (
    <div
      className="glass-panel"
      style={{
        position: 'absolute',
        top: 12,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 1004,
        padding: '6px 14px 8px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
        pointerEvents: 'none',
      }}
    >
      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
        Mano de <strong style={{ color: '#fff' }}>{name}</strong>: {n} {n === 1 ? 'carta' : 'cartas'}
      </div>
      <div style={{ display: 'flex', height: 70, alignItems: 'center' }}>
        {n === 0 && <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Sin cartas</span>}
        {cards.map((c, i) => (
          <div key={i} style={{ marginLeft: i === 0 ? 0 : overlap, boxShadow: '0 3px 8px rgba(0,0,0,0.5)', borderRadius: 8 }}>
            <CardBack url={backUrls[`${c.backType}-${c.deckId}`]} width={44} height={70} />
          </div>
        ))}
      </div>
    </div>
  );
};
