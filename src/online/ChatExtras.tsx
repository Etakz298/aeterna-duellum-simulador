import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Mic, Pause, Play, Send, Trash2 } from 'lucide-react';
import { appPoint, appRect } from '../rotation';

// ---------- Emojis ----------

export const EMOJIS = [
  '😂', '🤣', '😅', '😊', '😁', '😉', '😍', '😘',
  '😎', '🤔', '😏', '🙄', '😬', '😳', '😱', '🤯',
  '😡', '🤬', '😭', '😢', '🥲', '😴', '🥳', '🤡',
  '😈', '💀', '👀', '🫣', '🤐', '🤫', '🥶', '🤢',
  '👍', '👎', '👏', '🙌', '🙏', '💪', '🤝', '👋',
  '✌️', '🤞', '🫡', '👊', '🔥', '💥', '⚡', '✨',
  '🎉', '🏆', '⚔️', '🛡️', '🎲', '🍀', '❤️', '💔',
  '💯', '❓', '❗', '😮', '😤', '🤓', '😇', '🐐',
];

// Números del 0 al 9 (emojis de tecla)
export const NUMBER_EMOJIS = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
const KEYCAP = /[0-9#*]\ufe0f?\u20e3/gu;

// Mensaje formado solo por emojis (se ve grande, como en WhatsApp)
export function isEmojiOnly(text: string) {
  const keycaps = text.match(KEYCAP)?.length || 0;
  const t = text.replace(KEYCAP, '').trim();
  if (!t) return keycaps > 0 && keycaps <= 6;
  if (!/\p{Extended_Pictographic}/u.test(t)) return false;
  if (!/^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\u200d|\ufe0f|\s)+$/u.test(t)) return false;
  return keycaps + [...t.replace(/\s/g, '')].filter((c) => /\p{Extended_Pictographic}/u.test(c)).length <= 6;
}

export const EmojiPicker: React.FC<{ onPick: (emoji: string) => void; style?: React.CSSProperties; big?: boolean }> = ({ onPick, style, big }) => (
  <div
    className="glass-panel ol-emoji-picker"
    onPointerDown={(e) => e.stopPropagation()}
    style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(8, minmax(0, 1fr))',
      gap: 2,
      padding: 8,
      background: 'rgba(18,24,38,0.97)',
      boxShadow: '0 12px 30px rgba(0,0,0,0.55)',
      maxHeight: 250,
      overflowY: 'auto',
      overflowX: 'hidden',
      ...style,
    }}
  >
    <div style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: 'repeat(10, minmax(0, 1fr))', gap: 0, paddingBottom: 4, marginBottom: 4, borderBottom: '1px solid var(--glass-border)' }}>
      {NUMBER_EMOJIS.map((e) => (
        <button
          key={e}
          type="button"
          className="ol-emoji-btn"
          onClick={() => onPick(e)}
          style={{ fontSize: big ? 22 : 19, lineHeight: 1, padding: big ? '6px 0' : '5px 0', background: 'transparent', border: 'none', borderRadius: 8, cursor: 'pointer' }}
        >
          {e}
        </button>
      ))}
    </div>
    {EMOJIS.map((e) => (
      <button
        key={e}
        type="button"
        className="ol-emoji-btn"
        onClick={() => onPick(e)}
        style={{ fontSize: big ? 26 : 22, lineHeight: 1, padding: big ? 6 : 5, background: 'transparent', border: 'none', borderRadius: 8, cursor: 'pointer' }}
      >
        {e}
      </button>
    ))}
  </div>
);

// ---------- Grabar mensajes de voz ----------

export const VOICE_MAX_SECONDS = 60;
const WAVE_BARS = 40;

export interface VoiceClip {
  data: string; // data:audio/...;base64,...
  dur: number;
  wave: number[];
}

type Phase = 'idle' | 'starting' | 'recording';

