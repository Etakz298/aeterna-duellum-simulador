import { useEffect, useState } from 'react';

// Pantalla completa para quitar las barras del navegador en móvil y tablet.
// En iPhone el navegador no lo permite: allí se consigue abriendo la web desde
// un icono de la pantalla de inicio (ver manifest.webmanifest).

type FsDoc = Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => Promise<void> };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };

export const IOS_FULLSCREEN_HINT =
  'En iPhone no se puede desde el navegador: pulsa Compartir y "Añadir a pantalla de inicio". Al abrirlo desde ese icono se ve sin barras.';

export function fullscreenSupported(): boolean {
  const el = document.documentElement as FsEl;
  return !!(el.requestFullscreen || el.webkitRequestFullscreen);
}

export function isFullscreen(): boolean {
  const d = document as FsDoc;
  return !!(d.fullscreenElement || d.webkitFullscreenElement);
}

export async function toggleFullscreen(): Promise<boolean> {
  const d = document as FsDoc;
  const el = document.documentElement as FsEl;
  try {
    if (isFullscreen()) {
      await (d.exitFullscreen ? d.exitFullscreen() : d.webkitExitFullscreen?.());
      return true;
    }
    if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
    else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
    else return false;
    // En Android se puede fijar la orientación horizontal mientras dure
    const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    orientation?.lock?.('landscape').catch(() => {});
    return true;
  } catch {
    return false;
  }
}

export function useIsFullscreen(): boolean {
  const [fs, setFs] = useState(isFullscreen);
  useEffect(() => {
    const update = () => setFs(isFullscreen());
    document.addEventListener('fullscreenchange', update);
    document.addEventListener('webkitfullscreenchange', update);
    return () => {
      document.removeEventListener('fullscreenchange', update);
      document.removeEventListener('webkitfullscreenchange', update);
    };
  }, []);
  return fs;
}
