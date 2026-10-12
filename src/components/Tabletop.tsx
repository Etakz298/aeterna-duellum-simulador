import React, { useRef, useState, useEffect } from 'react';
import type { BoardCard, LifeCounter as LifeCounterType, CardTemplate, Position } from '../types';
import { CardItem } from './CardItem';
import { LifeCounter } from './LifeCounter';

interface TabletopProps {
  cards: BoardCard[];
  counters: LifeCounterType[];
  templates: CardTemplate[];
  selectedCardIds: Set<string>;
  selectedCounterIds: Set<string>;
  shufflingCardIds: Set<string>;
  backUrls: Record<string, string>;
  onSelectItems: (cardIds: Set<string>, counterIds: Set<string>) => void;
  onClearSelection: () => void;
  onUpdateCardPositions: (updates: { id: string; x: number; y: number }[]) => void;
  onUpdateCounterPositions: (updates: { id: string; x: number; y: number }[]) => void;
  onUpdateCounterValue: (id: string, value: number) => void;
  onUpdateCounterLabel: (id: string, label: string) => void;
  onUpdateCardsZIndex: (ids: string[]) => void;
  onUpdateCountersZIndex: (ids: string[]) => void;
  onDoubleClickCard: (id: string) => void;
  // Actions
  onFlipSelected: () => void;
  onRotateSelected: (degrees: number) => void;
  onDeleteSelected: () => void;
  onShuffleSelected: () => void;
}