export function useVoiceRecorder(onSend: (clip: VoiceClip) => void, onError: (message: string) => void) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [locked, setLockedState] = useState(false);
  const lockedAt = useRef(0);
  const setLocked = useCallback((v: boolean) => {
    lockedAt.current = Date.now();
    setLockedState(v);
  }, []);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const r = useRef<{
    rec?: MediaRecorder;
    stream?: MediaStream;
    ctx?: AudioContext;
    timer?: number;
    chunks: Blob[];
    levels: number[];
    startAt: number;
    send: boolean;
    abort: boolean;
  }>({ chunks: [], levels: [], startAt: 0, send: false, abort: false });
  const cbs = useRef({ onSend, onError });
  cbs.current = { onSend, onError };

  const cleanup = () => {
    const s = r.current;
    window.clearInterval(s.timer);
    s.stream?.getTracks().forEach((t) => t.stop());
    s.ctx?.close().catch(() => {});
    s.rec = s.stream = s.ctx = undefined;
    setPhase('idle');
    setLockedState(false);
    setElapsed(0);
    setLevel(0);
  };

  const start = useCallback(async () => {
    const s = r.current;
    if (s.rec || phase !== 'idle') return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      cbs.current.onError('Este navegador no permite grabar audio.');
      return;
    }
    s.abort = false;
    setPhase('starting');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      setPhase('idle');
      cbs.current.onError('No se ha podido usar el micrófono. Revisa el permiso del navegador.');
      return;
    }
    if (s.abort) {
      stream.getTracks().forEach((t) => t.stop());
      setPhase('idle');
      setLockedState(false);
      return;
    }
    const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'].find((m) => MediaRecorder.isTypeSupported?.(m));
    const rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 32000 });
    s.stream = stream;
    s.rec = rec;
    s.chunks = [];
    s.levels = [];
    // Volumen en directo para dibujar la onda
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      s.ctx = ctx;
      const buf = new Uint8Array(analyser.fftSize);
      s.timer = window.setInterval(() => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += ((v - 128) / 128) ** 2;
        const rms = Math.sqrt(sum / buf.length);
        s.levels.push(rms);
        setLevel(rms);
        const secs = (Date.now() - s.startAt) / 1000;
        setElapsed(secs);
        if (secs >= VOICE_MAX_SECONDS) stop(true);
      }, 80);
    } catch {
      s.timer = window.setInterval(() => {
        const secs = (Date.now() - s.startAt) / 1000;
        setElapsed(secs);
        if (secs >= VOICE_MAX_SECONDS) stop(true);
      }, 100);
    }
    rec.ondataavailable = (e) => e.data.size && s.chunks.push(e.data);
    rec.onstop = () => {
      const dur = (Date.now() - s.startAt) / 1000;
      const send = s.send;
      const blob = new Blob(s.chunks, { type: rec.mimeType || mime || 'audio/webm' });
      const wave = waveOf(s.levels);
      cleanup();
      if (!send || dur < 0.6 || !blob.size) return;
      const reader = new FileReader();
      reader.onload = () => cbs.current.onSend({ data: String(reader.result), dur: Math.min(dur, VOICE_MAX_SECONDS), wave });
      reader.readAsDataURL(blob);
    };
    s.startAt = Date.now();
    rec.start(250);
    setPhase('recording');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const stop = useCallback((send: boolean) => {
    const s = r.current;
    if (!s.rec) {
      // Aún esperando el permiso del micrófono
      s.abort = true;
      return;
    }
    s.send = send;
    if (s.rec.state !== 'inactive') s.rec.stop();
  }, []);

  useEffect(() => () => stop(false), [stop]);

  // El toque que fija la grabación no debe enviarla al soltar el dedo
  const sendLocked = useCallback(() => {
    if (Date.now() - lockedAt.current < 500) return;
    stop(true);
  }, [stop]);

  return { phase, locked, setLocked, elapsed, level, start, stop, sendLocked };
}

function waveOf(levels: number[]) {
  if (!levels.length) return Array(WAVE_BARS).fill(0.15);
  const out: number[] = [];
  for (let i = 0; i < WAVE_BARS; i++) {
    const a = Math.floor((i * levels.length) / WAVE_BARS);
    const b = Math.max(a + 1, Math.floor(((i + 1) * levels.length) / WAVE_BARS));
    out.push(Math.max(...levels.slice(a, b)));
  }
  const max = Math.max(0.02, ...out);
  return out.map((v) => Math.round(Math.max(0.18, Math.min(1, v / max)) * 100) / 100);
}

