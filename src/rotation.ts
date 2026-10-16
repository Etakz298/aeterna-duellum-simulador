// Móviles: la aplicación siempre se ve en horizontal. Si el móvil está en
// vertical, todo se gira 90º (como si ya estuviera tumbado) y las coordenadas
// de los toques se pasan al sistema de la aplicación girada.

export const isPhone = () => {
  if (typeof window === 'undefined') return false;
  const coarse = !!window.matchMedia?.('(pointer: coarse)').matches;
  return coarse && Math.min(screen.width, screen.height) <= 540;
};

// Orientación del aparato, sin depender del alto visible (que cambia con el teclado)
const devicePortrait = () => {
  const type = screen.orientation?.type;
  if (type) return type.startsWith('portrait');
  const legacy = (window as unknown as { orientation?: number }).orientation;
  if (typeof legacy === 'number') return legacy % 180 === 0;
  return window.innerHeight > window.innerWidth;
};

let rotated = false;
let allowed = true; // los menús previos (sala online) se quedan en vertical
export const isRotated = () => rotated;

/** Permite o no girar la aplicación (solo se gira en la mesa de juego). */
export function setRotationAllowed(value: boolean) {
  if (allowed === value) return;
  allowed = value;
  applyOrientation();
}

/** Ajusta el giro y el alto visible; se llama al cargar y al cambiar el tamaño. */
export function applyOrientation() {
  const root = document.documentElement;
  rotated = allowed && isPhone() && devicePortrait() && window.innerHeight > window.innerWidth;
  root.classList.toggle('rot-landscape', rotated);
  root.style.setProperty('--app-w', `${rotated ? window.innerHeight : window.innerWidth}px`);
  root.style.setProperty('--app-h', `${rotated ? window.innerWidth : window.innerHeight}px`);
  root.classList.add('js-h');
}

/** Punto de pantalla (clientX/Y) en coordenadas de la aplicación. */
export function appPoint(x: number, y: number) {
  return rotated ? { x: y, y: window.innerWidth - x } : { x, y };
}

/** Rectángulo de un elemento en coordenadas de la aplicación. */
export function appRect(el: Element) {
  const r = el.getBoundingClientRect();
  if (!rotated) return { left: r.left, top: r.top, width: r.width, height: r.height };
  return { left: r.top, top: window.innerWidth - r.right, width: r.height, height: r.width };
}
