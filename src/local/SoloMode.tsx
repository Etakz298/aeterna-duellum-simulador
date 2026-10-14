import React, { useCallback, useState } from 'react';
import type { CardTemplate } from '../types';
import { OnlineTable } from '../online/OnlineTable';
import { ConfirmModal, Toast } from '../online/OnlineMode';
import { loadSoloResults, useLocalGame } from './useLocalGame';

// Modo un jugador con la misma mesa que el 1 vs 1: una persona juega con los
// dos lados, ve las dos manos y guarda el historial en este ordenador.
export const SoloMode: React.FC<{
  localLibrary: { templates: CardTemplate[]; backUrls: Record<string, string>; deckNames: Record<string, string> };
  onOpenLibrary: () => void;
  onOpenOnline: () => void;
}> = ({ localLibrary, onOpenLibrary, onOpenOnline }) => {
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [modal, setModal] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null);

  const toast = useCallback((message: string) => {
    setToastMsg(message);
    window.setTimeout(() => setToastMsg((m) => (m === message ? null : m)), 3500);
  }, []);

  const game = useLocalGame(localLibrary, {
    onError: toast,
    onMatchEnded: (m) => {
      const champ = (s: 'p1' | 'p2') => m.players[s].deck || m.players[s].name;
      toast(m.winner === 'draw' ? 'Partida registrada: empate' : `Partida registrada: gana ${champ(m.winner)}`);
    },
  });

  return (
    <>
      <OnlineTable
        solo
        state={game.state}
        status="open"
        library={game.library}
        serverUrl=""
        send={game.send}
        patchState={game.patchState}
        selectRequest={game.selectRequest}
        peek={game.peek}
        onClosePeek={() => game.setPeek(null)}
        onPeekTaken={(id) => game.setPeek((p) => (p ? { ...p, cards: p.cards.filter((c) => c.id !== id) } : p))}
        reveal={null}
        onCloseReveal={() => {}}
        onReloadLibrary={() => {}}
        onLeave={onOpenLibrary}
        onOpenOnline={onOpenOnline}
        confirm={(title, message, onConfirm) => setModal({ title, message, onConfirm })}
        toast={toast}
        localResults={loadSoloResults}
      />
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
};
