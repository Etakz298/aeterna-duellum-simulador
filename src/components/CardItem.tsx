import React from 'react';
import type { BoardCard, CardTemplate } from '../types';

interface CardItemProps {
  card: BoardCard;
  template: CardTemplate;
  isSelected: boolean;
  isDragging: boolean;
  isSingleSelected?: boolean;
  isShuffling?: boolean;
  backAUrl?: string;
  backBUrl?: string;
  stackCount?: number;
  isTop?: boolean; // True if card is the top-most visible card of its stack (or single)
  onPointerDown: (e: React.PointerEvent, id: string, type: 'card' | 'counter') => void;
  onDoubleClick: (id: string) => void;
}

export const CardItem: React.FC<CardItemProps> = ({
  card,
  template,
  isSelected,
  isDragging,
  isSingleSelected = false,
  isShuffling = false,
  backAUrl,
  backBUrl,
  stackCount,
  isTop = true,
  onPointerDown,
  onDoubleClick,
}) => {
  const imageUrl = template ? template.imageUrl : '';
  const backUrl = template?.backType === 'backB' ? backBUrl : backAUrl;

  const showSelectionVisual = isSelected && isTop;
  const showDraggingVisual = isDragging && isTop;

  return (
    <div
      className={`card-wrapper ${showSelectionVisual ? 'selected' : ''} ${showDraggingVisual ? 'dragging' : ''} ${
        showSelectionVisual && isSingleSelected ? 'single-selected' : ''
      } ${!isTop ? 'stacked-under' : ''}`}
      style={{
        transform: `translate(${card.x}px, ${card.y}px)${isDragging ? ' scale(1.04)' : ''}`,
        zIndex: card.zIndex + (stackCount !== undefined ? 5000 : 0) + (isDragging ? 20000 : 0),
      }}
      onPointerDown={(e) => onPointerDown(e, card.id, 'card')}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onDoubleClick(card.id);
      }}
    >
      <div className={`card-shuffle-wrapper ${isShuffling ? 'animate-shuffle' : ''}`}>
        <div className="card-rotation-wrapper" style={{ transform: `rotate(${card.rotation}deg)` }}>
          <div className={`card-container ${card.isFaceUp ? '' : 'flipped-state'}`}>
            {/* Card Front */}
            <div className="card-face card-front">
              {imageUrl ? (
                <img src={imageUrl} alt={template?.name || 'Card Front'} />
              ) : (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: '100%',
                    color: 'var(--text-muted)',
                    fontSize: '0.8rem',
                    padding: '12px',
                    textAlign: 'center',
                    background: '#0f172a',
                  }}
                >
                  {template?.name || 'Sin Imagen'}
                </div>
              )}
            </div>

            {/* Card Back */}
            <div className="card-face card-back">
              {backUrl ? (
                <img
                  src={backUrl}
                  alt="Reverso de Carta"
                  style={{ width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }}
                />
              ) : (
                <div className="card-back-pattern">
                  <span className="card-back-logo">AD</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Floating stack count badge */}
      {stackCount !== undefined && (
        <div
          style={{
            position: 'absolute',
            bottom: '-28px',
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'var(--glass-bg)',
            border: '1px solid var(--color-accent)',
            borderRadius: '20px',
            padding: '2px 10px',
            fontSize: '0.75rem',
            fontWeight: 'bold',
            color: '#fff',
            boxShadow: '0 4px 10px rgba(0,0,0,0.5)',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
            zIndex: 10000,
          }}
        >
          {stackCount} cartas
        </div>
      )}
    </div>
  );
};
