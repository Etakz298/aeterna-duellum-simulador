// Tipos mínimos para usar el motor desde el cliente (modo un jugador)
export const SEATS: string[];
export class Game {
  constructor(code: string, opts?: { free?: boolean });
  [key: string]: any;
}
