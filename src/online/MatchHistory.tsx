import React, { useEffect, useMemo, useState } from 'react';
import { Trophy, X } from 'lucide-react';
import type { MatchResult, Seat } from './types';
import { fetchResults } from './server';

type Filter = 'room' | 'today' | 'all';

interface Row {
  key: string;
  label: string;
  played: number;
  won: number;
  lost: number;
  draw: number;
}

const SEATS: Seat[] = ['p1', 'p2'];

// Suma victorias, derrotas y empates por jugador y por jugador + mazo
function summarize(list: MatchResult[]) {
  const byPlayer = new Map<string, Row>();
  const byDeck = new Map<string, Row>();
  const byChampion = new Map<string, Row>();
  const add = (map: Map<string, Row>, key: string, label: string, outcome: 'won' | 'lost' | 'draw') => {
    const row = map.get(key) || { key, label, played: 0, won: 0, lost: 0, draw: 0 };
    row.played++;
    row[outcome]++;
    map.set(key, row);
  };
  for (const m of list) {
    for (const s of SEATS) {
      const p = m.players[s];
      if (!p) continue;
      const outcome = m.winner === 'draw' ? 'draw' : m.winner === s ? 'won' : 'lost';
      add(byPlayer, p.name.toLowerCase(), p.name, outcome);
      const deck = p.deck || 'Sin mazo';
      add(byDeck, `${p.name.toLowerCase()}|${deck}`, `${p.name} con ${deck}`, outcome);
      add(byChampion, deck.toLowerCase(), deck, outcome);
    }
  }
  const sort = (rows: Row[]) => rows.sort((a, b) => b.won - a.won || a.lost - b.lost || b.played - a.played);
  return { players: sort([...byPlayer.values()]), decks: sort([...byDeck.values()]), champions: sort([...byChampion.values()]) };
}

// localResults: historial del modo un jugador (guardado en este ordenador)
export const MatchHistory: React.FC<{ serverUrl: string; roomCode?: string; localResults?: MatchResult[]; onClose: () => void }> = ({
  serverUrl,
  roomCode,
  localResults,
  onClose,
}) => {
  const solo = !!localResults;
  const [results, setResults] = useState<MatchResult[] | null>(localResults || null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>(roomCode ? 'room' : solo ? 'all' : 'today');

  useEffect(() => {
    if (solo) return;
    fetchResults(serverUrl)
      .then(setResults)
      .catch(() => setError('No se ha podido cargar el historial del servidor.'));
  }, [serverUrl, solo]);

  const list = useMemo(() => {
    if (!results) return [];
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    return results
      .filter((m) => (filter === 'room' ? m.room === roomCode : filter === 'today' ? m.at >= startOfDay.getTime() : true))
      .sort((a, b) => b.at - a.at);
  }, [results, filter, roomCode]);

  const summary = useMemo(() => summarize(list), [list]);

  const tab = (value: Filter, label: string) => (
    <button
      key={value}
      className={filter === value ? 'btn-primary' : 'btn-secondary'}
      onClick={() => setFilter(value)}
      style={{ padding: '6px 12px', fontSize: '0.8rem' }}
    >
      {label}
    </button>
  );

  const table = (title: string, rows: Row[]) => (
    <div>
      <h4 style={{ fontSize: '0.85rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>{title}</h4>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
        <thead>
          <tr style={{ color: 'var(--text-muted)', textAlign: 'right' }}>
            <th style={{ textAlign: 'left', fontWeight: 500, padding: '4px 0' }}></th>
            <th style={th}>Jugadas</th>
            <th style={th}>Ganadas</th>
            <th style={th}>Perdidas</th>
            <th style={th}>Empates</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.key} style={{ borderTop: '1px solid var(--glass-border)' }}>
              <td style={{ padding: '6px 0', fontWeight: i === 0 && r.won > 0 ? 700 : 400 }}>
                {i === 0 && r.won > 0 && <Trophy size={13} style={{ color: '#facc15', marginRight: 6, verticalAlign: -2 }} />}
                {r.label}
              </td>
              <td style={td}>{r.played}</td>
              <td style={{ ...td, color: 'var(--color-success)' }}>{r.won}</td>
              <td style={{ ...td, color: 'var(--color-danger)' }}>{r.lost}</td>
              <td style={td}>{r.draw}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div
      onPointerDown={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(5, 8, 16, 0.75)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 900000 }}
    >
      <div
        className="glass-panel"
        onPointerDown={(e) => e.stopPropagation()}
        style={{ width: 'min(640px, 94vw)', maxHeight: '88vh', overflowY: 'auto', padding: 24, borderRadius: 16, position: 'relative', display: 'flex', flexDirection: 'column', gap: 16, userSelect: 'text' }}
      >
        <button className="btn-secondary" onClick={onClose} style={{ position: 'absolute', top: 12, right: 12, padding: 4 }}>
          <X size={14} />
        </button>
        <h3 style={{ fontSize: '1.15rem', fontWeight: 700 }}>
          <Trophy size={18} style={{ color: '#facc15', marginRight: 8, verticalAlign: -3 }} />
          Historial de partidas
        </h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {roomCode && tab('room', `Esta sala (${roomCode})`)}
          {tab('today', 'Hoy')}
          {tab('all', 'Todas')}
        </div>
        {error && <p style={{ color: 'var(--color-danger)', fontSize: '0.85rem' }}>{error}</p>}
        {!error && !results && <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Cargando…</p>}
        {results && list.length === 0 && (
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            Todavía no hay partidas registradas aquí. Al acabar una partida, pulsa "Terminar partida" en el panel{solo ? '' : ' de la sala'}.
          </p>
        )}
        {list.length > 0 && (
          <>
            {table('Campeones', summary.champions)}
            {!solo && table('Jugadores', summary.players)}
            {!solo && table('Jugadores y mazos', summary.decks)}
            <div>
              <h4 style={{ fontSize: '0.85rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Partidas</h4>
              {list.map((m) => {
                const name = (s: Seat) =>
                  solo ? m.players[s].deck || m.players[s].name : `${m.players[s].name}${m.players[s].deck ? ` (${m.players[s].deck})` : ''}`;
                return (
                  <div key={m.id} style={{ borderTop: '1px solid var(--glass-border)', padding: '6px 0', fontSize: '0.82rem', display: 'flex', gap: 10 }}>
                    <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                      {new Date(m.at).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <span>
                      {m.winner === 'draw' ? (
                        <>
                          Empate entre {name('p1')} y {name('p2')}
                        </>
                      ) : (
                        <>
                          <strong>{name(m.winner)}</strong> gana a {name(m.winner === 'p1' ? 'p2' : 'p1')}
                        </>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

const th: React.CSSProperties = { fontWeight: 500, padding: '4px 0 4px 10px', textAlign: 'right' };
const td: React.CSSProperties = { padding: '6px 0 6px 10px', textAlign: 'right' };
