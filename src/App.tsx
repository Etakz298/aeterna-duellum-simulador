import { useState, useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { Tabletop } from './components/Tabletop';
import type { BoardCard, LifeCounter, CardTemplate, CardBack } from './types';
import {
  getCardTemplates,
  saveCardTemplate,
  deleteCardTemplate,
  getCardBacks,
  saveCardBack,
  deleteCardBack,
} from './db';
import { RotateCw, RotateCcw, Eye, Shuffle, Trash2 } from 'lucide-react';

interface ModalState {
  isOpen: boolean;
  type: 'alert' | 'confirm';
  title: string;
  message: string;
  onConfirm?: () => void;
}

export default function App() {
  // Database Templates
  const [templates, setTemplates] = useState<CardTemplate[]>([]);

  // Deck names (renamable, stored in localStorage)
  const [deckNames, setDeckNames] = useState<Record<string, string>>({
    mazo1: 'Mazo Principal',
  });

  // Custom Modal Dialog State
  const [modal, setModal] = useState<ModalState>({
    isOpen: false,
    type: 'alert',
    title: '',
    message: '',
  });

  const showAlert = (title: string, message: string) => {
    setModal({
      isOpen: true,
      type: 'alert',
      title,
      message,
    });
  };

  const showConfirm = (title: string, message: string, onConfirm: () => void) => {
    setModal({
      isOpen: true,
      type: 'confirm',
      title,
      message,
      onConfirm,
    });
  };

  // Custom Card Back Object URLs
  const [backUrls, setBackUrls] = useState<Record<string, string>>({});

  // Board elements state
  const [cards, setCards] = useState<BoardCard[]>([]);
  const [counters, setCounters] = useState<LifeCounter[]>([]);

  // Selection states
  const [selectedCardIds, setSelectedCardIds] = useState<Set<string>>(new Set());
  const [selectedCounterIds, setSelectedCounterIds] = useState<Set<string>>(new Set());

  // Shuffling animation triggers
  const [shufflingCardIds, setShufflingCardIds] = useState<Set<string>>(new Set());

  // Stacking zIndex tracker
  const [nextZIndex, setNextZIndex] = useState<number>(10);

  // Sidebar visibility state
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(true);

  // Check if running inside Electron wrapper
  const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

  // Save deck names helper
  const saveDeckNamesState = (updated: Record<string, string>) => {
    setDeckNames(updated);
    if (isElectron) {
      window.electronAPI!.saveDeckNames(updated);
    } else {
      localStorage.setItem('sim_deck_names', JSON.stringify(updated));
    }
  };

  // Load templates, backs, deck names and tabletop state on mount
  useEffect(() => {
    const loadAllData = async () => {
      try {
        if (isElectron) {
          // Electron FileSystem flow
          const db = await window.electronAPI!.loadDatabase();

          // 1. Load templates
          const templatesWithUrls = (db.templates || []).map((t) => ({
            ...t,
            imageUrl: t.imageUrl
          }));
          setTemplates(templatesWithUrls);

          // 2. Load custom backs
          const urls: Record<string, string> = {};
          (db.backs || []).forEach((back) => {
            urls[back.id] = back.imageUrl || '';
          });
          setBackUrls(urls);

          // 3. Load deck names
          if (db.deckNames) {
            setDeckNames(db.deckNames);
          }

          // 4. Load board state (Persists position on reopen)
          if (db.boardState) {
            setCards(db.boardState.cards || []);
            setCounters(db.boardState.counters || []);
            setNextZIndex(db.boardState.nextZIndex || 10);
          }
        } else {
          // Standard browser IndexedDB flow
          // 1. Load card designs templates
          const loadedTemplates = await getCardTemplates();
          const templatesWithUrls = loadedTemplates.map((t) => ({
            ...t,
            imageUrl: t.imageBlob ? URL.createObjectURL(t.imageBlob) : undefined,
          }));
          setTemplates(templatesWithUrls);

          // 2. Load custom card backs
          const loadedBacks = await getCardBacks();
          const urls: Record<string, string> = {};
          loadedBacks.forEach((back) => {
            if (back.imageBlob) {
              urls[back.id] = URL.createObjectURL(back.imageBlob);
            }
          });
          setBackUrls(urls);

          // 3. Load deck names
          const storedDeckNames = localStorage.getItem('sim_deck_names');
          if (storedDeckNames) {
            try {
              setDeckNames(JSON.parse(storedDeckNames));
            } catch (e) {
              console.error(e);
            }
          }

          // 4. Load board state
          const storedCards = localStorage.getItem('sim_cards');
          const storedCounters = localStorage.getItem('sim_counters');

          if (storedCards) {
            try {
              const parsedCards = JSON.parse(storedCards) as BoardCard[];
              setCards(parsedCards);
              const maxZ = parsedCards.reduce((max, c) => Math.max(max, c.zIndex), 0);
              setNextZIndex((prev) => Math.max(prev, maxZ + 1));
            } catch (e) {
              console.error(e);
            }
          }
          if (storedCounters) {
            try {
              const parsedCounters = JSON.parse(storedCounters) as LifeCounter[];
              setCounters(parsedCounters);
              const maxZ = parsedCounters.reduce((max, c) => Math.max(max, c.zIndex), 0);
              setNextZIndex((prev) => Math.max(prev, maxZ + 1));
            } catch (e) {
              console.error(e);
            }
          }
        }
      } catch (err) {
        console.error('Error loading initial data:', err);
      }
    };
    loadAllData();
  }, []);

  // Save board status to LocalStorage or Electron JSON db on changes
  useEffect(() => {
    if (isElectron) {
      window.electronAPI!.saveBoardState(cards, counters, nextZIndex);
    } else {
      localStorage.setItem('sim_cards', JSON.stringify(cards));
    }
  }, [cards, isElectron, nextZIndex, counters]);

  useEffect(() => {
    if (isElectron) {
      window.electronAPI!.saveBoardState(cards, counters, nextZIndex);
    } else {
      localStorage.setItem('sim_counters', JSON.stringify(counters));
    }
  }, [counters, isElectron, nextZIndex, cards]);

  // Rename Decks
  const handleUpdateDeckName = (id: string, name: string) => {
    const updated = { ...deckNames, [id]: name };
    saveDeckNamesState(updated);
  };

  // Create a new empty deck
  const handleCreateDeck = () => {
    const newId = `deck-${Date.now()}`;
    const existingNames = Object.values(deckNames);
    let newName = 'Nuevo Mazo';
    let counter = 1;
    while (existingNames.includes(newName)) {
      newName = `Nuevo Mazo ${counter}`;
      counter++;
    }
    const updated = { ...deckNames, [newId]: newName };
    saveDeckNamesState(updated);
  };

  // Delete a deck and all its templates and board instances (using custom modal confirmation)
  const handleDeleteDeck = async (deckId: string) => {
    const deckName = deckNames[deckId] || deckId;
    showConfirm(
      'Eliminar Mazo',
      `¿Estás seguro de que quieres eliminar el mazo "${deckName}"? Se borrarán permanentemente todos sus diseños de la biblioteca y de la mesa.`,
      async () => {
        // 1. Delete all card templates of this deck from IndexedDB
        const templatesToDelete = templates.filter((t) => t.deckId === deckId);
        for (const t of templatesToDelete) {
          await deleteCardTemplate(t.id);
          if (t.imageUrl) URL.revokeObjectURL(t.imageUrl);
        }

        // 2. Remove all board cards of these templates from the tabletop
        const deleteTemplateIds = new Set(templatesToDelete.map((t) => t.id));
        setCards((prev) => prev.filter((c) => !deleteTemplateIds.has(c.templateId)));

        // 3. Update templates state
        setTemplates((prev) => prev.filter((t) => t.deckId !== deckId));

        // 4. Delete the deck name from local storage & state
        const updated = { ...deckNames };
        delete updated[deckId];

        // Guarantee there is at least one fallback deck
        if (Object.keys(updated).length === 0) {
          updated['mazo1'] = 'Mazo Principal';
        }

        saveDeckNamesState(updated);
      }
    );
  };

  // Upload Custom Back per Deck
  const handleUploadBack = async (deckId: string, type: 'backA' | 'backB', blob: Blob) => {
    const id = `${type}-${deckId}`;
    const back: CardBack = { id, imageBlob: blob };
    await saveCardBack(back);

    // Revoke previous URL if exists
    if (backUrls[id]) URL.revokeObjectURL(backUrls[id]);

    // Create new ObjectURL
    const url = URL.createObjectURL(blob);
    setBackUrls((prev) => ({ ...prev, [id]: url }));
  };

  // Delete Custom Back per Deck
  const handleDeleteBack = async (deckId: string, type: 'backA' | 'backB') => {
    const id = `${type}-${deckId}`;
    await deleteCardBack(id);
    if (backUrls[id]) URL.revokeObjectURL(backUrls[id]);
    setBackUrls((prev) => {
      const copy = { ...prev };
      delete copy[id];
      return copy;
    });
  };

  // Add Batch Templates (Conjuntos de imágenes)
  const handleAddTemplates = async (
    templatesData: { name: string; blob: Blob; deckId: string; backType: 'backA' | 'backB'; quantity?: number }[]
  ) => {
    const newTemplates: CardTemplate[] = [];

    for (const item of templatesData) {
      const template: CardTemplate = {
        id: `template-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        name: item.name,
        imageBlob: item.blob,
        deckId: item.deckId,
        backType: item.backType,
        quantity: item.quantity || 1, // Default to parsed quantity or 1
        createdAt: Date.now(),
      };

      await saveCardTemplate(template);

      // Create local Object URL
      template.imageUrl = URL.createObjectURL(item.blob);
      newTemplates.push(template);
    }

    setTemplates((prev) => [...prev, ...newTemplates]);
  };

  // Delete Template from Library (using custom modal confirmation)
  const handleDeleteTemplate = async (id: string) => {
    showConfirm(
      'Eliminar Diseño',
      '¿Estás seguro de que quieres eliminar este diseño? Se borrarán todas las copias en la mesa de juego.',
      async () => {
        await deleteCardTemplate(id);

        // Revoke ObjectURL to release memory
        const template = templates.find((t) => t.id === id);
        if (template?.imageUrl) {
          URL.revokeObjectURL(template.imageUrl);
        }

        setTemplates((prev) => prev.filter((t) => t.id !== id));
        setCards((prev) => prev.filter((c) => c.templateId !== id));

        // Clear selection for deleted cards
        setSelectedCardIds((prev) => {
          const next = new Set(prev);
          cards.forEach((c) => {
            if (c.templateId === id) next.delete(c.id);
          });
          return next;
        });
      }
    );
  };

  // Update template deck in library
  const handleUpdateTemplateDeck = async (id: string, deckId: string) => {
    setTemplates((prev) =>
      prev.map((t) => {
        if (t.id === id) {
          const updated = { ...t, deckId };
          saveCardTemplate(updated); // Sync back to IndexedDB
          return updated;
        }
        return t;
      })
    );
  };

  // Update template backType in library
  const handleUpdateTemplateBackType = async (id: string, backType: 'backA' | 'backB') => {
    setTemplates((prev) =>
      prev.map((t) => {
        if (t.id === id) {
          const updated = { ...t, backType };
          saveCardTemplate(updated); // Sync back to IndexedDB
          return updated;
        }
        return t;
      })
    );
  };

  // Update template quantity (number of copies in library)
  const handleUpdateTemplateQuantity = async (id: string, quantity: number) => {
    setTemplates((prev) =>
      prev.map((t) => {
        if (t.id === id) {
          const updated = { ...t, quantity: Math.max(1, quantity) };
          saveCardTemplate(updated); // Sync back to IndexedDB
          return updated;
        }
        return t;
      })
    );
  };

  // Add card copies to board tabletop
  const handleAddCardsToBoard = (templateId: string, count: number) => {
    let startZ = nextZIndex;
    const newCards: BoardCard[] = [];

    // Spawn near center with overlapping layout
    const startX = 450 + Math.random() * 50;
    const startY = 250 + Math.random() * 50;

    for (let i = 0; i < count; i++) {
      startZ++;
      newCards.push({
        id: `card-${Date.now()}-${i}-${Math.random().toString(36).substr(2, 5)}`,
        templateId,
        x: startX + i * 16,
        y: startY + i * 16,
        isFaceUp: true,
        rotation: 0,
        zIndex: startZ,
      });
    }

    setNextZIndex(startZ + 1);
    setCards((prev) => [...prev, ...newCards]);
  };

  // Add all cards of a deck to the board (stacked at one point)
  const handleAddDeckToBoard = (deckId: string) => {
    const deckTemplates = templates.filter((t) => t.deckId === deckId);
    if (deckTemplates.length === 0) return;

    let startZ = nextZIndex;
    const newCards: BoardCard[] = [];

    const spawnX = 450 + Math.random() * 20;
    const spawnY = 250 + Math.random() * 20;

    deckTemplates.forEach((template) => {
      const quantity = template.quantity || 1;
      for (let i = 0; i < quantity; i++) {
        startZ++;
        newCards.push({
          id: `card-${Date.now()}-${i}-${Math.random().toString(36).substr(2, 5)}`,
          templateId: template.id,
          x: spawnX,
          y: spawnY,
          isFaceUp: false, // Stacked decks are face down by default
          rotation: 0,
          zIndex: startZ,
        });
      }
    });

    setNextZIndex(startZ + 1);
    setCards((prev) => [...prev, ...newCards]);
  };

  // Spawns a new life counter
  const handleAddCounter = () => {
    const startZ = nextZIndex + 1;
    setNextZIndex(startZ);

    const newCounter: LifeCounter = {
      id: `counter-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      x: 350 + Math.random() * 100,
      y: 200 + Math.random() * 100,
      value: 10,
      label: 'VIDA',
      zIndex: startZ,
    };

    setCounters((prev) => [...prev, newCounter]);
  };

  // Clear board (using custom modal confirmation)
  const handleClearBoard = () => {
    showConfirm(
      'Limpiar Mesa',
      '¿Estás seguro de que quieres limpiar la mesa de juego por completo? Se eliminarán todas las cartas y contadores en el tablero.',
      () => {
        setCards([]);
        setCounters([]);
        setSelectedCardIds(new Set());
        setSelectedCounterIds(new Set());
      }
    );
  };

  // Selection managers
  const handleSelectItems = (cardIds: Set<string>, counterIds: Set<string>) => {
    setSelectedCardIds(cardIds);
    setSelectedCounterIds(counterIds);
  };

  const handleClearSelection = () => {
    setSelectedCardIds(new Set());
    setSelectedCounterIds(new Set());
  };

  // Coordinates drag updates
  const handleUpdateCardPositions = (updates: { id: string; x: number; y: number }[]) => {
    if (updates.length === 0) return;
    const updateMap = new Map(updates.map((u) => [u.id, u]));
    setCards((prev) =>
      prev.map((c) => {
        const u = updateMap.get(c.id);
        return u ? { ...c, x: u.x, y: u.y } : c;
      })
    );
  };

  const handleUpdateCounterPositions = (updates: { id: string; x: number; y: number }[]) => {
    if (updates.length === 0) {
      setCounters([...counters]);
      return;
    }
    const updateMap = new Map(updates.map((u) => [u.id, u]));
    setCounters((prev) =>
      prev.map((c) => {
        const u = updateMap.get(c.id);
        return u ? { ...c, x: u.x, y: u.y } : c;
      })
    );
  };

  const handleUpdateCounterValue = (id: string, value: number) => {
    setCounters((prev) =>
      prev.map((c) => (c.id === id ? { ...c, value } : c))
    );
  };

  const handleUpdateCounterLabel = (id: string, label: string) => {
    setCounters((prev) =>
      prev.map((c) => (c.id === id ? { ...c, label } : c))
    );
  };

  // Bring to front stacking
  // Bring a list of cards to front while preserving their relative stacking order
  const handleUpdateCardsZIndex = (ids: string[]) => {
    setCards((prev) => {
      const draggedCards = prev.filter((c) => ids.includes(c.id));
      draggedCards.sort((a, b) => a.zIndex - b.zIndex);

      let currentZ = nextZIndex;
      const idToNewZ: Record<string, number> = {};
      draggedCards.forEach((c) => {
        currentZ++;
        idToNewZ[c.id] = currentZ;
      });

      setNextZIndex(currentZ);

      return prev.map((c) => {
        const newZ = idToNewZ[c.id];
        return newZ !== undefined ? { ...c, zIndex: newZ } : c;
      });
    });
  };

  const handleUpdateCountersZIndex = (ids: string[]) => {
    setCounters((prev) => {
      const draggedCounters = prev.filter((c) => ids.includes(c.id));
      draggedCounters.sort((a, b) => a.zIndex - b.zIndex);

      let currentZ = nextZIndex;
      const idToNewZ: Record<string, number> = {};
      draggedCounters.forEach((c) => {
        currentZ++;
        idToNewZ[c.id] = currentZ;
      });

      setNextZIndex(currentZ);

      return prev.map((c) => {
        const newZ = idToNewZ[c.id];
        return newZ !== undefined ? { ...c, zIndex: newZ } : c;
      });
    });
  };

  // Double click selects the entire stack sharing same coordinates
  const handleDoubleClickCard = (id: string) => {
    const targetCard = cards.find((c) => c.id === id);
    if (!targetCard) return;

    const stack = cards.filter((c) => c.x === targetCard.x && c.y === targetCard.y);
    setSelectedCardIds(new Set(stack.map((c) => c.id)));
    setSelectedCounterIds(new Set()); // clear counter selections
  };

  // Multi selection actions
  const handleFlipSelected = () => {
    if (selectedCardIds.size === 0) return;
    setCards((prev) =>
      prev.map((c) =>
        selectedCardIds.has(c.id) ? { ...c, isFaceUp: !c.isFaceUp } : c
      )
    );
  };

  const handleRotateSelected = (degrees: number) => {
    if (selectedCardIds.size === 0) return;
    setCards((prev) =>
      prev.map((c) =>
        selectedCardIds.has(c.id)
          ? { ...c, rotation: c.rotation + degrees }
          : c
      )
    );
  };

  const handleDeleteSelected = () => {
    if (selectedCardIds.size === 0 && selectedCounterIds.size === 0) return;

    setCards((prev) => prev.filter((c) => !selectedCardIds.has(c.id)));
    setCounters((prev) => prev.filter((c) => !selectedCounterIds.has(c.id)));

    setSelectedCardIds(new Set());
    setSelectedCounterIds(new Set());
  };

  const handleShuffleSelected = () => {
    const selectedCards = cards.filter((c) => selectedCardIds.has(c.id));
    if (selectedCards.length <= 1) return;

    // Calculate center pile position
    const avgX = selectedCards.reduce((sum, c) => sum + c.x, 0) / selectedCards.length;
    const avgY = selectedCards.reduce((sum, c) => sum + c.y, 0) / selectedCards.length;

    // Fisher-Yates Shuffle
    const shuffled = [...selectedCards];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    let startZ = nextZIndex;
    const updatedCards = cards.map((c) => {
      if (selectedCardIds.has(c.id)) {
        const index = shuffled.findIndex((sc) => sc.id === c.id);
        startZ++;
        return {
          ...c,
          x: avgX,
          y: avgY,
          zIndex: startZ + index,
        };
      }
      return c;
    });

    setNextZIndex(startZ + selectedCards.length);
    setCards(updatedCards);

    // Wobble animation trigger
    const activeIds = new Set(selectedCardIds);
    setShufflingCardIds(activeIds);
    setTimeout(() => {
      setShufflingCardIds((prev) => {
        const next = new Set(prev);
        activeIds.forEach((id) => next.delete(id));
        return next;
      });
    }, 500);
  };

  const hasSelection = selectedCardIds.size > 0 || selectedCounterIds.size > 0;

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative', overflow: 'hidden' }}>
      {/* Sidebar Panel */}
      <Sidebar
        isOpen={isSidebarOpen}
        onToggle={() => setIsSidebarOpen(!isSidebarOpen)}
        templates={templates}
        deckNames={deckNames}
        onUpdateDeckName={handleUpdateDeckName}
        onCreateDeck={handleCreateDeck}
        onDeleteDeck={handleDeleteDeck}
        onAddTemplates={handleAddTemplates}
        onDeleteTemplate={handleDeleteTemplate}
        onUpdateTemplateDeck={handleUpdateTemplateDeck}
        onUpdateTemplateBackType={handleUpdateTemplateBackType}
        onUpdateTemplateQuantity={handleUpdateTemplateQuantity}
        onAddCardsToBoard={handleAddCardsToBoard}
        onAddDeckToBoard={handleAddDeckToBoard}
        onAddCounter={handleAddCounter}
        onClearBoard={handleClearBoard}
        backUrls={backUrls}
        onUploadBack={handleUploadBack}
        onDeleteBack={handleDeleteBack}
        showAlert={showAlert}
      />

      {/* Floating Toolbar */}
      {hasSelection && (
        <div
          className="glass-panel"
          style={{
            position: 'absolute',
            top: '20px',
            left: '50%',
            transform: 'translateX(-50%)',
            padding: '10px 20px',
            display: 'flex',
            alignItems: 'center',
            gap: '14px',
            zIndex: 1001,
            border: '1px solid rgba(255, 255, 255, 0.15)',
            boxShadow: '0 10px 30px rgba(0,0,0,0.6)',
          }}
        >
          <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)', marginRight: '6px' }}>
            Selección:{' '}
            <span style={{ color: '#fff' }}>
              {selectedCardIds.size > 0 ? `${selectedCardIds.size} c.` : ''}
              {selectedCardIds.size > 0 && selectedCounterIds.size > 0 ? ' + ' : ''}
              {selectedCounterIds.size > 0 ? `${selectedCounterIds.size} cont.` : ''}
            </span>
          </div>

          {selectedCardIds.size > 0 && (
            <>
              <button className="btn-secondary" onClick={handleFlipSelected} title="Voltear (F)" style={{ padding: '6px 12px', fontSize: '0.8rem' }}>
                <Eye size={14} /> Voltear
              </button>
              <button className="btn-secondary" onClick={() => handleRotateSelected(-90)} title="Rotar Izq. (Q)" style={{ padding: '6px 12px', fontSize: '0.8rem' }}>
                <RotateCcw size={14} /> Rotar Izq.
              </button>
              <button className="btn-secondary" onClick={() => handleRotateSelected(90)} title="Rotar Der. (E)" style={{ padding: '6px 12px', fontSize: '0.8rem' }}>
                <RotateCw size={14} /> Rotar Der.
              </button>
              {selectedCardIds.size > 1 && (
                <button className="btn-secondary" onClick={handleShuffleSelected} title="Barajar (Z)" style={{ padding: '6px 12px', fontSize: '0.8rem' }}>
                  <Shuffle size={14} /> Barajar
                </button>
              )}
            </>
          )}

          <div style={{ width: '1px', height: '20px', background: 'var(--glass-border)' }} />

          <button className="btn-danger" onClick={handleDeleteSelected} title="Eliminar (Supr)" style={{ padding: '6px 12px', fontSize: '0.8rem' }}>
            <Trash2 size={14} /> Eliminar
          </button>
        </div>
      )}

      {/* Main Tabletop Board Canvas */}
      <Tabletop
        cards={cards}
        counters={counters}
        templates={templates}
        selectedCardIds={selectedCardIds}
        selectedCounterIds={selectedCounterIds}
        shufflingCardIds={shufflingCardIds}
        backUrls={backUrls}
        onSelectItems={handleSelectItems}
        onClearSelection={handleClearSelection}
        onUpdateCardPositions={handleUpdateCardPositions}
        onUpdateCounterPositions={handleUpdateCounterPositions}
        onUpdateCounterValue={handleUpdateCounterValue}
        onUpdateCounterLabel={handleUpdateCounterLabel}
        onUpdateCardsZIndex={handleUpdateCardsZIndex}
        onUpdateCountersZIndex={handleUpdateCountersZIndex}
        onDoubleClickCard={handleDoubleClickCard}
        onFlipSelected={handleFlipSelected}
        onRotateSelected={handleRotateSelected}
        onDeleteSelected={handleDeleteSelected}
        onShuffleSelected={handleShuffleSelected}
      />

      {/* Custom Glassmorphic Popup Modal */}
      {modal.isOpen && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            background: 'rgba(5, 8, 16, 0.75)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 999999,
            animation: 'fadeIn 0.2s ease-out',
          }}
        >
          <div
            className="glass-panel"
            style={{
              width: '90%',
              maxWidth: '400px',
              padding: '24px',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              boxShadow: '0 20px 50px rgba(0,0,0,0.7), 0 0 20px rgba(168, 85, 247, 0.15)',
              borderRadius: '16px',
              background: 'linear-gradient(135deg, rgba(20, 27, 41, 0.9) 0%, rgba(10, 14, 22, 0.95) 100%)',
              animation: 'scaleUp 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)',
            }}
          >
            <h3
              style={{
                fontSize: '1.15rem',
                fontWeight: 700,
                color: '#fff',
                marginBottom: '12px',
                letterSpacing: '-0.3px',
              }}
            >
              {modal.title}
            </h3>
            <p
              style={{
                fontSize: '0.85rem',
                color: 'var(--text-muted)',
                lineHeight: '1.5',
                marginBottom: '24px',
              }}
            >
              {modal.message}
            </p>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              {modal.type === 'confirm' && (
                <button
                  className="btn-secondary"
                  onClick={() => setModal((m) => ({ ...m, isOpen: false }))}
                  style={{ padding: '8px 16px', fontSize: '0.85rem', height: '34px' }}
                >
                  Cancelar
                </button>
              )}
              <button
                className={modal.title.toLowerCase().includes('eliminar') ? 'btn-danger' : 'btn-primary'}
                onClick={() => {
                  setModal((m) => ({ ...m, isOpen: false }));
                  if (modal.onConfirm) modal.onConfirm();
                }}
                style={{ padding: '8px 16px', fontSize: '0.85rem', height: '34px' }}
              >
                {modal.type === 'confirm' ? 'Confirmar' : 'Aceptar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
