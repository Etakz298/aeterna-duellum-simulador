import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, Gamepad2, Globe, History, KeyRound, Lock, LogIn, LogOut, Maximize, Minimize, PenLine, Plus, Swords, Upload } from 'lucide-react';
import { IOS_FULLSCREEN_HINT, fullscreenSupported, toggleFullscreen, useIsFullscreen } from '../fullscreen';
import type { CardTemplate } from '../types';
import type { GameMode, MultiState, PeekResult, Seat, ServerLibrary, StateEffects } from './types';
import { OnlineTable } from './OnlineTable';
import { MultiTable } from './MultiTable';
import { setRotationAllowed } from '../rotation';
import { MatchHistory } from './MatchHistory';
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
  editUnlocked: boolean;
  onUnlockEdit: (key: string) => Promise<void>;
  onLockEdit?: () => void;
  onOpenSolo: () => void;
  onOpenLibrary: () => void;
}

const EMPTY_LIBRARY: ServerLibrary = { deckNames: {}, templates: [], backs: {}, updatedAt: 0 };

export const OnlineMode: React.FC<OnlineModeProps> = ({ initialCode, localLibrary, editUnlocked, onUnlockEdit, onLockEdit, onOpenSolo, onOpenLibrary }) => {
  const [serverUrl, setServerUrl] = useState(getDefaultServerUrl);
  const [serverInput, setServerInput] = useState(serverUrl);
  const [name, setName] = useState(() => localStorage.getItem('online_name') || '');
  const [code, setCode] = useState(initialCode || '');
  // Tipo de partida al crear la sala: 1 contra 1, 3 jugadores o 2 contra 2
  const [mode, setMode] = useState<GameMode>('duel');
  // Al entrar con un enlace de invitación solo se ofrece unirse a esa sala
  const [invited, setInvited] = useState(() => !!initialCode);
  const [library, setLibrary] = useState<ServerLibrary>(EMPTY_LIBRARY);
  const [libraryError, setLibraryError] = useState<string | null>(null);

  const [adminKey, setAdminKey] = useState(() => localStorage.getItem('online_admin_key') || '');
  const [publishing, setPublishing] = useState<{ done: number; total: number } | null>(null);
  const [showEdit, setShowEdit] = useState(false);
  const [editKey, setEditKey] = useState('');
  const [checking, setChecking] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  // Biblioteca leída de la carpeta data/ del simulador (para publicar desde el navegador)
  const [folderLibrary, setFolderLibrary] = useState<OnlineModeProps['localLibrary'] | null>(null);

  const [selectRequest, setSelectRequest] = useState<string[] | null>(null);
  const [peek, setPeek] = useState<PeekResult | null>(null);
  const [reveal, setReveal] = useState<{ by: Seat; templateId: string } | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const fullscreen = useIsFullscreen();
  const [modal, setModal] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null);

  const toast = useCallback((message: string) => {
    setToastMsg(message);
    window.setTimeout(() => setToastMsg((m) => (m === message ? null : m)), 3500);
  }, []);

  const handleEffects = useCallback((fx: StateEffects) => {
    if (fx.reveal) setReveal(fx.reveal);
    if (fx.matchEnded) {
      const m = fx.matchEnded;
      toast(m.winner === 'draw' ? 'Partida registrada: empate' : `Partida registrada: gana ${m.players[m.winner].name}`);
    }
    if (fx.multiEnded) toast(fx.multiEnded.label ? `Partida terminada: gana ${fx.multiEnded.label}` : 'Partida terminada: empate');
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

  // En el móvil, la sala online se ve en vertical; solo la mesa de juego se gira
  const inTable = !!game.state;
  useEffect(() => setRotationAllowed(inTable), [inTable]);
  useEffect(() => () => setRotationAllowed(true), []);

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

  const handleCreate = () => game.connect(serverUrl, { t: 'create', name: rememberName(), mode });
  const handleJoin = () => {
    const c = code.trim().toUpperCase();
    if (!c) return toast('Escribe el código de la sala');
    game.connect(serverUrl, { t: 'join', code: c, name: rememberName() });
  };

  const handleLeave = () => {
    setModal({
      title: 'Salir de la partida',
      message: 'Saldrás de la sala y volverás al menú online. Tu rival verá que has abandonado la partida. ¿Seguro?',
      onConfirm: () => {
        game.leave();
        clearSalaFromUrl();
        setCode('');
        setInvited(false);
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
    // Partidas de 3 y 4 jugadores: su propia mesa
    const multi = 'sides' in game.state ? (game.state as unknown as MultiState) : null;
    return (
      <>
        {multi ? (
          <MultiTable
            state={multi}
            status={game.status}
            library={library}
            serverUrl={serverUrl}
            send={game.send}
            patchState={(fn) => game.setState((s) => (s ? (fn(s as unknown as MultiState) as unknown as typeof s) : s))}
            selectRequest={selectRequest}
            peek={peek}
            onClosePeek={() => setPeek(null)}
            onPeekTaken={(id) => setPeek((p) => (p ? { ...p, cards: p.cards.filter((c) => c.id !== id) } : p))}
            reveal={reveal}
            onCloseReveal={() => setReveal(null)}
            onReloadLibrary={() => loadLibrary(serverUrl)}
            onLeave={handleLeave}
            confirm={(title, message, onConfirm) => setModal({ title, message, onConfirm })}
            toast={toast}
          />
        ) : (
        <OnlineTable
          state={game.state}
          status={game.status}
          library={library}
          serverUrl={serverUrl}
          send={game.send}
          patchState={(fn) => game.setState((s) => (s ? fn(s) : s))}
          selectRequest={selectRequest}
          peek={peek}
          onClosePeek={() => setPeek(null)}
          onPeekTaken={(id) => setPeek((p) => (p ? { ...p, cards: p.cards.filter((c) => c.id !== id) } : p))}
          reveal={reveal}
          onCloseReveal={() => setReveal(null)}
          onReloadLibrary={() => loadLibrary(serverUrl)}
          onLeave={handleLeave}
          confirm={(title, message, onConfirm) => setModal({ title, message, onConfirm })}
          toast={toast}
        />
        )}
        {game.fatalError && (
          <ConfirmModal
            title="Partida cerrada"
            message={game.fatalError}
            confirmLabel="Volver"
            onConfirm={() => {
              game.leave();
              clearSalaFromUrl();
              setCode('');
              setInvited(false);
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
    borderRadius: 10,
    padding: '12px 14px',
    fontSize: '1rem',
    fontFamily: 'var(--font-family)',
    outline: 'none',
  };
  const label: React.CSSProperties = { fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 6, display: 'block', fontWeight: 600, letterSpacing: 0.3 };
  const busy = game.status === 'connecting' || game.status === 'reconnecting';
  const blocked = busy || !serverUrl || !!libraryError;

  const nameField = (
    <div>
      <label style={label}>Tu nombre</label>
      <input
        style={inputStyle}
        value={name}
        maxLength={20}
        placeholder="Nombre que verá tu rival"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (invited ? handleJoin() : handleCreate())}
      />
    </div>
  );

  return (
    <div className="tabletop-container landing" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default', overflowY: 'auto' }}>
      <button
        className="btn-secondary"
        title="Pantalla completa"
        style={{ position: 'absolute', top: 14, right: 14, padding: 9 }}
        onClick={async () => {
          if (!fullscreenSupported()) return toast(IOS_FULLSCREEN_HINT);
          if (!(await toggleFullscreen())) toast('El navegador no ha permitido la pantalla completa');
        }}
      >
        {fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
      </button>

      <div style={{ width: 'min(420px, 92vw)', display: 'flex', flexDirection: 'column', gap: 22, padding: '28px 0' }}>
        <div style={{ textAlign: 'center' }}>
          <div className="landing-emblem">
            <Swords size={30} />
          </div>
          <h1 style={{ fontSize: '2rem', fontWeight: 800, letterSpacing: '-0.8px', lineHeight: 1.1, marginTop: 14 }}>
            Aeterna <span className="landing-accent">Duellum</span>
          </h1>
          <p style={{ fontSize: '0.92rem', color: 'var(--text-muted)', marginTop: 8 }}>Duelos online: 1 contra 1, 3 jugadores o 2 contra 2</p>
        </div>

        <div className="glass-panel" style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 16, borderRadius: 18 }}>
          {invited ? (
            <>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Te han invitado a la sala</div>
                <div className="landing-code">{code.trim().toUpperCase()}</div>
              </div>
              {nameField}
              <button className="btn-primary landing-big" disabled={blocked} onClick={handleJoin}>
                <LogIn size={18} /> Unirse a la partida
              </button>
              <button
                className="btn-secondary"
                onClick={() => {
                  setInvited(false);
                  setCode('');
                  clearSalaFromUrl();
                }}
                style={{ padding: 8, fontSize: '0.8rem', background: 'transparent', border: 'none', color: 'var(--text-muted)' }}
              >
                Crear otra partida
              </button>
            </>
          ) : (
            <>
              {nameField}
              <div className="landing-modes" role="radiogroup" aria-label="Tipo de partida">
                {(
                  [
                    ['duel', '1 contra 1'],
                    ['ffa3', '3 jugadores'],
                    ['team4', '2 contra 2'],
                  ] as [GameMode, string][]
                ).map(([m, text]) => (
                  <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? 'landing-mode landing-mode-on' : 'landing-mode'} onClick={() => setMode(m)}>
                    {text}
                  </button>
                ))}
              </div>
              <button className="btn-primary landing-big" disabled={blocked} onClick={handleCreate}>
                <Plus size={18} /> Crear partida
              </button>
              <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textAlign: 'center', marginTop: -6 }}>
                {mode === 'duel' ? 'Te daremos un enlace para invitar a tu rival' : mode === 'ffa3' ? 'Todos contra todos: invita a dos jugadores más' : 'Por parejas: invita a tres jugadores más'}
              </div>
              <div className="landing-or">o únete con un código</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  style={{ ...inputStyle, textTransform: 'uppercase', letterSpacing: 4, fontWeight: 700, textAlign: 'center' }}
                  value={code}
                  maxLength={5}
                  placeholder="CÓDIGO"
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
                />
                <button className="btn-secondary" disabled={blocked} onClick={handleJoin} style={{ padding: '8px 18px', fontSize: '0.95rem', flexShrink: 0 }}>
                  <LogIn size={16} /> Unirse
                </button>
              </div>
            </>
          )}
          {busy && <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', textAlign: 'center' }}>Conectando…</div>}
          {game.fatalError && <div style={{ fontSize: '0.85rem', color: 'var(--color-danger)', textAlign: 'center' }}>{game.fatalError}</div>}
          {(libraryError || !serverUrl) && (
            <div style={{ fontSize: '0.8rem', color: 'var(--color-danger)', textAlign: 'center' }}>
              {libraryError || 'Indica la dirección del servidor para empezar.'}
            </div>
          )}
          {serverUrl && !libraryError && !libraryDecks && (
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textAlign: 'center' }}>El servidor todavía no tiene mazos publicados.</div>
          )}
        </div>

        {!isServedByGameServer() && (
          <div>
            <span style={label}>Servidor</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                style={{ ...inputStyle, fontSize: '0.85rem', padding: '9px 12px' }}
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

        <div style={{ display: 'flex', justifyContent: 'center', gap: 10 }}>
          {serverUrl && !libraryError && (
            <button className="btn-secondary landing-link" onClick={() => setShowHistory(true)}>
              <History size={15} /> Historial
            </button>
          )}
          <button className="btn-secondary landing-link" onClick={() => setShowEdit(true)}>
            {editUnlocked ? <PenLine size={15} /> : <Lock size={15} />} Edición
          </button>
        </div>
      </div>

      {showEdit && (
        <div
          onPointerDown={() => !publishing && setShowEdit(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(5, 8, 16, 0.75)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 900000 }}
        >
          <div
            className="glass-panel"
            onPointerDown={(e) => e.stopPropagation()}
            style={{ width: 'min(380px, 90vw)', padding: 22, display: 'flex', flexDirection: 'column', gap: 12, maxHeight: '92vh', overflowY: 'auto' }}
          >
            {!editUnlocked ? (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!editKey) return;
                  setChecking(true);
                  try {
                    await onUnlockEdit(editKey);
                    setAdminKey(editKey);
                    setEditKey('');
                  } catch (err) {
                    toast(err instanceof Error ? err.message : 'Clave incorrecta');
                  } finally {
                    setChecking(false);
                  }
                }}
                style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
              >
                <h3 style={{ fontSize: '1.1rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <KeyRound size={18} /> Edición
                </h3>
                <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', lineHeight: 1.45 }}>
                  Escribe la clave de administrador para abrir el modo un jugador y el editor de mazos.
                </p>
                <input autoFocus type="password" style={inputStyle} value={editKey} placeholder="Clave" onChange={(e) => setEditKey(e.target.value)} />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" className="btn-secondary" onClick={() => setShowEdit(false)} style={{ flex: 1, padding: 10 }}>
                    Cancelar
                  </button>
                  <button type="submit" className="btn-primary" disabled={checking || !editKey} style={{ flex: 1, padding: 10 }}>
                    {checking ? 'Comprobando…' : 'Entrar'}
                  </button>
                </div>
              </form>
            ) : (
              <>
                <h3 style={{ fontSize: '1.1rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <PenLine size={18} /> Edición
                </h3>
                <button className="btn-primary" onClick={onOpenSolo} style={{ padding: 12, fontSize: '0.95rem' }}>
                  <Gamepad2 size={17} /> Modo un jugador
                </button>
                <button className="btn-secondary" onClick={onOpenLibrary} style={{ padding: 12, fontSize: '0.95rem' }}>
                  <BookOpen size={17} /> Editor de mazos
                </button>
                {serverUrl && !libraryError && (
                  <div style={{ borderTop: '1px solid var(--glass-border)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
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
                    {localCount > 0 && (
                      <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.45 }}>
                        Sube tus {Object.keys(source.deckNames).length} mazos ({localCount} diseños) para que ambos jugadores puedan usarlos.
                        Sustituye lo que hubiera publicado antes.
                      </p>
                    )}
                    <button className="btn-secondary" disabled={!!publishing || localCount === 0} onClick={handlePublish} style={{ padding: 10, fontSize: '0.85rem' }}>
                      <Upload size={15} /> {publishing ? `Subiendo… ${publishing.done}/${publishing.total}` : 'Publicar mis mazos en el servidor'}
                    </button>
                  </div>
                )}
                {onLockEdit && (
                  <button
                    className="btn-secondary"
                    onClick={() => {
                      onLockEdit();
                      setShowEdit(false);
                    }}
                    style={{ padding: 8, fontSize: '0.8rem', background: 'transparent', border: 'none', color: 'var(--text-muted)' }}
                  >
                    <LogOut size={14} /> Salir de la edición
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
      {toastMsg && <Toast message={toastMsg} />}
      {showHistory && <MatchHistory serverUrl={serverUrl} onClose={() => setShowHistory(false)} />}
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

export const Toast: React.FC<{ message: string }> = ({ message }) => (
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

export const ConfirmModal: React.FC<{
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
