import React, { useState } from 'react';
import type { LifeCounter as LifeCounterType } from '../types';
import { Plus, Minus } from 'lucide-react';

interface LifeCounterProps {
  counter: LifeCounterType;
  isSelected: boolean;
  onUpdateValue: (id: string, value: number) => void;
  onUpdateLabel: (id: string, label: string) => void;
  onPointerDown: (e: React.PointerEvent, id: string, type: 'card' | 'counter') => void;
}

export const LifeCounter: React.FC<LifeCounterProps> = ({
  counter,
  isSelected,
  onUpdateValue,
  onUpdateLabel,
  onPointerDown,
}) => {
  const [isEditingLabel, setIsEditingLabel] = useState(false);

  const handleDecrement = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (counter.value > 0) {
      onUpdateValue(counter.id, counter.value - 1);
    }
  };

  const handleIncrement = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (counter.value < 10) {
      onUpdateValue(counter.id, counter.value + 1);
    }
  };

  const handleLabelChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onUpdateLabel(counter.id, e.target.value);
  };

  const handleLabelKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      setIsEditingLabel(false);
    }
  };

  return (
    <div
      className={`life-counter-token ${isSelected ? 'selected' : ''}`}
      style={{
        transform: `translate(${counter.x}px, ${counter.y}px)`,
        zIndex: counter.zIndex,
      }}
      onPointerDown={(e) => onPointerDown(e, counter.id, 'counter')}
    >
      {/* Label (Click to edit) */}
      {isEditingLabel ? (
        <input
          type="text"
          value={counter.label}
          onChange={handleLabelChange}
          onBlur={() => setIsEditingLabel(false)}
          onKeyDown={handleLabelKeyDown}
          onPointerDown={(e) => e.stopPropagation()}
          className="life-counter-label-input"
          autoFocus
          maxLength={12}
          style={{
            background: 'rgba(0,0,0,0.4)',
            border: '1px solid var(--color-primary)',
            borderRadius: '4px',
            color: '#fff',
            fontSize: '0.75rem',
            textAlign: 'center',
            width: '90px',
            outline: 'none',
            padding: '2px',
            fontFamily: 'var(--font-family)',
          }}
        />
      ) : (
        <span
          className="life-counter-label"
          title="Click para editar"
          onClick={(e) => {
            e.stopPropagation();
            setIsEditingLabel(true);
          }}
        >
          {counter.label || 'VIDA'}
        </span>
      )}

      {/* Value controls */}
      <div className="life-counter-display">
        <button
          className="life-counter-btn"
          onClick={handleDecrement}
          onPointerDown={(e) => e.stopPropagation()}
          disabled={counter.value <= 0}
          style={{ opacity: counter.value <= 0 ? 0.4 : 1 }}
        >
          <Minus size={14} />
        </button>

        <span className="life-counter-val">{counter.value}</span>

        <button
          className="life-counter-btn"
          onClick={handleIncrement}
          onPointerDown={(e) => e.stopPropagation()}
          disabled={counter.value >= 10}
          style={{ opacity: counter.value >= 10 ? 0.4 : 1 }}
        >
          <Plus size={14} />
        </button>
      </div>

      {/* Decorative Border Ring */}
      <div
        style={{
          position: 'absolute',
          top: '6px',
          left: '6px',
          right: '6px',
          bottom: '6px',
          border: '1px solid rgba(255,255,255,0.05)',
          borderRadius: '50%',
          pointerEvents: 'none',
        }}
      />
    </div>
  );
};
