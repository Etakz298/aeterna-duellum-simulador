import type { CardTemplate } from '../types';
import type { MatchResult, ServerLibrary } from './types';

const SERVER_KEY = 'online_server_url';

// La web publicada en el propio servidor usa su mismo origen; la app de
// escritorio usa la dirección guardada o la indicada al compilar.
export function isServedByGameServer(): boolean {
  return window.location.protocol.startsWith('http') && !import.meta.env.DEV;
}

export function getDefaultServerUrl(): string {
  if (isServedByGameServer()) return window.location.origin;
  const saved = localStorage.getItem(SERVER_KEY);
  if (saved) return saved;
  const fromEnv = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (fromEnv) return fromEnv;
  return import.meta.env.DEV ? 'http://localhost:8080' : '';
}

export function saveServerUrl(url: string) {
  localStorage.setItem(SERVER_KEY, url);
}

export function normalizeServerUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, '');
  if (u && !/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u;
}

export function toWebSocketUrl(serverUrl: string): string {
  return serverUrl.replace(/^http/i, 'ws') + '/ws';
}

export function inviteLink(serverUrl: string, code: string): string {
  return `${serverUrl}/?sala=${encodeURIComponent(code)}`;
}

export async function fetchLibrary(serverUrl: string): Promise<ServerLibrary> {
  const res = await fetch(`${serverUrl}/api/library`);
  if (!res.ok) throw new Error(`El servidor respondió ${res.status}`);
  const lib = (await res.json()) as ServerLibrary;
  // Las URLs de imágenes llegan relativas al servidor
  return {
    ...lib,
    templates: lib.templates.map((t) => ({
      ...t,
      imageUrl: t.imageUrl ? `${serverUrl}${t.imageUrl}` : undefined,
    })),
    backs: Object.fromEntries(Object.entries(lib.backs).map(([k, v]) => [k, `${serverUrl}${v}`])),
  };
}

export async function fetchResults(serverUrl: string): Promise<MatchResult[]> {
  const res = await fetch(`${serverUrl}/api/results`);
  if (!res.ok) throw new Error(`El servidor respondió ${res.status}`);
  return ((await res.json()) as { results: MatchResult[] }).results;
}

// ---------- Publicar la biblioteca local en el servidor ----------

const MAX_HEIGHT = 900;

async function toWebp(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error('No se pudo leer una imagen local');
  const bitmap = await createImageBitmap(await res.blob());
  const scale = Math.min(1, MAX_HEIGHT / bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No se pudo preparar la imagen');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No se pudo comprimir la imagen'))), 'image/webp', 0.85),
  );
}

export async function checkAdminKey(serverUrl: string, adminKey: string): Promise<void> {
  const res = await fetch(`${serverUrl}/api/admin/check`, { headers: { 'X-Admin-Key': adminKey } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Clave de administrador incorrecta');
  }
}

export async function publishLibrary(
  serverUrl: string,
  adminKey: string,
  local: { templates: CardTemplate[]; backUrls: Record<string, string>; deckNames: Record<string, string> },
  onProgress: (done: number, total: number) => void,
): Promise<void> {
  await checkAdminKey(serverUrl, adminKey);

  const jobs: { file: string; url: string }[] = [];
  const templates = local.templates.filter((t) => t.imageUrl && local.deckNames[t.deckId]);
  for (const t of templates) jobs.push({ file: `${t.id}.webp`, url: t.imageUrl! });
  const backs: Record<string, string> = {};
  for (const [key, url] of Object.entries(local.backUrls)) {
    if (!url) continue;
    backs[key] = `${key}.webp`;
    jobs.push({ file: `${key}.webp`, url });
  }

  let done = 0;
  onProgress(done, jobs.length);
  const queue = [...jobs];
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const blob = await toWebp(job.url);
      const res = await fetch(`${serverUrl}/api/library/images/${encodeURIComponent(job.file)}`, {
        method: 'PUT',
        headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'image/webp' },
        body: blob,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Error subiendo ${job.file}`);
      }
      onProgress(++done, jobs.length);
    }
  };
  await Promise.all([worker(), worker(), worker()]);

  const res = await fetch(`${serverUrl}/api/library`, {
    method: 'PUT',
    headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deckNames: local.deckNames,
      templates: templates.map((t) => ({
        id: t.id,
        name: t.name,
        deckId: t.deckId,
        backType: t.backType,
        quantity: t.quantity,
        isSpecial: !!t.isSpecial,
        image: `${t.id}.webp`,
      })),
      backs,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'El servidor no aceptó la biblioteca');
  }
}
