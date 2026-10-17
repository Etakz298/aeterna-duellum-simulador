import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, Download, Gamepad2, Heart, ImagePlus, Layers, Minus, Pencil, Plus, Search, Star, Trash2, Upload, X } from 'lucide-react';
import UTIF from 'utif';
import type { CardTemplate } from '../types';
import { setRotationAllowed } from '../rotation';

type BackType = 'backA' | 'backB';
type NewTemplate = { name: string; blob: Blob; deckId: string; backType: BackType; quantity?: number; isSpecial?: boolean; isLife?: boolean };

interface DeckEditorProps {
  templates: CardTemplate[];
  deckNames: Record<string, string>;
  backUrls: Record<string, string>;
  onUpdateDeckName: (id: string, name: string) => void;
  onCreateDeck: () => string;
  onDeleteDeck: (id: string) => void;
  onAddTemplates: (templates: NewTemplate[]) => Promise<void>;
  onDeleteTemplate: (id: string) => void;
  onUpdateTemplateDeck: (id: string, deckId: string) => void;
  onUpdateTemplateBackType: (id: string, backType: BackType) => void;
  onUpdateTemplateQuantity: (id: string, quantity: number) => void;
  onUpdateTemplateSpecial: (id: string, isSpecial: boolean) => void;
  onUpdateTemplateLife: (id: string, isLife: boolean) => void;
  onUploadBack: (deckId: string, id: BackType, blob: Blob) => Promise<void>;
  onDeleteBack: (deckId: string, id: BackType) => Promise<void>;
  showAlert: (title: string, message: string) => void;
  onPlaySolo: () => void;
  onExit?: () => void;
  onImportServerDecks?: () => void;
  importProgress?: { done: number; total: number } | null;
}

// Los .tif se convierten a PNG para poder verlos en el navegador
function convertTiffToPngBlob(arrayBuffer: ArrayBuffer): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      const ifds = UTIF.decode(arrayBuffer);
      if (!ifds?.length) return reject(new Error('El TIFF no tiene imágenes.'));
      UTIF.decodeImage(arrayBuffer, ifds[0]);
      const rgba = UTIF.toRGBA8(ifds[0]);
      const canvas = document.createElement('canvas');
      canvas.width = ifds[0].width;
      canvas.height = ifds[0].height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('No se pudo preparar la imagen.'));
      const imageData = ctx.createImageData(canvas.width, canvas.height);
      imageData.data.set(rgba);
      ctx.putImageData(imageData, 0, 0);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('No se pudo convertir el TIFF.'))), 'image/png');
    } catch (err) {
      reject(err);
    }
  });
}

const isTiff = (file: File) => /\.tiff?$/i.test(file.name) || file.type === 'image/tiff';
const toImageBlob = async (file: File): Promise<Blob | null> => {
  if (isTiff(file)) return convertTiffToPngBlob(await file.arrayBuffer());
  return file.type.startsWith('image/') ? file : null;
};

const copiesOf = (list: CardTemplate[]) => list.filter((t) => !t.isLife).reduce((n, t) => n + (t.quantity || 1), 0);

interface Pending {
  name: string;
  blob: Blob;
  url: string;
  quantity: number;
  isSpecial?: boolean;
  isLife?: boolean;
}

