import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Swords, Trophy, X } from 'lucide-react';
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

// Colores: resultado (ganadas / empates / perdidas) y series de la gráfica (orden fijo)
const WIN = '#0ca30c';
const DRAW = '#5b6475';
const LOSS = '#d03b3b';
const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500'];

const pct = (r: Row) => (r.played ? Math.round((r.won / r.played) * 100) : 0);

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
  const sort = (rows: Row[]) => rows.sort((a, b) => pct(b) - pct(a) || b.won - a.won || a.lost - b.lost || b.played - a.played);
  return { players: sort([...byPlayer.values()]), decks: sort([...byDeck.values()]), champions: sort([...byChampion.values()]) };
}

// Victorias acumuladas partida a partida (en orden cronológico) para los más activos
function cumulative(list: MatchResult[], keyOf: (m: MatchResult, s: Seat) => string | null, rows: Row[]) {
  const top = [...rows].sort((a, b) => b.played - a.played).slice(0, SERIES.length);
  const chrono = [...list].sort((a, b) => a.at - b.at);
  const series = top.map((r, i) => ({ key: r.key, label: r.label, color: SERIES[i], values: [0] as number[] }));
  for (const m of chrono) {
    for (const sr of series) {
      const won = m.winner !== 'draw' && keyOf(m, m.winner) === sr.key;
      sr.values.push(sr.values[sr.values.length - 1] + (won ? 1 : 0));
    }
  }
  return { series, matches: chrono };
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
  const [showAll, setShowAll] = useState(false);

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
  // En un jugador interesan los campeones; online, los jugadores
  const chart = useMemo(
    () =>
      solo
        ? cumulative(list, (m, s) => (m.players[s]?.deck || 'Sin mazo').toLowerCase(), summary.champions)
        : cumulative(list, (m, s) => m.players[s]?.name.toLowerCase() || null, summary.players),
    [list, solo, summary],
  );
  const draws = list.filter((m) => m.winner === 'draw').length;
  const bestChampion = summary.champions.find((r) => r.played > 0);
  const bestPlayer = summary.players.find((r) => r.played > 0);

  const tab = (value: Filter, label: string) => (
    <button
      key={value}
      className={filter === value ? 'btn-primary' : 'btn-secondary'}
      onClick={() => {
        setFilter(value);
        setShowAll(false);
      }}
      style={{ padding: '6px 14px', fontSize: '0.8rem', borderRadius: 999 }}
    >
      {label}
    </button>
  );

  const shown = showAll ? list : list.slice(0, 8);

  return (
    <div
      onPointerDown={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(5, 8, 16, 0.78)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 900000 }}
    >
      <div
        className="glass-panel mh-panel"
        onPointerDown={(e) => e.stopPropagation()}
        style={{
          width: 'min(780px, calc(var(--app-w, 100vw) * 0.95))',
          maxHeight: 'calc(var(--app-h, 100vh) * 0.92)',
          overflowY: 'auto',
          padding: '20px 22px 24px',
          borderRadius: 18,
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
          userSelect: 'text',
        }}
      >
        <button className="btn-secondary" onClick={onClose} style={{ position: 'absolute', top: 14, right: 14, padding: 6 }} title="Cerrar">
          <X size={16} />
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', paddingRight: 40 }}>
          <h3 style={{ fontSize: '1.2rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8, marginRight: 'auto' }}>
            <Trophy size={20} style={{ color: '#facc15' }} />
            Historial de partidas
          </h3>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {roomCode && tab('room', `Esta sala`)}
            {tab('today', 'Hoy')}
            {tab('all', 'Todas')}
          </div>
        </div>

        {error && <p style={{ color: 'var(--color-danger)', fontSize: '0.85rem' }}>{error}</p>}
        {!error && !results && <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Cargando…</p>}
        {results && list.length === 0 && (
          <div style={{ textAlign: 'center', padding: '28px 12px', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
            <Swords size={34} style={{ opacity: 0.4, marginBottom: 8 }} />
            <p>
              Todavía no hay partidas registradas aquí. Al acabar una partida, pulsa "Terminar partida" en el panel{solo ? '' : ' de la sala'}.
            </p>
          </div>
        )}

        {list.length > 0 && (
          <>
            {/* Cifras clave */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
              <Tile label="Partidas" value={String(list.length)} sub={draws ? `${draws} ${draws === 1 ? 'empate' : 'empates'}` : 'sin empates'} />
              {bestChampion && <Tile label="Mejor campeón" value={bestChampion.label} sub={`${pct(bestChampion)}% de victorias · ${bestChampion.won} de ${bestChampion.played}`} accent />}
              {!solo && bestPlayer && <Tile label="Mejor jugador" value={bestPlayer.label} sub={`${pct(bestPlayer)}% de victorias · ${bestPlayer.won} de ${bestPlayer.played}`} accent />}
            </div>

            {/* Gráfica */}
            {chart.matches.length >= 2 && chart.series.length > 0 && (
              <Section title="Victorias acumuladas" hint={solo ? 'Por campeón, partida a partida' : 'Por jugador, partida a partida'}>
                <WinsChart series={chart.series} matches={chart.matches} />
              </Section>
            )}

            <Section title="Campeones" legend>
              <Bars rows={summary.champions} />
            </Section>
            {!solo && (
              <Section title="Jugadores" legend>
                <Bars rows={summary.players} />
              </Section>
            )}
            {!solo && summary.decks.length > summary.players.length && (
              <Section title="Jugadores y mazos" legend>
                <Bars rows={summary.decks} />
              </Section>
            )}

            {/* Partidas */}
            <Section title="Últimas partidas">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {shown.map((m) => {
                  const name = (s: Seat) => (solo ? m.players[s].deck || m.players[s].name : m.players[s].name);
                  const deck = (s: Seat) => (solo ? null : m.players[s].deck);
                  const draw = m.winner === 'draw';
                  const w: Seat = draw ? 'p1' : (m.winner as Seat);
                  const l: Seat = w === 'p1' ? 'p2' : 'p1';
                  return (
                    <div
                      key={m.id}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'auto 1fr auto 1fr',
                        alignItems: 'center',
                        gap: 10,
                        padding: '8px 12px',
                        borderRadius: 10,
                        background: 'rgba(255,255,255,0.04)',
                        borderLeft: `3px solid ${draw ? DRAW : WIN}`,
                        fontSize: '0.85rem',
                      }}
                    >
                      <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                        {new Date(m.at).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <Side name={name(w)} deck={deck(w)} tag={draw ? undefined : 'Gana'} strong={!draw} />
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontWeight: 700, letterSpacing: 1 }}>{draw ? 'EMPATE' : 'VS'}</span>
                      <Side name={name(l)} deck={deck(l)} muted={!draw} />
                    </div>
                  );
                })}
              </div>
              {list.length > 8 && (
                <button className="btn-secondary" onClick={() => setShowAll((v) => !v)} style={{ marginTop: 8, padding: '6px 12px', fontSize: '0.8rem', alignSelf: 'flex-start' }}>
                  {showAll ? 'Ver menos' : `Ver las ${list.length} partidas`}
                </button>
              )}
            </Section>
          </>
        )}
      </div>
    </div>
  );
};

const Tile: React.FC<{ label: string; value: string; sub: string; accent?: boolean }> = ({ label, value, sub, accent }) => (
  <div
    style={{
      padding: '12px 14px',
      borderRadius: 12,
      background: accent ? 'linear-gradient(135deg, rgba(250,204,21,0.12), rgba(255,255,255,0.03))' : 'rgba(255,255,255,0.05)',
      border: `1px solid ${accent ? 'rgba(250,204,21,0.25)' : 'var(--glass-border)'}`,
      minWidth: 0,
    }}
  >
    <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: 0.6, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 5 }}>
      {accent && <Trophy size={12} style={{ color: '#facc15' }} />}
      {label}
    </div>
    <div style={{ fontSize: '1.45rem', fontWeight: 700, lineHeight: 1.2, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</div>
    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>
  </div>
);

const Section: React.FC<{ title: string; hint?: string; legend?: boolean; children: React.ReactNode }> = ({ title, hint, legend, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column' }}>
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
      <h4 style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.8, fontWeight: 600 }}>{title}</h4>
      {hint && <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', opacity: 0.75 }}>{hint}</span>}
      {legend && (
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 12, fontSize: '0.72rem', color: 'var(--text-muted)' }}>
          {[
            ['Ganadas', WIN],
            ['Empates', DRAW],
            ['Perdidas', LOSS],
          ].map(([l, c]) => (
            <span key={l} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 10, height: 10, borderRadius: 3, background: c }} />
              {l}
            </span>
          ))}
        </span>
      )}
    </div>
    {children}
  </div>
);

