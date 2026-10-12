import React, { useState, useRef, useEffect } from 'react';
import type { CardTemplate } from '../types';
import { Trash2, Upload, UserPlus, Search, HelpCircle, Edit2, ChevronLeft, ChevronRight, Globe } from 'lucide-react';
import UTIF from 'utif';

// TIFF decoding to standard PNG Blob helper
function convertTiffToPngBlob(arrayBuffer: ArrayBuffer): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      const ifds = UTIF.decode(arrayBuffer);
      if (!ifds || ifds.length === 0) {
        reject(new Error('No se encontraron directorios de imagen en el archivo TIFF.'));
        return;
      }
      UTIF.decodeImage(arrayBuffer, ifds[0]);
      const rgba = UTIF.toRGBA8(ifds[0]);

      const canvas = document.createElement('canvas');
      canvas.width = ifds[0].width;
      canvas.height = ifds[0].height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('No se pudo obtener el contexto 2D del canvas.'));
        return;
      }

      const imageData = ctx.createImageData(canvas.width, canvas.height);
      imageData.data.set(rgba);
      ctx.putImageData(imageData, 0, 0);

      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error('Error al convertir el Canvas a Blob de PNG.'));
          }
        },
        'image/png'
      );
    } catch (err) {
      reject(err);
    }
  });
}