// Editor de mazos: lista de mazos a la izquierda y las cartas del mazo elegido a la derecha
export const DeckEditor: React.FC<DeckEditorProps> = (props) => {
  const { templates, deckNames, backUrls } = props;
  const deckIds = Object.keys(deckNames);
  const [deckId, setDeckId] = useState(() => deckIds[0] || '');
  const [query, setQuery] = useState('');
  const [editingName, setEditingName] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [pendingBack, setPendingBack] = useState<BackType>('backA');
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // En el móvil el editor se ve en vertical, como una página normal
  useEffect(() => {
    setRotationAllowed(false);
    return () => setRotationAllowed(true);
  }, []);

  // Si el mazo elegido desaparece (borrado), se pasa al primero
  useEffect(() => {
    if (!deckNames[deckId] && deckIds.length) setDeckId(deckIds[0]);
  }, [deckNames, deckId, deckIds]);

  const deckCards = useMemo(() => templates.filter((t) => t.deckId === deckId), [templates, deckId]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? deckCards.filter((t) => t.name.toLowerCase().includes(q)) : deckCards;
    // Vida y Especial primero; el resto por orden de llegada
    const rank = (t: CardTemplate) => (t.isLife ? 0 : t.isSpecial ? 1 : 2);
    return [...list].sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt);
  }, [deckCards, query]);

  const addFiles = async (files: FileList | File[]) => {
    setBusy(true);
    const next: Pending[] = [];
    for (const file of Array.from(files)) {
      const base = file.name.replace(/\.[^.]+$/, '');
      // Sufijo de copias en el nombre: Cidd_01_x2 → 2 copias
      const qty = base.match(/(?:[_\s-]x|x)(\d+)$/i);
      try {
        const blob = await toImageBlob(file);
        if (!blob) continue;
        next.push({
          name: qty ? base.slice(0, base.length - qty[0].length).trim() : base,
          blob,
          url: URL.createObjectURL(blob),
          quantity: qty ? parseInt(qty[1]) || 1 : 1,
        });
      } catch {
        props.showAlert('Formato no válido', `No se pudo leer ${file.name}`);
      }
    }
    setPending((p) => [...p, ...next]);
    setBusy(false);
    if (fileRef.current) fileRef.current.value = '';
  };
  const clearPending = () => {
    pending.forEach((p) => URL.revokeObjectURL(p.url));
    setPending([]);
  };
  const importPending = async () => {
    setBusy(true);
    await props.onAddTemplates(
      pending.map((p) => ({ name: p.name.trim() || 'Carta', blob: p.blob, deckId, backType: pendingBack, quantity: p.quantity, isSpecial: !!p.isSpecial, isLife: !!p.isLife })),
    );
    clearPending();
    setBusy(false);
  };
  const patchPending = (i: number, patch: Partial<Pending>) =>
    setPending((list) =>
      list.map((p, k) => {
        if (k === i) return { ...p, ...patch };
        // Solo una Especial y una carta de vida por mazo
        if (patch.isSpecial) return { ...p, isSpecial: false };
        if (patch.isLife) return { ...p, isLife: false };
        return p;
      }),
    );

  const uploadBack = async (type: BackType, file?: File) => {
    if (!file) return;
    try {
      const blob = await toImageBlob(file);
      if (blob) await props.onUploadBack(deckId, type, blob);
    } catch {
      props.showAlert('Error de carga', 'No se pudo cargar el reverso.');
    }
  };

  const createDeck = () => {
    const id = props.onCreateDeck();
    setDeckId(id);
    setEditingName(deckNames[id] ?? 'Nuevo mazo');
  };
  const saveName = () => {
    if (editingName !== null && editingName.trim()) props.onUpdateDeckName(deckId, editingName.trim());
    setEditingName(null);
  };

  const deckTitle = deckNames[deckId] || '';
  const total = copiesOf(deckCards);

  return (
    <div
      className="de-root"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files') || !deckId) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (deckId && e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
      }}
    >
      <header className="de-top">
        {props.onExit && (
          <button className="btn-secondary de-icon-btn" onClick={props.onExit} title="Volver a la portada">
            <ArrowLeft size={18} />
          </button>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="de-kicker">Edición</div>
          <h1 className="de-title">Editor de mazos</h1>
        </div>
        {props.onImportServerDecks && (
          <button className="btn-secondary de-top-btn" onClick={props.onImportServerDecks} disabled={!!props.importProgress} title="Copia en este dispositivo los mazos publicados para el 1 vs 1">
            <Download size={16} />
            <span className="de-hide-sm">{props.importProgress ? `Trayendo ${props.importProgress.done}/${props.importProgress.total}…` : 'Traer mazos del 1 vs 1'}</span>
          </button>
        )}
        <button className="btn-primary de-top-btn" onClick={props.onPlaySolo}>
          <Gamepad2 size={16} /> <span>Jugar</span>
        </button>
      </header>

      <div className="de-body">
        <aside className="de-decks">
          <div className="de-decks-head">
            <span>Mazos</span>
            <button className="btn-secondary de-new" onClick={createDeck} title="Crear un mazo vacío">
              <Plus size={14} /> Nuevo
            </button>
          </div>
          <div className="de-deck-list">
            {deckIds.map((id) => {
              const list = templates.filter((t) => t.deckId === id);
              const cover = backUrls[`backA-${id}`] || backUrls[`backB-${id}`];
              return (
                <button key={id} className={`de-deck${id === deckId ? ' de-deck-on' : ''}`} onClick={() => setDeckId(id)}>
                  <span className="de-deck-cover">{cover ? <img src={cover} alt="" /> : <Layers size={16} />}</span>
                  <span className="de-deck-text">
                    <strong>{deckNames[id]}</strong>
                    <small>{copiesOf(list)} cartas</small>
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        <main className="de-main">
          {!deckId ? (
            <div className="de-empty">Crea un mazo para empezar.</div>
          ) : (
            <>
              <section className="de-deck-head glass-panel">
                <div className="de-backs">
                  {(['backA', 'backB'] as BackType[]).map((type) => {
                    const url = backUrls[`${type}-${deckId}`];
                    return (
                      <label key={type} className="de-back" title={`Reverso ${type === 'backA' ? 'A' : 'B'}: toca para cambiarlo`}>
                        {url ? <img src={url} alt="" /> : <ImagePlus size={20} />}
                        <span className="de-back-tag">{type === 'backA' ? 'A' : 'B'}</span>
                        {url && (
                          <button
                            className="de-back-del"
                            title="Quitar reverso"
                            onClick={(e) => {
                              e.preventDefault();
                              props.onDeleteBack(deckId, type);
                            }}
                          >
                            <X size={11} />
                          </button>
                        )}
                        <input type="file" accept="image/*,.tif,.tiff" style={{ display: 'none' }} onChange={(e) => uploadBack(type, e.target.files?.[0])} />
                      </label>
                    );
                  })}
                </div>
                <div className="de-deck-info">
                  {editingName !== null ? (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        saveName();
                      }}
                      style={{ display: 'flex', gap: 6 }}
                    >
                      <input autoFocus className="de-input de-name-input" value={editingName} onChange={(e) => setEditingName(e.target.value)} onBlur={saveName} maxLength={30} />
                      <button type="submit" className="btn-primary de-icon-btn" title="Guardar nombre">
                        <Check size={16} />
                      </button>
                    </form>
                  ) : (
                    <h2 className="de-deck-name" onClick={() => setEditingName(deckTitle)} title="Cambiar el nombre">
                      {deckTitle} <Pencil size={15} className="de-muted" />
                    </h2>
                  )}
                  <div className="de-stats">
                    <span>
                      <strong>{total}</strong> cartas
                    </span>
                    <span>
                      <strong>{deckCards.length}</strong> diseños
                    </span>
                    <span className={deckCards.some((t) => t.isLife) ? '' : 'de-warn'}>
                      <Heart size={13} /> {deckCards.some((t) => t.isLife) ? 'Con carta de vida' : 'Sin carta de vida'}
                    </span>
                  </div>
                  <div className="de-actions">
                    <button className="btn-primary" onClick={() => fileRef.current?.click()} disabled={busy}>
                      <Upload size={15} /> Añadir cartas
                    </button>
                    <div className="de-search">
                      <Search size={14} />
                      <input className="de-input" placeholder="Buscar carta" value={query} onChange={(e) => setQuery(e.target.value)} />
                    </div>
                    <button className="btn-danger de-icon-btn" onClick={() => props.onDeleteDeck(deckId)} title="Eliminar este mazo">
                      <Trash2 size={15} />
                    </button>
                  </div>
                  <input ref={fileRef} type="file" accept="image/*,.tif,.tiff" multiple style={{ display: 'none' }} onChange={(e) => e.target.files && addFiles(e.target.files)} />
                </div>
              </section>

              {shown.length === 0 ? (
                <button className="de-drop" onClick={() => fileRef.current?.click()}>
                  <Upload size={26} />
                  <strong>{query ? 'No hay cartas con ese nombre' : 'Este mazo no tiene cartas'}</strong>
                  {!query && <span>Arrastra aquí las imágenes (.png, .jpg, .tif) o toca para elegirlas</span>}
                </button>
              ) : (
                <div className="de-grid">
                  {shown.map((t) => (
                    <div key={t.id} className={`de-card${t.isLife ? ' de-card-life' : t.isSpecial ? ' de-card-special' : ''}`}>
                      <div className="de-card-img">
                        {t.imageUrl ? <img src={t.imageUrl} alt={t.name} loading="lazy" /> : <Layers size={24} />}
                        {(t.isLife || t.isSpecial) && <span className="de-badge">{t.isLife ? '♥ Vida' : '★ Especial'}</span>}
                        <button className="de-card-del" onClick={() => props.onDeleteTemplate(t.id)} title="Eliminar esta carta">
                          <Trash2 size={13} />
                        </button>
                      </div>
                      <div className="de-card-name" title={t.name}>
                        {t.name}
                      </div>
                      {!t.isLife && (
                        <div className="de-qty">
                          <button onClick={() => props.onUpdateTemplateQuantity(t.id, (t.quantity || 1) - 1)} disabled={(t.quantity || 1) <= 1} title="Una copia menos">
                            <Minus size={13} />
                          </button>
                          <span>×{t.quantity || 1}</span>
                          <button onClick={() => props.onUpdateTemplateQuantity(t.id, (t.quantity || 1) + 1)} disabled={(t.quantity || 1) >= 60} title="Una copia más">
                            <Plus size={13} />
                          </button>
                        </div>
                      )}
                      <div className="de-chips">
                        <button
                          className={`de-chip${t.isSpecial ? ' de-chip-special' : ''}`}
                          onClick={() => props.onUpdateTemplateSpecial(t.id, !t.isSpecial)}
                          title="Especial (una por mazo): guía de habilidades, siempre arriba del mazo y visible para los dos"
                        >
                          <Star size={12} />
                        </button>
                        <button
                          className={`de-chip${t.isLife ? ' de-chip-life' : ''}`}
                          onClick={() => props.onUpdateTemplateLife(t.id, !t.isLife)}
                          title="Carta de vida (una por mazo): contador de 10 a 0, no entra en la biblioteca"
                        >
                          <Heart size={12} />
                        </button>
                        <button
                          className="de-chip"
                          onClick={() => props.onUpdateTemplateBackType(t.id, t.backType === 'backA' ? 'backB' : 'backA')}
                          title="Reverso que usa esta carta (A o B)"
                        >
                          {t.backType === 'backB' ? 'B' : 'A'}
                        </button>
                        {deckIds.length > 1 && (
                          <select className="de-move" value="" onChange={(e) => e.target.value && props.onUpdateTemplateDeck(t.id, e.target.value)} title="Mover a otro mazo">
                            <option value="">Mover</option>
                            {deckIds
                              .filter((id) => id !== deckId)
                              .map((id) => (
                                <option key={id} value={id}>
                                  {deckNames[id]}
                                </option>
                              ))}
                          </select>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </main>
      </div>

      {dragOver && (
        <div className="de-dragging">
          <Upload size={34} />
          <strong>Suelta para añadir a {deckTitle}</strong>
        </div>
      )}

      {pending.length > 0 && (
        <div className="de-modal-bg">
          <div className="glass-panel de-modal">
            <div className="de-modal-head">
              <h3>
                Añadir {pending.length} {pending.length === 1 ? 'carta' : 'cartas'} a <span style={{ color: 'var(--color-accent)' }}>{deckTitle}</span>
              </h3>
              <div className="de-seg" title="Reverso de las cartas nuevas">
                {(['backA', 'backB'] as BackType[]).map((type) => (
                  <button key={type} className={pendingBack === type ? 'de-seg-on' : ''} onClick={() => setPendingBack(type)}>
                    Reverso {type === 'backA' ? 'A' : 'B'}
                  </button>
                ))}
              </div>
            </div>
            <div className="de-grid de-grid-sm">
              {pending.map((p, i) => (
                <div key={p.url} className={`de-card${p.isLife ? ' de-card-life' : p.isSpecial ? ' de-card-special' : ''}`}>
                  <div className="de-card-img">
                    <img src={p.url} alt="" />
                    <button
                      className="de-card-del"
                      onClick={() => {
                        URL.revokeObjectURL(p.url);
                        setPending((list) => list.filter((_, k) => k !== i));
                      }}
                      title="Quitar"
                    >
                      <X size={13} />
                    </button>
                  </div>
                  <input className="de-input de-pending-name" value={p.name} onChange={(e) => patchPending(i, { name: e.target.value })} />
                  <div className="de-qty">
                    <button onClick={() => patchPending(i, { quantity: Math.max(1, p.quantity - 1) })} disabled={p.quantity <= 1}>
                      <Minus size={13} />
                    </button>
                    <span>×{p.quantity}</span>
                    <button onClick={() => patchPending(i, { quantity: Math.min(60, p.quantity + 1) })}>
                      <Plus size={13} />
                    </button>
                  </div>
                  <div className="de-chips">
                    <button className={`de-chip${p.isSpecial ? ' de-chip-special' : ''}`} onClick={() => patchPending(i, { isSpecial: !p.isSpecial })} title="Especial">
                      <Star size={12} />
                    </button>
                    <button className={`de-chip${p.isLife ? ' de-chip-life' : ''}`} onClick={() => patchPending(i, { isLife: !p.isLife })} title="Carta de vida">
                      <Heart size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="de-modal-foot">
              <button className="btn-secondary" onClick={() => fileRef.current?.click()} disabled={busy}>
                <Plus size={15} /> Más imágenes
              </button>
              <div style={{ flex: 1 }} />
              <button className="btn-secondary" onClick={clearPending} disabled={busy}>
                Cancelar
              </button>
              <button className="btn-primary" onClick={importPending} disabled={busy}>
                <Check size={15} /> {busy ? 'Guardando…' : 'Añadir al mazo'}
              </button>
            </div>
          </div>
        </div>
      )}
      {busy && pending.length === 0 && <div className="de-busy">Procesando imágenes…</div>}
    </div>
  );
};