export const fmtSecs = (secs: number) => {
  const s = Math.max(0, Math.floor(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

type Recorder = ReturnType<typeof useVoiceRecorder>;

// Botón del micrófono: mantener pulsado graba y al soltar se envía; deslizar a la
// izquierda cancela; un toque corto deja la grabación fija con papelera y enviar.
export const MicButton: React.FC<{ rec: Recorder; size: number; style?: React.CSSProperties; onSlide: (dx: number) => void; className?: string }> = ({
  rec,
  size,
  style,
  onSlide,
  className = 'btn-secondary',
}) => {
  const hold = useRef<{ x: number; at: number } | null>(null);
  const busy = rec.phase !== 'idle';
  if (busy && rec.locked) {
    return (
      <button
        type="button"
        className="btn-primary"
        title="Enviar mensaje de voz"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => rec.sendLocked()}
        style={{ ...style, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#22c55e' }}
      >
        <Send size={size} />
      </button>
    );
  }
  return (
    <button
      type="button"
      className={`${className}${busy ? ' ol-mic-live' : ''}`}
      title="Mantén pulsado para grabar un mensaje de voz"
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        e.stopPropagation();
        e.preventDefault();
        if (busy) return;
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        hold.current = { x: appPoint(e.clientX, e.clientY).x, at: Date.now() };
        onSlide(0);
        rec.start();
      }}
      onPointerMove={(e) => {
        if (!hold.current) return;
        const dx = Math.min(0, appPoint(e.clientX, e.clientY).x - hold.current.x);
        onSlide(dx);
        if (dx < -100) {
          hold.current = null;
          onSlide(0);
          rec.stop(false);
        }
      }}
      onPointerUp={() => {
        if (!hold.current) return;
        const quick = Date.now() - hold.current.at < 350;
        hold.current = null;
        onSlide(0);
        if (quick) rec.setLocked(true);
        else rec.stop(true);
      }}
      onPointerCancel={() => {
        if (!hold.current) return;
        hold.current = null;
        onSlide(0);
        rec.stop(false);
      }}
      style={{ ...style, touchAction: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <Mic size={size} />
    </button>
  );
};

// Barra mientras se graba (como la de WhatsApp)
export const RecordingBar: React.FC<{ rec: Recorder; slide: number; style?: React.CSSProperties }> = ({ rec, slide, style }) => (
  <div
    className="ol-rec-bar"
    onPointerDown={(e) => e.stopPropagation()}
    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', borderRadius: 10, background: 'rgba(18,24,38,0.95)', border: '1px solid var(--glass-border)', color: '#fff', fontSize: 14, whiteSpace: 'nowrap', ...style }}
  >
    {rec.locked && (
      <button type="button" className="btn-secondary" title="Descartar" onClick={() => rec.stop(false)} style={{ padding: 6, display: 'flex' }}>
        <Trash2 size={16} />
      </button>
    )}
    <span className="ol-rec-dot" />
    <span style={{ fontVariantNumeric: 'tabular-nums', minWidth: 36 }}>{rec.phase === 'starting' ? '…' : fmtSecs(rec.elapsed)}</span>
    {rec.locked ? (
      <span style={{ display: 'flex', alignItems: 'center', gap: 2, height: 20 }}>
        {[0.6, 1, 0.75, 0.9, 0.5].map((k, i) => (
          <span key={i} style={{ width: 3, borderRadius: 2, background: '#ef4444', height: `${Math.max(15, Math.min(100, rec.level * 400 * k))}%`, transition: 'height 0.08s' }} />
        ))}
      </span>
    ) : (
      <span style={{ color: 'var(--text-muted)', transform: `translateX(${slide}px)`, opacity: Math.max(0.25, 1 + slide / 110) }}>‹ Desliza para cancelar</span>
    )}
  </div>
);

// ---------- Reproducir mensajes de voz ----------

const clips = new Map<string, HTMLAudioElement>();
const loading = new Map<string, Promise<HTMLAudioElement>>();
const subs = new Set<() => void>();
const notify = () => subs.forEach((f) => f());
let speed = 1;

function loadClip(id: string, url: string) {
  const ready = clips.get(id);
  if (ready) return Promise.resolve(ready);
  let p = loading.get(id);
  if (!p) {
    p = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error('audio');
        return res.blob();
      })
      .then((blob) => {
        const a = new Audio(URL.createObjectURL(blob));
        a.preload = 'auto';
        for (const ev of ['play', 'pause', 'ended', 'timeupdate', 'ratechange']) a.addEventListener(ev, notify);
        clips.set(id, a);
        return a;
      })
      .finally(() => loading.delete(id));
    loading.set(id, p);
  }
  return p;
}

export const VoiceMessage: React.FC<{
  id: string;
  url: string;
  dur: number;
  wave: number[];
  mine: boolean;
  heard?: boolean;
  color?: string;
  onPlayed?: () => void;
}> = ({ id, url, dur, wave, mine, heard, color = '#22c55e', onPlayed }) => {
  const [, force] = useReducer((n: number) => n + 1, 0);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    subs.add(force);
    return () => {
      subs.delete(force);
    };
  }, []);
  const audio = clips.get(id);
  const playing = !!audio && !audio.paused && !audio.ended;
  // Avance suave mientras suena
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      force();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);
  const total = audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : dur;
  const pos = audio ? audio.currentTime : 0;
  const progress = audio && (playing || pos > 0) && !audio.ended ? Math.min(1, pos / total) : 0;

  const toggle = async () => {
    if (busy) return;
    try {
      setBusy(true);
      const a = await loadClip(id, url);
      setBusy(false);
      if (!a.paused) return a.pause();
      for (const other of clips.values()) if (other !== a) other.pause();
      if (a.ended) a.currentTime = 0;
      a.playbackRate = speed;
      await a.play();
      if (!mine) onPlayed?.();
    } catch {
      setBusy(false);
      setFailed(true);
    }
  };
  const seek = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!audio) return;
    const r = appRect(e.currentTarget);
    const k = (appPoint(e.clientX, e.clientY).x - r.left) / r.width;
    audio.currentTime = Math.max(0, Math.min(1, k)) * total;
    force();
  };
  const bars = wave.length ? wave : Array(40).fill(0.3);
  // Verde: sin escuchar todavía; azul: escuchado (por ti o por el rival si es tuyo)
  const micColor = heard ? '#53bdeb' : mine ? 'var(--text-muted)' : '#25d366';

  return (
    <div
      className="ol-voice"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px 6px 6px', borderRadius: 12, background: mine ? 'rgba(34,197,94,0.16)' : 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.08)', minWidth: 210, maxWidth: 270 }}
    >
      <button
        type="button"
        onClick={toggle}
        title={playing ? 'Pausar' : 'Escuchar'}
        style={{ width: 34, height: 34, flexShrink: 0, borderRadius: '50%', border: 'none', background: color, color: '#0b1220', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', opacity: busy ? 0.6 : 1 }}
      >
        {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" style={{ marginLeft: 2 }} />}
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div onPointerDown={seek} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 2, height: 26, cursor: audio ? 'pointer' : 'default' }}>
          {bars.map((v, i) => (
            <span
              key={i}
              style={{ flex: 1, minWidth: 2, borderRadius: 2, height: `${Math.round(v * 100)}%`, background: (i + 0.5) / bars.length <= progress ? color : 'rgba(255,255,255,0.35)' }}
            />
          ))}
          {progress > 0 && <span style={{ position: 'absolute', left: `calc(${progress * 100}% - 5px)`, width: 10, height: 10, borderRadius: '50%', background: color, pointerEvents: 'none' }} />}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{failed ? 'No disponible' : fmtSecs(playing || progress > 0 ? pos : total)}</span>
          <span style={{ flex: 1 }} />
          {(playing || progress > 0) && (
            <button
              type="button"
              title="Velocidad"
              onClick={() => {
                speed = speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1;
                for (const a of clips.values()) a.playbackRate = speed;
                force();
              }}
              style={{ border: 'none', borderRadius: 10, padding: '0 6px', fontSize: 11, fontWeight: 700, background: 'rgba(255,255,255,0.18)', color: '#fff', cursor: 'pointer' }}
            >
              {speed}×
            </button>
          )}
          <Mic size={13} style={{ color: micColor }} />
        </div>
      </div>
    </div>
  );
};
