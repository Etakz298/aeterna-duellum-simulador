import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Globe, LogIn, Plus, Upload } from 'lucide-react';
import type { CardTemplate } from '../types';
import type { PeekCard, Seat, ServerLibrary, StateEffects } from './types';
import { OnlineTable } from './OnlineTable';
import { loadStoredSession, useOnlineGame } from './useOnlineGame';
import {
  fetchLibrary,
  getDefaultServerUrl,
  isServedByGameServer,
  normalizeServerUrl,
  publishLibrary,
  saveServerUrl,
} from './server';

interface OnlineModeProps {
  initialCode?: string;
  localLibrary: { templates: CardTemplate[]; backUrls: Record<string, string>; deckNames: Record<string, string> };
  onExit: () => void;
}

const EMPTY_LIBRARY: ServerLibrary = { deckNames: {}, templates: [], backs: {}, updatedAt: 0 };

export const OnlineMode: React.FC<OnlineModeProps> = ({ initialCode, localLibrary, onExit }) => {
  const [serverUrl, setServerUrl] = useState(getDefaultServerUrl);
  const [serverInput, setServerInput] = useState(serverUrl);
  const [name, setName] = useState(() => localStorage.getItem('online_name') || '');
  const [code, setCode] = useState(initialCode || '');
  const [library, setLibrary] = useState<ServerLibrary>(EMPTY_LIBRARY);
  const [libraryError, setLibraryError] = useState<string | null>(null);

  const [adminKey, setAdminKey] = useState(() => localStorage.getItem('online_admin_key') || '');
  const [publishing, setPublishing] = useState<{ done: number; total: number } | null>(null);
  const [showPublish, setShowPublish] = useState(false);
  // Biblioteca leída de la carpeta data/ del simulador (para publicar desde el navegador)
  const [folderLibrary, setFolderLibrary] = useState<OnlineModeProps['localLibrary'] | null>(null);

  const [shufflingIds, setShufflingIds] = useState<Set<string>>(new Set());
  const [selectRequest, setSelectRequest] = useState<string[] | null>(null);
  const [peek, setPeek] = useState<PeekCard[] | null>(null);
  const [reveal, setReveal] = useState<{ by: Seat; templateId: string } | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [modal, setModal] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null);

  const toast = useCallback((message: string) => {
    setToastMsg(message);
    window.setTimeout(() => setToastMsg((m) => (m === message ? null : m)), 3500);
  }, []);

  const handleEffects = useCallback((fx: StateEffects) => {
    if (fx.shuffle?.length) {
      const ids = new Set(fx.shuffle);
      setShufflingIds(ids);
      window.setTimeout(() => setShufflingIds(new Set()), 500);
    }
    if (fx.reveal) setReveal(fx.reveal);
    // Solo se selecciona automáticamente lo que ha hecho este jugador
    if (fx.select && fx.by === youRef.current) setSelectRequest(fx.select);
  }, []);
  const youRef = useRef<Seat | undefined>(undefined);

  const game = useOnlineGame({
    onEffects: handleEffects,
    onPeek: setPeek,
    onError: toast,
  });

  youRef.current = game.state?.you;

  const loadLibrary = useCallback(
    async (url: string) => {
      if (!url) return;
      try {
        setLibrary(await fetchLibrary(url));
        setLibraryError(null);
      } catch {
        setLibraryError('No se ha podido contactar con el servidor. Revisa la dirección.');
        setLibrary(EMPTY_LIBRARY);
      }
    },
    [],
  );

  useEffect(() => {
    loadLibrary(serverUrl);
  }, [serverUrl, loadLibrary]);

  // Reconectar a la partida en curso si se recarga la ventana
  useEffect(() => {
    const s = loadStoredSession();
    if (s && s.serverUrl === serverUrl && (!initialCode || initialCode === s.code)) {
      game.connect(serverUrl, { t: 'resume', code: s.code, token: s.token });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyServer = () => {
    const url = normalizeServerUrl(serverInput);
    setServerInput(url);
    setServerUrl(url);
    saveServerUrl(url);
  };

  const rememberName = () => {
    const n = name.trim() || 'Jugador';
    localStorage.setItem('online_name', n);
    return n;
  };

  const handleCreate = () => game.connect(serverUrl, { t: 'create', name: rememberName() });
  const handleJoin = () => {
    const c = code.trim().toUpperCase();
    if (!c) return toast('Escribe el código de la sala');
    game.connect(serverUrl, { t: 'join', code: c, name: rememberName() });
  };

  const handleLeave = () => {
    setModal({
      title: 'Salir de la partida',
      message: 'Saldrás de la sala online y volverás al modo un jugador. ¿Seguro?',
      onConfirm: () => {
        game.leave();
        clearSalaFromUrl();
        onExit();
      },
    });
  };

  const handlePublish = async () => {
    if (!adminKey) return toast('Escribe la clave de administrador del servidor');
    localStorage.setItem('online_admin_key', adminKey);
    setPublishing({ done: 0, total: 1 });
    try {
      await publishLibrary(serverUrl, adminKey, source, (done, total) => setPublishing({ done, total }));
      await loadLibrary(serverUrl);
      toast('Mazos publicados en el servidor');
      setShowPublish(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'No se pudieron publicar los mazos');
    } finally {
      setPublishing(null);
    }
  };

  const source = localLibrary.templates.length > 0 ? localLibrary : folderLibrary || localLibrary;
  const localCount = source.templates.length;

  // Lee db.json e imágenes de la carpeta data/ elegida por el usuario
  const handleDataFolder = async (files: FileList | null) => {
    if (!files) return;
    const list = Array.from(files);
    const dbFile = list.find((f) => f.name === 'db.json');
    if (!dbFile) return toast('No encuentro db.json: elige la carpeta "data" que está junto al .exe');
    try {
      const db = JSON.parse(await dbFile.text());
      const images = new Map(list.filter((f) => /\.(png|jpe?g|webp)$/i.test(f.name)).map((f) => [f.name, f]));
      const urlFor = (id: string) => {
        const f = images.get(`${id}.png`) || images.get(`${id}.jpg`) || images.get(`${id}.webp`);
        return f ? URL.createObjectURL(f) : undefined;
      };
      const templates: CardTemplate[] = (db.templates || []).map((t: CardTemplate) => ({ ...t, imageUrl: urlFor(t.id) }));
      const backUrls: Record<string, string> = {};
      for (const b of db.backs || []) {
        const u = urlFor(b.id);
        if (u) backUrls[b.id] = u;
      }
      setFolderLibrary({ templates: templates.filter((t) => t.imageUrl), backUrls, deckNames: db.deckNames || {} });
    } catch {
      toast('No se pudo leer db.json');
    }
  };
  const libraryDecks = Object.keys(library.deckNames).length;

  // Pinta la mesa cuando ya estamos en una sala
  if (game.state) {
    return (
      <>
        <OnlineTable
          state={game.state}
          status={game.status}
          library={library}
          serverUrl={serverUrl}
          send={game.send}
          moveItems={game.moveItems}
          flushMoves={game.flushMoves}
          patchState={(fn) => game.setState((s) => (s ? fn(s) : s))}
          shufflingIds={shufflingIds}
          selectRequest={selectRequest}
          peek={peek}
          onClosePeek={() => setPeek(null)}
          reveal={reveal}
          onCloseReveal={() => setReveal(null)}
          onReloadLibrary={() => loadLibrary(serverUrl)}
          onLeave={handleLeave}
          confirm={(title, message, onConfirm) => setModal({ title, message, onConfirm })}
          toast={toast}
        />
        {game.fatalError && (
          <ConfirmModal
            title="Partida cerrada"
            message={game.fatalError}
            confirmLabel="Volver"
            onConfirm={() => {
              game.leave();
              onExit();
            }}
          />
        )}
        {modal && (
          <ConfirmModal
            title={modal.title}
            message={modal.message}
            onCancel={() => setModal(null)}
            onConfirm={() => {
              setModal(null);
              modal.onConfirm();
            }}
          />
        )}
        {toastMsg && <Toast message={toastMsg} />}
      </>
    );
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    background: 'rgba(0,0,0,0.35)',
    color: '#fff',
    border: '1px solid var(--glass-border)',
    borderRadius: 8,
    padding: '10px 12px',
    fontSize: '0.9rem',
    fontFamily: 'var(--font-family)',
    outline: 'none',
  };
  const label: React.CSSProperties = { fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 6, display: 'block' };
  const busy = game.status === 'connecting' || game.status === 'reconnecting';

  return (
    <div className="tabletop-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default' }}>
      <div className="glass-panel" style={{ width: 'min(440px, 92vw)', padding: 28, display: 'flex', flexDirection: 'column', gap: 18, maxHeight: '94vh', overflowY: 'auto' }}>
        <div>
          <h1 style={{ fontSize: '1.4rem', fontWeight: 700, letterSpacing: '-0.5px' }}>
            Aeterna <span style={{ color: 'var(--color-accent)' }}>Duellum</span> · Online
          </h1>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 4 }}>
            Partida 1 contra 1. Cada jugador ve solo su propia mano; del rival solo ves cuántas cartas tiene.
          </p>
        </div>

        {!isServedByGameServer() && (
          <div>
            <span style={label}>Servidor</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                style={inputStyle}
                value={serverInput}
                placeholder="https://tu-app.up.railway.app"
                onChange={(e) => setServerInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && applyServer()}
              />
              <button className="btn-secondary" onClick={applyServer} style={{ padding: '8px 12px', fontSize: '0.8rem' }}>
                <Globe size={14} /> Usar
              </button>
            </div>
          </div>
        )}

        <div style={{ fontSize: '0.8rem', color: libraryError ? 'var(--color-danger)' : 'var(--text-muted)' }}>
          {!serverUrl
            ? 'Indica la dirección del servidor para empezar.'
            : libraryError
              ? libraryError
              : libraryDecks
                ? `Mazos disponibles en el servidor: ${Object.values(library.deckNames).join(', ')}`
                : 'El servidor todavía no tiene mazos publicados.'}
        </div>

        <div>
          <label style={label}>Tu nombre</label>
          <input style={inputStyle} value={name} maxLength={20} placeholder="Nombre que verá tu rival" onChange={(e) => setName(e.target.value)} />
        </div>

        <button className="btn-primary" disabled={busy || !serverUrl || !!libraryError} onClick={handleCreate} style={{ padding: 12, fontSize: '0.95rem' }}>
          <Plus size={16} /> Crear sala nueva
        </button>

        <div>
          <label style={label}>¿Tienes un código de sala?</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              style={{ ...inputStyle, textTransform: 'uppercase', letterSpacing: 3, fontWeight: 700 }}
              value={code}
              maxLength={5}
              placeholder="ABCDE"
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
            />
            <button className="btn-secondary" disabled={busy || !serverUrl || !!libraryError} onClick={handleJoin} style={{ padding: '8px 16px', fontSize: '0.9rem' }}>
              <LogIn size={14} /> Unirse
            </button>
          </div>
        </div>

        {busy && <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Conectando…</div>}
        {game.fatalError && <div style={{ fontSize: '0.85rem', color: 'var(--color-danger)' }}>{game.fatalError}</div>}

        {serverUrl && !libraryError && (
          <div style={{ borderTop: '1px solid var(--glass-border)', paddingTop: 14 }}>
            {!showPublish ? (
              <button className="btn-secondary" onClick={() => setShowPublish(true)} style={{ width: '100%', padding: 8, fontSize: '0.8rem' }}>
                <Upload size={14} /> Publicar mis mazos en el servidor
              </button>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {localLibrary.templates.length === 0 && (
                  <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.45 }}>
                    Elige la carpeta <strong>data</strong> que está junto al .exe del simulador:
                    <input
                      type="file"
                      // @ts-expect-error atributo no estándar para elegir carpetas
                      webkitdirectory=""
                      multiple
                      onChange={(e) => handleDataFolder(e.target.files)}
                      style={{ display: 'block', marginTop: 6, color: '#fff' }}
                    />
                  </label>
                )}
                {localCount > 0 && <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.45 }}>
                  Sube tus {Object.keys(source.deckNames).length} mazos ({localCount} diseños) para que ambos jugadores puedan usarlos.
                  Las imágenes se reducen antes de subirlas. Sustituye lo que hubiera publicado antes.
                </p>}
                <input
                  style={inputStyle}
                  type="password"
                  value={adminKey}
                  placeholder="Clave de administrador (ADMIN_KEY)"
                  onChange={(e) => setAdminKey(e.target.value)}
                />
                <button className="btn-primary" disabled={!!publishing || localCount === 0} onClick={handlePublish} style={{ padding: 10, fontSize: '0.85rem' }}>
                  {publishing ? `Subiendo… ${publishing.done}/${publishing.total}` : 'Publicar ahora'}
                </button>
              </div>
            )}
          </div>
        )}

        <button
          className="btn-secondary"
          onClick={() => {
            clearSalaFromUrl();
            onExit();
          }}
          style={{ padding: 8, fontSize: '0.8rem' }}
        >
          <ArrowLeft size={14} /> Volver al modo un jugador
        </button>
      </div>
      {toastMsg && <Toast message={toastMsg} />}
    </div>
  );
};

