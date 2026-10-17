import { useState, useEffect, useRef } from 'react';
import { DeckEditor } from './components/DeckEditor';
import type { CardTemplate, CardBack } from './types';
import {
  getCardTemplates,
  saveCardTemplate,
  deleteCardTemplate,
  getCardBacks,
  saveCardBack,
  deleteCardBack,
} from './db';
import { OnlineMode } from './online/OnlineMode';
import { SoloMode } from './local/SoloMode';
import { loadStoredSession } from './online/useOnlineGame';
import { checkAdminKey, fetchLibrary, getDefaultServerUrl } from './online/server';

// Un enlace de invitación (?sala=CODIGO) o una partida a medias abren el modo online
const SYNC_KEY = 'server_library_synced';
const initialSala = new URLSearchParams(window.location.search).get('sala')?.toUpperCase() || undefined;

interface ModalState {
  isOpen: boolean;
  type: 'alert' | 'confirm';
  title: string;
  message: string;
  onConfirm?: () => void;
}

const EDIT_KEY = 'edit_admin_key';

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


  // Modo: un jugador (mesa como la del 1 vs 1), biblioteca de mazos (la mesa libre
  // de siempre, con el menú para gestionar cartas) u online 1 vs 1
  // El modo un jugador y el editor de mazos solo se abren con la clave de
  // administrador (botón «Edición»); la app de escritorio los tiene siempre.
  const [editUnlocked, setEditUnlocked] = useState(
    () => (typeof window !== 'undefined' && !!window.electronAPI) || !!localStorage.getItem(EDIT_KEY),
  );
  const [mode, setMode] = useState<'solo' | 'local' | 'online'>(() =>
    initialSala || loadStoredSession() || !editUnlocked ? 'online' : 'solo'
  );
  // Si la clave guardada ya no vale (se ha cambiado en el servidor), se vuelve a bloquear
  useEffect(() => {
    const key = localStorage.getItem(EDIT_KEY);
    const url = getDefaultServerUrl();
    if (!key || !url || window.electronAPI) return;
    fetch(`${url}/api/admin/check`, { headers: { 'X-Admin-Key': key } })
      .then((res) => {
        if (res.status !== 401) return;
        localStorage.removeItem(EDIT_KEY);
        setEditUnlocked(false);
        setMode('online');
      })
      .catch(() => {});
  }, []);
  const unlockEdit = async (key: string) => {
    await checkAdminKey(getDefaultServerUrl(), key);
    localStorage.setItem(EDIT_KEY, key);
    localStorage.setItem('online_admin_key', key);
    setEditUnlocked(true);
  };
  const lockEdit = () => {
    localStorage.removeItem(EDIT_KEY);
    setEditUnlocked(!!window.electronAPI);
  };
  const [libraryLoaded, setLibraryLoaded] = useState(false);
  const syncingRef = useRef(false);

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
        }
      } catch (err) {
        console.error('Error loading initial data:', err);
      }
      setLibraryLoaded(true);
    };
    loadAllData();
  }, []);

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
    return newId;
  };

  // Delete a deck and all its templates and board instances (using custom modal confirmation)
  const handleDeleteDeck = async (deckId: string) => {
    const deckName = deckNames[deckId] || deckId;
    showConfirm(
      'Eliminar Mazo',
      `¿Estás seguro de que quieres eliminar el mazo "${deckName}"? Se borrarán permanentemente todas sus cartas.`,
      async () => {
        // 1. Delete all card templates of this deck from IndexedDB
        const templatesToDelete = templates.filter((t) => t.deckId === deckId);
        for (const t of templatesToDelete) {
          await deleteCardTemplate(t.id);
          if (t.imageUrl) URL.revokeObjectURL(t.imageUrl);
        }

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

  // Traer los mazos publicados en el servidor del 1 vs 1 a la biblioteca de este ordenador
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null);

  // silent: sincronización automática al abrir la app (sin preguntar ni avisar)
  const handleImportServerDecks = async ({ silent = false }: { silent?: boolean } = {}) => {
    const serverUrl = getDefaultServerUrl();
    if (!serverUrl) {
      if (silent) return;
      showAlert('Sin servidor', 'Entra una vez en "Jugar Online (1 vs 1)" y conéctate al servidor; después podrás traer sus mazos desde aquí.');
      return;
    }
    let lib;
    try {
      lib = await fetchLibrary(serverUrl);
    } catch {
      if (silent) return;
      showAlert('Sin conexión', 'No se ha podido leer el servidor del 1 vs 1. Comprueba la conexión e inténtalo de nuevo.');
      return;
    }
    const syncMark = `${serverUrl}|${lib.updatedAt}`;
    if (silent && localStorage.getItem(SYNC_KEY) === syncMark) return; // ya está al día
    const serverDecks = Object.keys(lib.deckNames).filter((d) => lib.templates.some((t) => t.deckId === d));
    if (serverDecks.length === 0) {
      if (silent) return;
      showAlert('Sin mazos', 'Todavía no hay mazos publicados en el servidor del 1 vs 1.');
      return;
    }

    // Cada mazo del servidor va a un mazo local con el mismo nombre, o al mismo
    // identificador si está libre o vacío; si no, a un mazo nuevo.
    const usedIds = new Set(Object.keys(deckNames));
    const target: Record<string, string> = {};
    for (const d of serverDecks) {
      const name = lib.deckNames[d].trim().toLowerCase();
      const sameName = Object.keys(deckNames).find((id) => (deckNames[id] || '').trim().toLowerCase() === name);
      const idFree = !usedIds.has(d) || !templates.some((t) => t.deckId === d);
      const id = sameName || (idFree ? d : `deck-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
      target[d] = id;
      usedIds.add(id);
    }
    const replaced = serverDecks
      .filter((d) => templates.some((t) => t.deckId === target[d]))
      .map((d) => deckNames[target[d]] || target[d]);

    const run = async () => {
      const jobs = lib.templates.filter((t) => t.imageUrl && target[t.deckId]);
      const backJobs = Object.entries(lib.backs).flatMap(([key, url]) => {
        const m = key.match(/^(backA|backB)-(.+)$/);
        return m && target[m[2]] ? [{ id: `${m[1]}-${target[m[2]]}`, url }] : [];
      });
      const total = jobs.length + backJobs.length;
      let done = 0;
      setImportProgress({ done, total });
      try {
        const download = async (url: string) => {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`El servidor respondió ${res.status}`);
          return res.blob();
        };

        // Descargar primero todo; así un fallo de red no deja los mazos a medias
        const blobs = new Map<string, Blob>();
        const queue: { key: string; url: string }[] = [
          ...jobs.map((t) => ({ key: t.id, url: t.imageUrl! })),
          ...backJobs.map((b) => ({ key: b.id, url: b.url })),
        ];
        const worker = async () => {
          for (let job = queue.shift(); job; job = queue.shift()) {
            blobs.set(job.key, await download(job.url));
            setImportProgress({ done: ++done, total });
          }
        };
        await Promise.all([worker(), worker(), worker(), worker()]);

        const targetIds = new Set(Object.values(target));
        const old = templates.filter((t) => targetIds.has(t.deckId));
        for (const t of old) {
          await deleteCardTemplate(t.id);
          if (t.imageUrl?.startsWith('blob:')) URL.revokeObjectURL(t.imageUrl);
        }

        const added: CardTemplate[] = [];
        for (const t of jobs) {
          const template: CardTemplate = {
            id: t.id,
            name: t.name,
            imageBlob: blobs.get(t.id),
            deckId: target[t.deckId],
            backType: t.backType,
            quantity: t.quantity,
            isSpecial: !!t.isSpecial,
            isLife: !!t.isLife,
            createdAt: t.createdAt || Date.now(),
          };
          await saveCardTemplate(template);
          if (!template.imageUrl) template.imageUrl = URL.createObjectURL(template.imageBlob!);
          added.push(template);
        }

        const newBackUrls: Record<string, string> = {};
        for (const b of backJobs) {
          const back: CardBack = { id: b.id, imageBlob: blobs.get(b.id) };
          await saveCardBack(back);
          if (backUrls[b.id]?.startsWith('blob:')) URL.revokeObjectURL(backUrls[b.id]);
          newBackUrls[b.id] = back.imageUrl || URL.createObjectURL(back.imageBlob!);
        }

        const addedIds = new Set(added.map((t) => t.id));
        setTemplates((prev) => [...prev.filter((t) => !targetIds.has(t.deckId) && !addedIds.has(t.id)), ...added]);
        setBackUrls((prev) => ({ ...prev, ...newBackUrls }));
        const names = { ...deckNames };
        for (const d of serverDecks) names[target[d]] = lib.deckNames[d];
        saveDeckNamesState(names);

        localStorage.setItem(SYNC_KEY, syncMark);
        if (!silent) showAlert('Mazos traídos', `Ya tienes en este ordenador: ${serverDecks.map((d) => lib.deckNames[d]).join(', ')}.`);
      } catch (err) {
        console.error(err);
        if (!silent) showAlert('No se han podido traer', 'Ha fallado la descarga de alguna carta. No se ha cambiado nada; inténtalo de nuevo.');
      } finally {
        setImportProgress(null);
      }
    };

    if (replaced.length > 0 && !silent) {
      showConfirm(
        'Traer mazos del 1 vs 1',
        `Se cambiarán las cartas de estos mazos de este ordenador por las del servidor: ${replaced.join(', ')}. ¿Continuar?`,
        run,
      );
    } else {
      run();
    }
  };

  // Los mazos publicados para el 1 vs 1 se copian solos a este dispositivo al abrir
  // la app y al volver al modo un jugador (solo si han cambiado en el servidor)
  useEffect(() => {
    if (!libraryLoaded || mode === 'online' || syncingRef.current) return;
    syncingRef.current = true;
    handleImportServerDecks({ silent: true }).finally(() => {
      syncingRef.current = false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryLoaded, mode]);

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
    templatesData: { name: string; blob: Blob; deckId: string; backType: 'backA' | 'backB'; quantity?: number; isSpecial?: boolean; isLife?: boolean }[]
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
        isSpecial: !!item.isSpecial,
        isLife: !!item.isLife,
        createdAt: Date.now(),
      };

      await saveCardTemplate(template);

      // Create local Object URL
      template.imageUrl = URL.createObjectURL(item.blob);
      newTemplates.push(template);
    }

    // Solo una carta de vida y una Especial por mazo: la nueva sustituye a la anterior
    const lifeDecks = new Set(newTemplates.filter((t) => t.isLife).map((t) => t.deckId));
    const specialDecks = new Set(newTemplates.filter((t) => t.isSpecial).map((t) => t.deckId));
    setTemplates((prev) => [
      ...prev.map((t) => {
        const dropLife = t.isLife && lifeDecks.has(t.deckId);
        const dropSpecial = t.isSpecial && specialDecks.has(t.deckId);
        if (!dropLife && !dropSpecial) return t;
        const updated = { ...t, isLife: dropLife ? false : t.isLife, isSpecial: dropSpecial ? false : t.isSpecial };
        saveCardTemplate(updated);
        return updated;
      }),
      ...newTemplates,
    ]);
  };

  // Delete Template from Library (using custom modal confirmation)
  const handleDeleteTemplate = async (id: string) => {
    showConfirm(
      'Eliminar Diseño',
      '¿Seguro que quieres eliminar esta carta del mazo?',
      async () => {
        await deleteCardTemplate(id);

        // Revoke ObjectURL to release memory
        const template = templates.find((t) => t.id === id);
        if (template?.imageUrl) {
          URL.revokeObjectURL(template.imageUrl);
        }

        setTemplates((prev) => prev.filter((t) => t.id !== id));
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

  // Marcar la carta Especial de un mazo (la guía de habilidades): solo una por mazo
  const handleUpdateTemplateSpecial = async (id: string, isSpecial: boolean) => {
    const deckId = templates.find((t) => t.id === id)?.deckId;
    setTemplates((prev) =>
      prev.map((t) => {
        const value = t.id === id ? isSpecial : t.deckId === deckId && isSpecial ? false : !!t.isSpecial;
        if (value === !!t.isSpecial) return t;
        const updated = { ...t, isSpecial: value };
        saveCardTemplate(updated);
        return updated;
      })
    );
  };

  // Marcar la carta de vida de un mazo (solo una por mazo)
  const handleUpdateTemplateLife = async (id: string, isLife: boolean) => {
    const deckId = templates.find((t) => t.id === id)?.deckId;
    setTemplates((prev) =>
      prev.map((t) => {
        const value = t.id === id ? isLife : t.deckId === deckId && isLife ? false : !!t.isLife;
        if (value === !!t.isLife) return t;
        const updated = { ...t, isLife: value };
        saveCardTemplate(updated);
        return updated;
      })
    );
  };


  if (mode === 'online' || !editUnlocked) {
    return (
      <OnlineMode
        initialCode={initialSala}
        localLibrary={{ templates, backUrls, deckNames }}
        editUnlocked={editUnlocked}
        onUnlockEdit={unlockEdit}
        onLockEdit={window.electronAPI ? undefined : lockEdit}
        onOpenSolo={() => setMode('solo')}
        onOpenLibrary={() => setMode('local')}
      />
    );
  }

  if (mode === 'solo') {
    // Esperar a la biblioteca para no borrar de la mesa cartas que aún no se han cargado
    if (!libraryLoaded) return null;
    return <SoloMode localLibrary={{ templates, backUrls, deckNames }} onOpenLibrary={() => setMode('local')} onOpenOnline={() => setMode('online')} />;
  }

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <DeckEditor
        templates={templates}
        deckNames={deckNames}
        backUrls={backUrls}
        onUpdateDeckName={handleUpdateDeckName}
        onCreateDeck={handleCreateDeck}
        onDeleteDeck={handleDeleteDeck}
        onAddTemplates={handleAddTemplates}
        onDeleteTemplate={handleDeleteTemplate}
        onUpdateTemplateDeck={handleUpdateTemplateDeck}
        onUpdateTemplateBackType={handleUpdateTemplateBackType}
        onUpdateTemplateQuantity={handleUpdateTemplateQuantity}
        onUpdateTemplateSpecial={handleUpdateTemplateSpecial}
        onUpdateTemplateLife={handleUpdateTemplateLife}
        onUploadBack={handleUploadBack}
        onDeleteBack={handleDeleteBack}
        showAlert={showAlert}
        onPlaySolo={() => setMode('solo')}
        onExit={isElectron ? undefined : () => setMode('online')}
        onImportServerDecks={() => handleImportServerDecks()}
        importProgress={importProgress}
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