export const Tabletop: React.FC<TabletopProps> = ({
  cards,
  counters,
  templates,
  selectedCardIds,
  selectedCounterIds,
  shufflingCardIds,
  backUrls,
  onSelectItems,
  onClearSelection,
  onUpdateCardPositions,
  onUpdateCounterPositions,
  onUpdateCounterValue,
  onUpdateCounterLabel,
  onUpdateCardsZIndex,
  onUpdateCountersZIndex,
  onDoubleClickCard,
  onFlipSelected,
  onRotateSelected,
  onDeleteSelected,
  onShuffleSelected,
}) => {
  const tabletopRef = useRef<HTMLDivElement>(null);

  // Navigation state (Pan & Zoom)
  const [zoom, setZoom] = useState<number>(1);
  const [pan, setPan] = useState<Position>({ x: 0, y: 0 });

  // Panning & Dragging States
  const [isPanning, setIsPanning] = useState<boolean>(false);
  const [panStart, setPanStart] = useState<Position>({ x: 0, y: 0 });

  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [dragStartPointer, setDragStartPointer] = useState<Position>({ x: 0, y: 0 });
  const dragStartPositions = useRef<Record<string, { x: number; y: number; type: 'card' | 'counter' }>>({});

  // Marquee Selection States
  const [isMarquee, setIsMarquee] = useState<boolean>(false);
  const [marqueeStart, setMarqueeStart] = useState<Position>({ x: 0, y: 0 });
  const [marqueeCurrent, setMarqueeCurrent] = useState<Position>({ x: 0, y: 0 });

  // Create template map for quick access
  const templateMap = new Map(templates.map((t) => [t.id, t]));

  // Handle Zoom (Wheel event, zoom centering on cursor)
  useEffect(() => {
    const el = tabletopRef.current;
    if (!el) return;

    const handleWheelEvent = (e: WheelEvent) => {
      e.preventDefault();
      const zoomFactor = 1.08;
      const nextZoom = e.deltaY < 0 ? Math.min(zoom * zoomFactor, 3) : Math.max(zoom / zoomFactor, 0.25);

      const rect = el.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      // Board coordinates under mouse
      const boardMouseX = (mouseX - pan.x) / zoom;
      const boardMouseY = (mouseY - pan.y) / zoom;

      // New pan positions to keep the same point under mouse
      const nextPanX = mouseX - boardMouseX * nextZoom;
      const nextPanY = mouseY - boardMouseY * nextZoom;

      setZoom(nextZoom);
      setPan({ x: nextPanX, y: nextPanY });
    };

    el.addEventListener('wheel', handleWheelEvent, { passive: false });
    return () => el.removeEventListener('wheel', handleWheelEvent);
  }, [zoom, pan]);

  // Handle keyboard hotkeys
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger shortcuts if typing in input
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
        return;
      }

      const key = e.key.toLowerCase();
      if (key === 'f') {
        e.preventDefault();
        onFlipSelected();
      } else if (key === 'q') {
        e.preventDefault();
        onRotateSelected(-90);
      } else if (key === 'e') {
        e.preventDefault();
        onRotateSelected(90);
      } else if (key === 'delete' || key === 'backspace') {
        e.preventDefault();
        onDeleteSelected();
      } else if (key === 'z') {
        e.preventDefault();
        onShuffleSelected();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onFlipSelected, onRotateSelected, onDeleteSelected, onShuffleSelected]);

  // Pointer Down on background (felt)
  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return; // Only handle left click

    const rect = tabletopRef.current?.getBoundingClientRect();
    if (!rect) return;

    const clientX = e.clientX;
    const clientY = e.clientY;

    const target = e.target as HTMLElement;
    const isBackground =
      target.classList.contains('tabletop-grid') ||
      target.classList.contains('tabletop-felt') ||
      target.id === 'tabletop-board' ||
      target.classList.contains('tabletop-container');

    if (isBackground) {
      if (!e.ctrlKey && !e.shiftKey) {
        onClearSelection();
      }

      if (e.shiftKey) {
        // Selection marquee
        setIsMarquee(true);
        const boardX = (clientX - rect.left - pan.x) / zoom;
        const boardY = (clientY - rect.top - pan.y) / zoom;
        setMarqueeStart({ x: boardX, y: boardY });
        setMarqueeCurrent({ x: boardX, y: boardY });
      } else {
        // Board panning
        setIsPanning(true);
        setPanStart({ x: clientX - pan.x, y: clientY - pan.y });
      }
    }
  };

  // Pointer Down on cards or counters
  const handleItemPointerDown = (
    e: React.PointerEvent,
    id: string,
    type: 'card' | 'counter'
  ) => {
    if (e.button !== 0) return; // Only left click drag
    e.stopPropagation();

    const rect = tabletopRef.current?.getBoundingClientRect();
    if (!rect) return;

    const isSelected =
      type === 'card' ? selectedCardIds.has(id) : selectedCounterIds.has(id);

    const newSelectedCards = new Set(selectedCardIds);
    const newSelectedCounters = new Set(selectedCounterIds);

    // Adjust selection
    if (!isSelected) {
      if (!e.ctrlKey && !e.shiftKey) {
        newSelectedCards.clear();
        newSelectedCounters.clear();
      }
      if (type === 'card') {
        newSelectedCards.add(id);
      } else {
        newSelectedCounters.add(id);
      }
      onSelectItems(newSelectedCards, newSelectedCounters);
    }

    // Start drag behavior
    setIsDragging(true);
    setDragStartPointer({ x: e.clientX, y: e.clientY });

    // Store positions for dragged elements
    const initialPositions: Record<string, { x: number; y: number; type: 'card' | 'counter' }> = {};
    const activeCards =
      !isSelected && !e.ctrlKey && !e.shiftKey ? [id] : Array.from(newSelectedCards);
    const activeCounters =
      !isSelected && !e.ctrlKey && !e.shiftKey ? [id] : Array.from(newSelectedCounters);

    const cardsToUpdateZIndex: string[] = [];
    cards.forEach((c) => {
      if (activeCards.includes(c.id) || (c.id === id && type === 'card')) {
        initialPositions[c.id] = { x: c.x, y: c.y, type: 'card' };
        cardsToUpdateZIndex.push(c.id);
      }
    });
    if (cardsToUpdateZIndex.length > 0) {
      onUpdateCardsZIndex(cardsToUpdateZIndex);
    }

    const countersToUpdateZIndex: string[] = [];
    counters.forEach((c) => {
      if (activeCounters.includes(c.id) || (c.id === id && type === 'counter')) {
        initialPositions[c.id] = { x: c.x, y: c.y, type: 'counter' };
        countersToUpdateZIndex.push(c.id);
      }
    });
    if (countersToUpdateZIndex.length > 0) {
      onUpdateCountersZIndex(countersToUpdateZIndex);
    }

    dragStartPositions.current = initialPositions;
  };

  // Drag / Pan / Marquee move
  const handlePointerMove = (e: React.PointerEvent) => {
    const rect = tabletopRef.current?.getBoundingClientRect();
    if (!rect) return;

    if (isPanning) {
      setPan({
        x: e.clientX - panStart.x,
        y: e.clientY - panStart.y,
      });
    } else if (isDragging) {
      // Divide by zoom so items drag exactly with mouse pointer speed
      const dx = (e.clientX - dragStartPointer.x) / zoom;
      const dy = (e.clientY - dragStartPointer.y) / zoom;

      const cardUpdates: { id: string; x: number; y: number }[] = [];
      const counterUpdates: { id: string; x: number; y: number }[] = [];

      Object.entries(dragStartPositions.current).forEach(([itemId, initialPos]) => {
        const newX = initialPos.x + dx;
        const newY = initialPos.y + dy;
        if (initialPos.type === 'card') {
          cardUpdates.push({ id: itemId, x: newX, y: newY });
        } else {
          counterUpdates.push({ id: itemId, x: newX, y: newY });
        }
      });

      if (cardUpdates.length > 0) onUpdateCardPositions(cardUpdates);
      if (counterUpdates.length > 0) onUpdateCounterPositions(counterUpdates);
    } else if (isMarquee) {
      const boardX = (e.clientX - rect.left - pan.x) / zoom;
      const boardY = (e.clientY - rect.top - pan.y) / zoom;
      setMarqueeCurrent({ x: boardX, y: boardY });

      const left = Math.min(marqueeStart.x, boardX);
      const top = Math.min(marqueeStart.y, boardY);
      const right = Math.max(marqueeStart.x, boardX);
      const bottom = Math.max(marqueeStart.y, boardY);

      const newSelectedCards = new Set<string>();
      const newSelectedCounters = new Set<string>();

      // AABB Intersections
      cards.forEach((c) => {
        const cLeft = c.x;
        const cRight = c.x + 140;
        const cTop = c.y;
        const cBottom = c.y + 200;

        if (cLeft < right && cRight > left && cTop < bottom && cBottom > top) {
          newSelectedCards.add(c.id);
        }
      });

      counters.forEach((c) => {
        const cLeft = c.x;
        const cRight = c.x + 140;
        const cTop = c.y;
        const cBottom = c.y + 140;

        if (cLeft < right && cRight > left && cTop < bottom && cBottom > top) {
          newSelectedCounters.add(c.id);
        }
      });

      onSelectItems(newSelectedCards, newSelectedCounters);
    }
  };

  const handlePointerUp = () => {
    if (isDragging) {
      const draggedCardIds = Array.from(selectedCardIds);
      if (draggedCardIds.length > 0) {
        const primaryId = draggedCardIds[0];
        const primaryCard = cards.find((c) => c.id === primaryId);

        if (primaryCard) {
          let closestCard: BoardCard | null = null;
          let minDistance = 25; // Snapping radius threshold (25px)

          cards.forEach((other) => {
            if (selectedCardIds.has(other.id)) return; // skip currently dragged cards

            const dist = Math.sqrt(
              Math.pow(primaryCard.x - other.x, 2) + Math.pow(primaryCard.y - other.y, 2)
            );

            if (dist < minDistance) {
              minDistance = dist;
              closestCard = other;
            }
          });

          if (closestCard) {
            const snapX = (closestCard as BoardCard).x;
            const snapY = (closestCard as BoardCard).y;

            const snappedUpdates = draggedCardIds.map((id) => ({
              id,
              x: snapX,
              y: snapY,
            }));

            onUpdateCardPositions(snappedUpdates);
          }
        }
      }
    }

    setIsPanning(false);
    setIsDragging(false);
    setIsMarquee(false);
  };

  // Reset viewport helper
  const handleResetViewport = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  return (
    <div
      ref={tabletopRef}
      className="tabletop-container"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      style={{ touchAction: 'none' }}
    >
      {/* Top Floating Viewport Control */}
      <div
        className="glass-panel"
        style={{
          position: 'absolute',
          bottom: '24px',
          right: '24px',
          padding: '8px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          fontSize: '0.85rem',
          zIndex: 1000,
          pointerEvents: 'auto',
        }}
      >
        <span>Zoom: {Math.round(zoom * 100)}%</span>
        <button className="btn-secondary" onClick={handleResetViewport} style={{ padding: '4px 8px', fontSize: '0.75rem' }}>
          Centrar
        </button>
      </div>

      {/* Felt Texture and Infinite Grid Background */}
      <div
        className="tabletop-grid"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundPosition: `${pan.x}px ${pan.y}px`,
          backgroundSize: `${50 * zoom}px ${50 * zoom}px`,
          pointerEvents: 'none',
        }}
      />
      <div
        className="tabletop-texture"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          pointerEvents: 'none',
        }}
      />

      {/* Infinite board area that handles zoom & pan */}
      <div
        id="tabletop-board"
        className="tabletop-board-area"
        style={{
          width: '5000px',
          height: '5000px',
          position: 'absolute',
          top: 0,
          left: 0,
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: '0 0',
        }}
      >

        {/* Board Cards */}
        {(() => {
          // Calculate stacks and find top card of each stack
          const stackCounts: Record<string, number> = {};
          const topCardOfStack: Record<string, string> = {};
          const maxZIndexMap: Record<string, number> = {};

          cards.forEach((c) => {
            const key = `${c.x},${c.y}`;
            stackCounts[key] = (stackCounts[key] || 0) + 1;

            if (maxZIndexMap[key] === undefined || c.zIndex > maxZIndexMap[key]) {
              maxZIndexMap[key] = c.zIndex;
              topCardOfStack[key] = c.id;
            }
          });

          return cards.map((card) => {
            const template = templateMap.get(card.templateId);
            const key = `${card.x},${card.y}`;
            const totalInStack = stackCounts[key] || 0;
            const isTop = topCardOfStack[key] === card.id;
            const stackCount = isTop && totalInStack > 1 ? totalInStack : undefined;

            const backAUrl = backUrls[`backA-${template?.deckId}`];
            const backBUrl = backUrls[`backB-${template?.deckId}`];

            return (
              <CardItem
                key={card.id}
                card={card}
                template={template!}
                isSelected={selectedCardIds.has(card.id)}
                isDragging={isDragging && selectedCardIds.has(card.id)}
                isSingleSelected={selectedCardIds.size === 1}
                isShuffling={shufflingCardIds.has(card.id)}
                backAUrl={backAUrl}
                backBUrl={backBUrl}
                stackCount={stackCount}
                isTop={isTop}
                onPointerDown={handleItemPointerDown}
                onDoubleClick={onDoubleClickCard}
              />
            );
          });
        })()}

        {/* Life Counters */}
        {counters.map((counter) => (
          <LifeCounter
            key={counter.id}
            counter={counter}
            isSelected={selectedCounterIds.has(counter.id)}
            onUpdateValue={onUpdateCounterValue}
            onUpdateLabel={onUpdateCounterLabel}
            onPointerDown={handleItemPointerDown}
          />
        ))}

        {/* Marquee Selection Visual Representation */}
        {isMarquee && (
          <div
            className="selection-marquee"
            style={{
              left: `${Math.min(marqueeStart.x, marqueeCurrent.x)}px`,
              top: `${Math.min(marqueeStart.y, marqueeCurrent.y)}px`,
              width: `${Math.abs(marqueeCurrent.x - marqueeStart.x)}px`,
              height: `${Math.abs(marqueeCurrent.y - marqueeStart.y)}px`,
            }}
          />
        )}
      </div>
    </div>
  );
};