// Una fila por campeón o jugador: % de victorias y barra ganadas / empates / perdidas
const Bars: React.FC<{ rows: Row[] }> = ({ rows }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    {rows.map((r, i) => {
      const parts = [
        { n: r.won, c: WIN, l: 'ganadas' },
        { n: r.draw, c: DRAW, l: 'empates' },
        { n: r.lost, c: LOSS, l: 'perdidas' },
      ].filter((p) => p.n > 0);
      return (
        <div key={r.key} style={{ display: 'grid', gridTemplateColumns: 'minmax(90px, 30%) 1fr 52px', alignItems: 'center', gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: '0.9rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6 }}>
              {i === 0 && r.won > 0 && <Trophy size={13} style={{ color: '#facc15', flexShrink: 0 }} />}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.label}</span>
            </div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
              {r.won} G · {r.draw} E · {r.lost} P
            </div>
          </div>
          <div style={{ display: 'flex', gap: 2, height: 14 }} title={`${r.won} ganadas, ${r.draw} empates, ${r.lost} perdidas de ${r.played}`}>
            {parts.map((p, k) => (
              <div
                key={p.l}
                className="mh-bar"
                style={{
                  flex: p.n,
                  background: p.c,
                  borderRadius: `${k === 0 ? 4 : 0}px ${k === parts.length - 1 ? 4 : 0}px ${k === parts.length - 1 ? 4 : 0}px ${k === 0 ? 4 : 0}px`,
                }}
              />
            ))}
          </div>
          <div style={{ textAlign: 'right', fontWeight: 700, fontSize: '1.05rem', fontVariantNumeric: 'tabular-nums' }}>{pct(r)}%</div>
        </div>
      );
    })}
  </div>
);

const Side: React.FC<{ name: string; deck: string | null; tag?: string; strong?: boolean; muted?: boolean }> = ({ name, deck, tag, strong, muted }) => (
  <div style={{ minWidth: 0, opacity: muted ? 0.7 : 1 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      {tag && <Trophy size={13} style={{ color: '#facc15', flexShrink: 0 }} />}
      <span style={{ fontWeight: strong ? 700 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
      {tag && (
        <span style={{ fontSize: '0.65rem', fontWeight: 700, padding: '1px 6px', borderRadius: 6, background: 'rgba(12,163,12,0.18)', color: '#4ade80', flexShrink: 0 }}>{tag}</span>
      )}
    </div>
    {deck && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{deck}</div>}
  </div>
);

// Gráfica de líneas: victorias acumuladas (un solo eje), con leyenda, etiqueta al final y detalle al pasar
const WinsChart: React.FC<{ series: { key: string; label: string; color: string; values: number[] }[]; matches: MatchResult[] }> = ({ series, matches }) => {
  const W = 720;
  const H = 220;
  const pad = { l: 34, r: 92, t: 12, b: 26 };
  const n = matches.length;
  const maxY = Math.max(1, ...series.flatMap((s) => s.values));
  const x = (i: number) => pad.l + (i / n) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / maxY) * (H - pad.t - pad.b);
  const ticks = Array.from(new Set([0, Math.round(maxY / 2), maxY]));
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const pick = (e: React.PointerEvent) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return;
    // La vista puede estar girada en el móvil: se usa el lado largo del rectángulo
    const rotated = r.height > r.width;
    const k = rotated ? (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width;
    const px = k * W;
    setHover(Math.max(1, Math.min(n, Math.round(((px - pad.l) / (W - pad.l - pad.r)) * n))));
  };
  // Etiquetas al final de cada línea sin pisarse
  const ends = series.map((s) => ({ s, y: y(s.values[n]) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
  const m = hover ? matches[hover - 1] : null;
  return (
    // En pantallas bajas (móvil) la gráfica se estrecha para no ocupar toda la ventana
    <div style={{ position: 'relative', width: `min(100%, calc(var(--app-h, 100vh) * 0.45 * ${W / H}))`, margin: '0 auto' }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height: 'auto', display: 'block', touchAction: 'pan-y' }}
        onPointerMove={pick}
        onPointerDown={pick}
        onPointerLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="rgba(255,255,255,0.08)" />
            <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill="rgba(255,255,255,0.45)">
              {t}
            </text>
          </g>
        ))}
        <text x={pad.l} y={H - 6} fontSize={11} fill="rgba(255,255,255,0.45)">
          Primera
        </text>
        <text x={W - pad.r} y={H - 6} textAnchor="end" fontSize={11} fill="rgba(255,255,255,0.45)">
          Última partida
        </text>
        {hover && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} stroke="rgba(255,255,255,0.3)" strokeDasharray="3 3" />}
        {series.map((s) => (
          <polyline
            key={s.key}
            className="mh-line"
            points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')}
            fill="none"
            stroke={s.color}
            strokeWidth={2.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            pathLength={1}
          />
        ))}
        {series.map((s) => (
          <circle key={s.key} cx={x(hover ?? n)} cy={y(s.values[hover ?? n])} r={4.5} fill={s.color} stroke="#131a29" strokeWidth={2} />
        ))}
        {ends.map(({ s, y: ly }) => (
          <text key={s.key} x={W - pad.r + 10} y={ly + 4} fontSize={12} fontWeight={600} fill="rgba(255,255,255,0.85)">
            {s.label.length > 11 ? `${s.label.slice(0, 10)}…` : s.label}
          </text>
        ))}
      </svg>
      {series.length > 1 && (
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4 }}>
          {series.map((s) => (
            <span key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 14, height: 3, borderRadius: 2, background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      {m && hover && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: `${(x(hover) / W) * 100}%`,
            transform: `translateX(${x(hover) > W / 2 ? 'calc(-100% - 10px)' : '10px'})`,
            background: 'rgba(10,14,24,0.95)',
            border: '1px solid var(--glass-border)',
            borderRadius: 8,
            padding: '6px 10px',
            fontSize: '0.75rem',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
            boxShadow: '0 8px 20px rgba(0,0,0,0.5)',
          }}
        >
          <div style={{ color: 'var(--text-muted)', marginBottom: 3 }}>
            Partida {hover} · {new Date(m.at).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
          </div>
          {series.map((s) => (
            <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.color }} />
              <span style={{ flex: 1 }}>{s.label}</span>
              <strong style={{ marginLeft: 10 }}>{s.values[hover]}</strong>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