interface SidebarProps {
  isOpen: boolean;
  onToggle: () => void;
  templates: CardTemplate[];
  deckNames: Record<string, string>;
  onUpdateDeckName: (id: string, name: string) => void;
  onCreateDeck: () => void; // Dynamically create deck
  onDeleteDeck: (id: string) => void; // Dynamically delete deck
  onAddTemplates: (
    templatesData: { name: string; blob: Blob; deckId: string; backType: 'backA' | 'backB'; quantity?: number }[]
  ) => Promise<void>;
  onDeleteTemplate: (id: string) => Promise<void>;
  onUpdateTemplateDeck: (id: string, deckId: string) => void;
  onUpdateTemplateBackType: (id: string, backType: 'backA' | 'backB') => void;
  onUpdateTemplateQuantity: (id: string, quantity: number) => void;
  onAddCardsToBoard: (templateId: string, count: number) => void;
  onAddDeckToBoard: (deckId: string) => void; // Add full deck at once!
  onAddCounter: () => void;
  onClearBoard: () => void;
  backUrls: Record<string, string>;
  onUploadBack: (deckId: string, id: 'backA' | 'backB', blob: Blob) => Promise<void>;
  onDeleteBack: (deckId: string, id: 'backA' | 'backB') => Promise<void>;
  showAlert: (title: string, message: string) => void;
  onOpenOnline?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  isOpen,
  onToggle,
  templates,
  deckNames,
  onUpdateDeckName,
  onCreateDeck,
  onDeleteDeck,
  onAddTemplates,
  onDeleteTemplate,
  onUpdateTemplateDeck,
  onUpdateTemplateBackType,
  onUpdateTemplateQuantity,
  onAddCardsToBoard,
  onAddDeckToBoard,
  onAddCounter,
  onClearBoard,
  backUrls,
  onUploadBack,
  onDeleteBack,
  showAlert,
  onOpenOnline,
}) => {
  // Navigation & UI States
  const [searchQuery, setSearchQuery] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  const [editingDeckId, setEditingDeckId] = useState<string | null>(null);
  const [editingDeckName, setEditingDeckName] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  // Accordion expanded status
  const [expandedDecks, setExpandedDecks] = useState<Record<string, boolean>>({});

  // Batch import states
  const [pendingBatch, setPendingBatch] = useState<Array<{ name: string; file: File | Blob; previewUrl: string; quantity: number }>>([]);
  const [batchDeckId, setBatchDeckId] = useState('mazo1');
  const [batchBackType, setBatchBackType] = useState<'backA' | 'backB'>('backA');
  const [batchDragOver, setBatchDragOver] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Clean up ObjectURLs
  useEffect(() => {
    return () => {
      pendingBatch.forEach((item) => URL.revokeObjectURL(item.previewUrl));
    };
  }, [pendingBatch]);

  // Handle auto batchDeckId adjustment if active deck is deleted
  useEffect(() => {
    const keys = Object.keys(deckNames);
    if (keys.length > 0 && !keys.includes(batchDeckId)) {
      setBatchDeckId(keys[0]);
    }
  }, [deckNames, batchDeckId]);

  // Handle expanding new decks by default
  useEffect(() => {
    setExpandedDecks((prev) => {
      const next = { ...prev };
      Object.keys(deckNames).forEach((k) => {
        if (next[k] === undefined) {
          next[k] = true;
        }
      });
      return next;
    });
  }, [deckNames]);

  // Process files selected/dropped
  const handleProcessFiles = async (files: FileList) => {
    setIsProcessing(true);
    const newPending: Array<{ name: string; file: File | Blob; previewUrl: string; quantity: number }> = [];

    for (const file of Array.from(files)) {
      const nameWithoutExt = file.name.substring(0, file.name.lastIndexOf('.')) || file.name;
      const isTif =
        file.name.toLowerCase().endsWith('.tif') ||
        file.name.toLowerCase().endsWith('.tiff') ||
        file.type === 'image/tiff';

      // Parse quantity suffix (e.g. Cidd_01_Rev1_x2 -> quantity: 2, name: Cidd_01_Rev1)
      const qtyMatch = nameWithoutExt.match(/(?:[_\s-]x|x)(\d+)$/i);
      let parsedQty = 1;
      let cleanName = nameWithoutExt;
      if (qtyMatch) {
        parsedQty = parseInt(qtyMatch[1]) || 1;
        cleanName = nameWithoutExt.substring(0, nameWithoutExt.length - qtyMatch[0].length).trim();
      }

      if (isTif) {
        try {
          const arrayBuffer = await file.arrayBuffer();
          const pngBlob = await convertTiffToPngBlob(arrayBuffer);
          newPending.push({
            name: cleanName,
            file: pngBlob,
            previewUrl: URL.createObjectURL(pngBlob),
            quantity: parsedQty,
          });
        } catch (err) {
          console.error('Error decoding TIFF file:', err);
          showAlert('Error de Formato', `No se pudo decodificar el archivo TIFF: ${file.name}`);
        }
      } else if (file.type.startsWith('image/')) {
        newPending.push({
          name: cleanName,
          file,
          previewUrl: URL.createObjectURL(file),
          quantity: parsedQty,
        });
      }
    }

    if (newPending.length > 0) {
      setPendingBatch((prev) => [...prev, ...newPending]);
    }
    setIsProcessing(false);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) handleProcessFiles(e.target.files);
  };

  // Back uploads (with TIFF checking) specific to a deck
  const handleBackChange = async (e: React.ChangeEvent<HTMLInputElement>, deckId: string, type: 'backA' | 'backB') => {
    const file = e.target.files?.[0];
    if (file) {
      setIsProcessing(true);
      const isTif =
        file.name.toLowerCase().endsWith('.tif') ||
        file.name.toLowerCase().endsWith('.tiff') ||
        file.type === 'image/tiff';

      try {
        if (isTif) {
          const arrayBuffer = await file.arrayBuffer();
          const pngBlob = await convertTiffToPngBlob(arrayBuffer);
          await onUploadBack(deckId, type, pngBlob);
        } else {
          await onUploadBack(deckId, type, file);
        }
      } catch (err) {
        console.error(err);
        showAlert('Error de Carga', 'No se pudo cargar el reverso de la carta.');
      }
      setIsProcessing(false);
    }
  };

  // Deck accordion toggles
  const toggleDeck = (deckId: string) => {
    setExpandedDecks((prev) => ({ ...prev, [deckId]: !prev[deckId] }));
  };

  // Batch import action
  const handleImportBatch = async () => {
    if (pendingBatch.length === 0) return;
    setIsProcessing(true);

    const data = pendingBatch.map((item) => ({
      name: item.name.trim(),
      blob: item.file,
      deckId: batchDeckId,
      backType: batchBackType,
      quantity: item.quantity,
    }));

    await onAddTemplates(data);

    // Revoke object URLs and reset batch state
    pendingBatch.forEach((item) => URL.revokeObjectURL(item.previewUrl));
    setPendingBatch([]);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setIsProcessing(false);
  };

  const handleRemoveBatchItem = (index: number) => {
    setPendingBatch((prev) => {
      const copy = [...prev];
      URL.revokeObjectURL(copy[index].previewUrl);
      copy.splice(index, 1);
      return copy;
    });
  };

  // Save deck renaming
  const handleSaveDeckName = (id: string) => {
    if (editingDeckName.trim()) {
      onUpdateDeckName(id, editingDeckName.trim());
    }
    setEditingDeckId(null);
  };

  return (
    <>
      {/* Floating Toggle Button */}
      <button
        onClick={onToggle}
        className="glass-panel"
        style={{
          position: 'absolute',
          top: '20px',
          left: isOpen ? 'calc(var(--sidebar-width) + 40px)' : '20px',
          zIndex: 1010,
          width: '36px',
          height: '36px',
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#fff',
          cursor: 'pointer',
          border: '1px solid var(--glass-border)',
          transition: 'left 0.3s cubic-bezier(0.25, 0.8, 0.25, 1), background-color 0.2s',
          boxShadow: 'var(--glass-shadow)',
        }}
        title={isOpen ? 'Ocultar menú' : 'Mostrar menú'}
      >
        {isOpen ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
      </button>

      <aside
        className="glass-panel"
        style={{
          width: 'var(--sidebar-width)',
          height: 'calc(100vh - 40px)',
          margin: '20px',
          position: 'absolute',
          top: 0,
          left: 0,
          zIndex: 1000,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          border: '1px solid var(--glass-border)',
          transition: 'transform 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)',
          transform: isOpen ? 'translateX(0)' : 'translateX(-380px)',
        }}
      >
      {/* Sidebar Header */}
      <div
        style={{
          padding: '20px',
          borderBottom: '1px solid var(--glass-border)',
          background: 'rgba(0, 0, 0, 0.2)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <div>
          <h1 style={{ fontSize: '1.25rem', fontWeight: 700, letterSpacing: '-0.5px' }}>
            Aeterna <span style={{ color: 'var(--color-accent)' }}>Duellum</span>
          </h1>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Simulador de Partidas</p>
        </div>
        <button
          className="btn-secondary"
          onClick={() => setShowHelp(!showHelp)}
          style={{ width: '32px', height: '32px', padding: 0, borderRadius: '50%' }}
        >
          <HelpCircle size={18} />
        </button>
      </div>

      {/* Loader spinner indicator */}
      {isProcessing && (
        <div
          style={{
            background: 'var(--color-primary)',
            color: '#fff',
            fontSize: '0.75rem',
            textAlign: 'center',
            padding: '4px',
            fontWeight: 600,
          }}
        >
          Procesando archivos TIF / Carga...
        </div>
      )}

      {/* Help Panel */}
      {showHelp && (
        <div
          style={{
            padding: '16px',
            background: 'rgba(99, 102, 241, 0.1)',
            borderBottom: '1px solid rgba(99, 102, 241, 0.2)',
            fontSize: '0.8rem',
            lineHeight: '1.4',
            overflowY: 'auto',
            maxHeight: '200px',
          }}
        >
          <h4 style={{ fontWeight: 600, color: 'var(--color-accent)', marginBottom: '4px' }}>Atajos y Controles:</h4>
          <ul style={{ listStyleType: 'none', paddingLeft: '4px' }}>
            <li><strong>F</strong> / Doble Click: Voltear boca arriba/abajo</li>
            <li><strong>R</strong>: Rotar 90º en sentido horario</li>
            <li><strong>Z</strong>: Barajar grupo seleccionado</li>
            <li><strong>Supr / Retroceso</strong>: Eliminar de la mesa</li>
            <li><strong>Shift + Arrastrar fondo</strong>: Selección múltiple</li>
            <li><strong>Arrastrar fondo</strong>: Desplazarse (Pan)</li>
            <li><strong>Rueda Ratón</strong>: Zoom en el tablero</li>
          </ul>
        </div>
      )}

      {/* Sidebar Content (Scrolling) */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px', display: 'flex', flexDirection: 'column', gap: '24px' }}>
        
        {/* Game Utilities */}
        <section>
          {onOpenOnline && (
            <button
              className="btn-primary"
              onClick={onOpenOnline}
              style={{ width: '100%', padding: '10px', fontSize: '0.85rem', marginBottom: '8px' }}
            >
              <Globe size={16} /> Jugar Online (1 vs 1)
            </button>
          )}
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="btn-primary" onClick={onAddCounter} style={{ flex: 1, padding: '10px', fontSize: '0.85rem' }}>
              <UserPlus size={16} /> Añadir Contador
            </button>
            <button className="btn-danger" onClick={onClearBoard} style={{ padding: '10px', fontSize: '0.85rem' }}>
              Limpiar Mesa
            </button>
          </div>
        </section>

        {/* Batch Card Importer */}
        <section>
          <h3 style={{ fontSize: '0.85rem', textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: '0.5px', marginBottom: '10px', fontWeight: 600 }}>
            Importar Lote de Cartas
          </h3>

          {/* Drag Area */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setBatchDragOver(true);
            }}
            onDragLeave={() => setBatchDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setBatchDragOver(false);
              if (e.dataTransfer.files) handleProcessFiles(e.dataTransfer.files);
            }}
            onClick={() => fileInputRef.current?.click()}
            style={{
              height: '110px',
              border: batchDragOver ? '2px dashed var(--color-primary)' : '2px dashed var(--glass-border)',
              borderRadius: '12px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              background: batchDragOver ? 'rgba(99, 102, 241, 0.05)' : 'rgba(0, 0, 0, 0.15)',
              transition: 'all 0.2s ease',
              marginBottom: '12px',
              textAlign: 'center',
              padding: '10px',
            }}
          >
            <input type="file" ref={fileInputRef} onChange={handleFileChange} accept="image/*" multiple style={{ display: 'none' }} />
            <Upload size={24} style={{ color: 'var(--text-muted)', marginBottom: '8px' }} />
            <span style={{ fontSize: '0.8rem', fontWeight: 500 }}>Arrastra imágenes (.tif / .png / .jpg)</span>
            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>o haz clic para explorar</span>
          </div>

          {/* Pending Batch Panel */}
          {pendingBatch.length > 0 && (
            <div className="glass-panel" style={{ padding: '12px', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '10px' }}>
              <h4 style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: '10px' }}>
                Lote Pendiente ({pendingBatch.length} cartas)
              </h4>

              {/* Batch Settings */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' }}>
                {/* Select Mazo */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Mazo destino:</span>
                  <select
                    value={batchDeckId}
                    onChange={(e) => setBatchDeckId(e.target.value)}
                    style={{
                      background: '#121820',
                      border: '1px solid var(--glass-border)',
                      color: '#fff',
                      fontSize: '0.75rem',
                      borderRadius: '4px',
                      padding: '2px 4px',
                      outline: 'none',
                      fontFamily: 'var(--font-family)',
                    }}
                  >
                    {Object.entries(deckNames).map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Select Reverso */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Reverso:</span>
                  <div style={{ display: 'flex', borderRadius: '4px', overflow: 'hidden', border: '1px solid var(--glass-border)' }}>
                    <button
                      onClick={() => setBatchBackType('backA')}
                      style={{
                        padding: '2px 8px',
                        fontSize: '0.7rem',
                        background: batchBackType === 'backA' ? 'var(--color-primary)' : 'transparent',
                        color: '#fff',
                        borderRadius: 0,
                      }}
                    >
                      A
                    </button>
                    <button
                      onClick={() => setBatchBackType('backB')}
                      style={{
                        padding: '2px 8px',
                        fontSize: '0.7rem',
                        background: batchBackType === 'backB' ? 'var(--color-primary)' : 'transparent',
                        color: '#fff',
                        borderRadius: 0,
                      }}
                    >
                      B
                    </button>
                  </div>
                </div>
              </div>

              {/* Previews List */}
              <div style={{ maxHeight: '110px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '12px', paddingRight: '4px' }}>
                {pendingBatch.map((item, idx) => (
                  <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'rgba(255,255,255,0.03)', padding: '4px', borderRadius: '4px' }}>
                    <img src={item.previewUrl} alt="" style={{ width: '20px', height: '28px', objectFit: 'cover', borderRadius: '2px' }} />
                    <input
                      type="text"
                      value={item.name}
                      onChange={(e) => {
                        const newName = e.target.value;
                        setPendingBatch((prev) => {
                          const copy = [...prev];
                          copy[idx].name = newName;
                          return copy;
                        });
                      }}
                      style={{
                        flex: 1,
                        background: 'transparent',
                        border: 'none',
                        borderBottom: '1px solid transparent',
                        color: '#fff',
                        fontSize: '0.75rem',
                        outline: 'none',
                      }}
                      onFocus={(e) => (e.target.style.borderBottomColor = 'var(--color-primary)')}
                      onBlur={(e) => (e.target.style.borderBottomColor = 'transparent')}
                    />
                    {item.quantity > 1 && (
                      <span
                        style={{
                          fontSize: '0.65rem',
                          background: 'rgba(99, 102, 241, 0.2)',
                          border: '1px solid rgba(99, 102, 241, 0.4)',
                          color: 'var(--color-accent)',
                          padding: '1px 4px',
                          borderRadius: '4px',
                          fontWeight: 'bold',
                        }}
                      >
                        x{item.quantity}
                      </span>
                    )}
                    <button
                      onClick={() => handleRemoveBatchItem(idx)}
                      style={{
                        width: '16px',
                        height: '16px',
                        borderRadius: '50%',
                        background: 'rgba(255,255,255,0.08)',
                        color: 'var(--text-muted)',
                        fontSize: '9px',
                        padding: 0,
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>

              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="btn-primary" onClick={handleImportBatch} style={{ flex: 1, padding: '6px', fontSize: '0.8rem' }}>
                  Importar {pendingBatch.length} cartas
                </button>
                <button
                  className="btn-secondary"
                  onClick={() => {
                    pendingBatch.forEach((item) => URL.revokeObjectURL(item.previewUrl));
                    setPendingBatch([]);
                  }}
                  style={{ padding: '6px 10px', fontSize: '0.8rem' }}
                >
                  Vaciar
                </button>
              </div>
            </div>
          )}
        </section>

        {/* Card Library Accordions */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: '14px', flex: 1 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
            <h3 style={{ fontSize: '0.85rem', textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: '0.5px', fontWeight: 600 }}>
              Biblioteca de Diseños
            </h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <button
                className="btn-secondary"
                onClick={onCreateDeck}
                style={{
                  padding: '2px 6px',
                  fontSize: '0.7rem',
                  height: '22px',
                }}
              >
                + Nuevo Mazo
              </button>
              <div style={{ position: 'relative', width: '90px' }}>
                <Search size={10} style={{ position: 'absolute', left: '6px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Buscar..."
                  style={{
                    width: '100%',
                    padding: '3px 4px 3px 20px',
                    borderRadius: '6px',
                    border: '1px solid var(--glass-border)',
                    background: 'rgba(0,0,0,0.2)',
                    color: '#fff',
                    fontSize: '0.7rem',
                    outline: 'none',
                  }}
                />
              </div>
            </div>
          </div>

          {/* Decks lists */}
          {Object.keys(deckNames).map((deckId) => {
            const deckTemplates = templates.filter(
              (t) => t.deckId === deckId && t.name.toLowerCase().includes(searchQuery.toLowerCase())
            );
            const isExpanded = expandedDecks[deckId] ?? false;
            const isEditing = editingDeckId === deckId;

            return (
              <div
                key={deckId}
                style={{
                  border: '1px solid var(--glass-border)',
                  borderRadius: '10px',
                  background: isExpanded ? 'rgba(255,255,255,0.01)' : 'transparent',
                  overflow: 'hidden',
                  transition: 'all 0.2s ease',
                }}
              >
                {/* Accordion Header */}
                <div
                  style={{
                    padding: '10px 14px',
                    background: 'rgba(0, 0, 0, 0.15)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    cursor: 'pointer',
                  }}
                  onClick={() => toggleDeck(deckId)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: 1, minWidth: 0 }} onClick={(e) => isEditing && e.stopPropagation()}>
                    {isEditing ? (
                      <input
                        type="text"
                        value={editingDeckName}
                        onChange={(e) => setEditingDeckName(e.target.value)}
                        onBlur={() => handleSaveDeckName(deckId)}
                        onKeyDown={(e) => e.key === 'Enter' && handleSaveDeckName(deckId)}
                        autoFocus
                        maxLength={18}
                        style={{
                          background: '#121820',
                          border: '1px solid var(--color-primary)',
                          borderRadius: '4px',
                          color: '#fff',
                          fontSize: '0.8rem',
                          padding: '2px 6px',
                          width: '110px',
                          outline: 'none',
                        }}
                      />
                    ) : (
                      <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-main)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {deckNames[deckId]}
                      </span>
                    )}

                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>({deckTemplates.length})</span>

                    {!isEditing && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingDeckId(deckId);
                          setEditingDeckName(deckNames[deckId]);
                        }}
                        style={{
                          background: 'transparent',
                          color: 'var(--text-muted)',
                          padding: '2px',
                          display: 'inline-flex',
                        }}
                      >
                        <Edit2 size={10} />
                      </button>
                    )}
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    {/* Add Full Deck button */}
                    {deckTemplates.length > 0 && (
                      <button
                        className="btn-secondary"
                        onClick={(e) => {
                          e.stopPropagation(); // Avoid expanding
                          onAddDeckToBoard(deckId);
                        }}
                        style={{
                          padding: '2px 6px',
                          fontSize: '0.65rem',
                          height: '20px',
                          background: 'rgba(99, 102, 241, 0.15)',
                          border: '1px solid rgba(99, 102, 241, 0.3)',
                        }}
                        title="Añadir mazo completo al tablero como pila"
                      >
                        + Todo
                      </button>
                    )}

                    {/* Delete Deck button */}
                    <button
                      className="btn-danger"
                      onClick={(e) => {
                        e.stopPropagation(); // Avoid expanding
                        onDeleteDeck(deckId);
                      }}
                      style={{
                        width: '20px',
                        height: '20px',
                        padding: 0,
                        borderRadius: '4px',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                      title="Eliminar mazo completo de la biblioteca"
                    >
                      <Trash2 size={10} />
                    </button>
                  </div>

                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginLeft: '8px' }}>{isExpanded ? '▲' : '▼'}</span>
                </div>

                {/* Accordion Body */}
                {isExpanded && (
                  <div style={{ padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '300px', overflowY: 'auto' }}>
                    
                    {/* Reverso A y B slots specific to this deck */}
                    {(() => {
                      const backAUrl = backUrls[`backA-${deckId}`];
                      const backBUrl = backUrls[`backB-${deckId}`];

                      return (
                        <div style={{ display: 'flex', gap: '8px', marginBottom: '8px', borderBottom: '1px solid var(--glass-border)', paddingBottom: '10px' }}>
                          {/* Slot Reverso A */}
                          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                            <label
                              style={{
                                width: '100%',
                                height: '64px',
                                borderRadius: '8px',
                                border: '2px dashed var(--glass-border)',
                                background: 'rgba(0,0,0,0.2)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                cursor: 'pointer',
                                position: 'relative',
                                overflow: 'hidden',
                              }}
                            >
                              {backAUrl ? (
                                <>
                                  <img src={backAUrl} alt="Reverso A" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                  <button
                                    onClick={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      onDeleteBack(deckId, 'backA');
                                    }}
                                    style={{
                                      position: 'absolute',
                                      top: '2px',
                                      right: '2px',
                                      width: '16px',
                                      height: '16px',
                                      borderRadius: '50%',
                                      background: 'rgba(239, 68, 68, 0.9)',
                                      color: '#fff',
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      fontSize: '9px',
                                      border: 'none',
                                      padding: 0,
                                      cursor: 'pointer',
                                    }}
                                  >
                                    ✕
                                  </button>
                                </>
                              ) : (
                                <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.65rem' }}>
                                  <Upload size={12} style={{ marginBottom: '2px' }} />
                                  <div>Reverso A</div>
                                </div>
                              )}
                              <input
                                type="file"
                                onChange={(e) => handleBackChange(e, deckId, 'backA')}
                                accept="image/*"
                                style={{ display: 'none' }}
                              />
                            </label>
                          </div>

                          {/* Slot Reverso B */}
                          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                            <label
                              style={{
                                width: '100%',
                                height: '64px',
                                borderRadius: '8px',
                                border: '2px dashed var(--glass-border)',
                                background: 'rgba(0,0,0,0.2)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                cursor: 'pointer',
                                position: 'relative',
                                overflow: 'hidden',
                              }}
                            >
                              {backBUrl ? (
                                <>
                                  <img src={backBUrl} alt="Reverso B" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                  <button
                                    onClick={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      onDeleteBack(deckId, 'backB');
                                    }}
                                    style={{
                                      position: 'absolute',
                                      top: '2px',
                                      right: '2px',
                                      width: '16px',
                                      height: '16px',
                                      borderRadius: '50%',
                                      background: 'rgba(239, 68, 68, 0.9)',
                                      color: '#fff',
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      fontSize: '9px',
                                      border: 'none',
                                      padding: 0,
                                      cursor: 'pointer',
                                    }}
                                  >
                                    ✕
                                  </button>
                                </>
                              ) : (
                                <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.65rem' }}>
                                  <Upload size={12} style={{ marginBottom: '2px' }} />
                                  <div>Reverso B</div>
                                </div>
                              )}
                              <input
                                type="file"
                                onChange={(e) => handleBackChange(e, deckId, 'backB')}
                                accept="image/*"
                                style={{ display: 'none' }}
                              />
                            </label>
                          </div>
                        </div>
                      );
                    })()}

                    {deckTemplates.length === 0 ? (
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textAlign: 'center', padding: '14px' }}>
                        Mazo vacío. Arrastra cartas aquí.
                      </div>
                    ) : (
                      deckTemplates.map((template) => (
                        <div
                          key={template.id}
                          style={{
                            padding: '8px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            background: 'rgba(255, 255, 255, 0.02)',
                            border: '1px solid rgba(255, 255, 255, 0.04)',
                            borderRadius: '8px',
                          }}
                        >
                          {/* Miniatura */}
                          <img
                            src={template.imageUrl}
                            alt=""
                            style={{
                              width: '32px',
                              height: '46px',
                              objectFit: 'cover',
                              borderRadius: '4px',
                              border: '1px solid rgba(255,255,255,0.08)',
                            }}
                          />

                          {/* Info */}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <h4
                              style={{
                                fontSize: '0.8rem',
                                fontWeight: 500,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                marginBottom: '4px',
                              }}
                              title={template.name}
                            >
                              {template.name}
                            </h4>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                              <button
                                className="btn-primary"
                                onClick={() => onAddCardsToBoard(template.id, 1)}
                                style={{ padding: '2px 6px', fontSize: '0.7rem' }}
                              >
                                +1
                              </button>

                              {/* Toggle Reverso: A / B */}
                              <div style={{ display: 'flex', borderRadius: '4px', overflow: 'hidden', border: '1px solid var(--glass-border)' }}>
                                <button
                                  onClick={() => onUpdateTemplateBackType(template.id, 'backA')}
                                  style={{
                                    padding: '2px 4px',
                                    fontSize: '0.65rem',
                                    background: template.backType === 'backA' ? 'rgba(99, 102, 241, 0.4)' : 'transparent',
                                    color: template.backType === 'backA' ? '#fff' : 'var(--text-muted)',
                                    borderRadius: 0,
                                  }}
                                >
                                  A
                                </button>
                                <button
                                  onClick={() => onUpdateTemplateBackType(template.id, 'backB')}
                                  style={{
                                    padding: '2px 4px',
                                    fontSize: '0.65rem',
                                    background: template.backType === 'backB' ? 'rgba(168, 85, 247, 0.4)' : 'transparent',
                                    color: template.backType === 'backB' ? '#fff' : 'var(--text-muted)',
                                    borderRadius: 0,
                                  }}
                                >
                                  B
                                </button>
                              </div>
                            </div>

                            {/* Copies in Deck */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px' }}>
                              <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Mazo (copias):</span>
                              <input
                                type="number"
                                min="1"
                                max="60"
                                value={template.quantity || 1}
                                onChange={(e) => onUpdateTemplateQuantity(template.id, parseInt(e.target.value) || 1)}
                                style={{
                                  width: '32px',
                                  background: 'rgba(0,0,0,0.3)',
                                  border: '1px solid var(--glass-border)',
                                  color: '#fff',
                                  borderRadius: '4px',
                                  fontSize: '0.7rem',
                                  textAlign: 'center',
                                  outline: 'none',
                                  padding: '1px 2px',
                                }}
                              />
                            </div>
                          </div>

                          {/* Options */}
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'flex-end' }}>
                            <select
                              value={template.deckId}
                              onChange={(e) => onUpdateTemplateDeck(template.id, e.target.value)}
                              style={{
                                background: '#121820',
                                border: '1px solid rgba(255,255,255,0.1)',
                                color: 'var(--text-muted)',
                                fontSize: '0.65rem',
                                borderRadius: '4px',
                                padding: '1px 2px',
                                outline: 'none',
                                maxWidth: '65px',
                              }}
                              title="Mover a mazo"
                            >
                              {Object.keys(deckNames).map((id) => {
                                const name = deckNames[id] || id;
                                const shortName = name.length > 3 ? name.substring(0, 3) : name;
                                return (
                                  <option key={id} value={id}>
                                    {shortName}
                                  </option>
                                );
                              })}
                            </select>

                            <button
                              className="btn-danger"
                              onClick={() => onDeleteTemplate(template.id)}
                              style={{ width: '20px', height: '20px', padding: 0, borderRadius: '4px' }}
                            >
                              <Trash2 size={10} />
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      </div>
      </aside>
    </>
  );
};