function clearSalaFromUrl() {
  const url = new URL(window.location.href);
  if (url.searchParams.has('sala')) {
    url.searchParams.delete('sala');
    window.history.replaceState(null, '', url.toString());
  }
}

const Toast: React.FC<{ message: string }> = ({ message }) => (
  <div
    className="glass-panel"
    style={{
      position: 'fixed',
      bottom: 210,
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: 500000,
      padding: '10px 18px',
      fontSize: '0.85rem',
      border: '1px solid var(--color-accent)',
      maxWidth: '80vw',
      wordBreak: 'break-all',
    }}
  >
    {message}
  </div>
);

const ConfirmModal: React.FC<{
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel?: () => void;
}> = ({ title, message, confirmLabel, onConfirm, onCancel }) => (
  <div
    style={{
      position: 'fixed',
      inset: 0,
      background: 'rgba(5, 8, 16, 0.75)',
      backdropFilter: 'blur(8px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 999999,
    }}
  >
    <div className="glass-panel" style={{ width: '90%', maxWidth: 400, padding: 24, borderRadius: 16 }}>
      <h3 style={{ fontSize: '1.15rem', fontWeight: 700, color: '#fff', marginBottom: 12 }}>{title}</h3>
      <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: 24 }}>{message}</p>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
        {onCancel && (
          <button className="btn-secondary" onClick={onCancel} style={{ padding: '8px 16px', fontSize: '0.85rem' }}>
            Cancelar
          </button>
        )}
        <button className="btn-primary" onClick={onConfirm} style={{ padding: '8px 16px', fontSize: '0.85rem' }}>
          {confirmLabel || 'Confirmar'}
        </button>
      </div>
    </div>
  </div>
);
