// Estado autoritativo de una partida online 1 contra 1.
// El servidor es el único que conoce qué carta es cada carta boca abajo, qué
// hay en cada biblioteca y en cada mano; a cada jugador solo se le envía su vista.
//
// Cada jugador tiene sus zonas: biblioteca, mano, cementerio y zona de juego.
// Las posiciones de la zona de juego se guardan relativas a esa zona y desde el
// punto de vista de su dueño, así ambos jugadores ven la mesa igual sea cual sea
// su resolución.

// Solo usa Web Crypto (globalThis.crypto): así el mismo motor funciona en el
// servidor (Node 22) y en el navegador para el modo un jugador.
const webcrypto = globalThis.crypto;
const randomHex = (bytes) => Array.from(webcrypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
const randomInt = (max) => {
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  do webcrypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return buf[0] % max;
};

export const SEATS = ['p1', 'p2'];
const LOG_LIMIT = 80;

// Medidas lógicas (deben coincidir con src/online/layout.ts)
export const BOARD_W = 1920;
export const BOARD_H = 1080;
export const PLAY_W = 1320;
export const PLAY_H = 320;
export const CARD_W = 130;
export const CARD_H = 206;
export const TOKEN_SIZE = 40;
const LIFE_MIN = 0;
const LIFE_MAX = 10;
const LIFE_START = 10;

const ZONES = ['library', 'hand', 'play', 'graveyard'];
const ZONE_NAMES = { library: 'su biblioteca', hand: 'su mano', play: 'su zona de juego', graveyard: 'su cementerio' };

const randomId = (prefix) => `${prefix}-${randomHex(6)}`;
const other = (seat) => (seat === 'p1' ? 'p2' : 'p1');
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export class Game {
  // free: modo un jugador, una sola persona mueve las cartas de los dos jugadores
  constructor(code, { free = false } = {}) {
    this.code = code;
    this.free = free;
    this.players = {}; // seat -> { name, token, deckId, connected, left }
    // Carta: { id, templateId, deckId, backType, isSpecial, owner, side, zone, order, x, y, isFaceUp, rotation }
    // owner = de quién es el mazo; side = en las zonas de qué jugador está
    this.cards = new Map();
    this.life = { p1: LIFE_START, p2: LIFE_START };
    this.tokens = []; // { id, x, y } en coordenadas del tablero vistas por p1
    // Quién juega el primer turno: al azar al crear la sala; cambia al terminar una partida
    this.starter = webcrypto.getRandomValues(new Uint8Array(1))[0] % 2 ? 'p2' : 'p1';
    this.seq = 0;
    this.log = [];
    this.rev = 0;
    this.lastActivity = Date.now();
  }

  // ---------- Jugadores ----------

  addPlayer(name) {
    const seat = SEATS.find((s) => !this.players[s]);
    if (!seat) return null;
    const token = randomHex(16);
    this.players[seat] = { name, token, deckId: null, connected: false, handRevealed: false };
    this.addLog(`${name} se ha unido a la sala.`);
    return { seat, token };
  }

  seatForToken(token) {
    return SEATS.find((s) => this.players[s] && this.players[s].token === token) || null;
  }

  nameOf(seat) {
    return this.players[seat]?.name || seat;
  }

  addLog(text, kind = 'event', by) {
    this.log.push({ id: randomId('log'), at: Date.now(), kind, text, ...(by ? { by } : {}) });
    if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);
  }

  bump() {
    this.rev++;
    this.lastActivity = Date.now();
  }

  // ---------- Consultas internas ----------

  zoneCards(side, zone) {
    return [...this.cards.values()].filter((c) => c.side === side && c.zone === zone).sort((a, b) => a.order - b.order);
  }

  topOf(side, zone) {
    const list = this.zoneCards(side, zone);
    return list[list.length - 1] || null;
  }

  nextOrder() {
    return ++this.seq;
  }

  // Cambia el id de una carta para que no se pueda seguir su rastro
  reId(card) {
    this.cards.delete(card.id);
    card.id = randomId('card');
    this.cards.set(card.id, card);
    return card;
  }

  // Ordena la biblioteca: barajada y con las especiales siempre arriba
  shuffleLibrary(side) {
    const list = shuffleInPlace(this.zoneCards(side, 'library'));
    list.sort((a, b) => Number(!!a.isSpecial) - Number(!!b.isSpecial));
    for (const c of list) {
      c.order = this.nextOrder();
      this.reId(c);
    }
    return list.length;
  }

  // ---------- Vista por jugador ----------

  viewFor(seat) {
    const opp = other(seat);
    const sideView = (side) => {
      const library = this.zoneCards(side, 'library');
      const top = library[library.length - 1];
      const hand = this.zoneCards(side, 'hand');
      return {
        library: { count: library.length, top: top ? { deckId: top.deckId, backType: top.backType } : null },
        // El cementerio está boca abajo: solo se envía el reverso
        graveyard: this.zoneCards(side, 'graveyard').map((c) => ({ id: c.id, deckId: c.deckId, backType: c.backType })),
        play: this.zoneCards(side, 'play').map((c) => {
          const v = { id: c.id, owner: c.owner, deckId: c.deckId, backType: c.backType, x: c.x, y: c.y, isFaceUp: c.isFaceUp, rotation: c.rotation, order: c.order };
          if (c.isFaceUp) v.templateId = c.templateId;
          return v;
        }),
        handCount: hand.length,
      };
    };

    const players = {};
    for (const s of SEATS) {
      const p = this.players[s];
      if (p) players[s] = { name: p.name, connected: p.connected, deckId: p.deckId, left: !!p.left, handRevealed: !!p.handRevealed };
    }

    return {
      code: this.code,
      you: seat,
      rev: this.rev,
      players,
      starter: this.starter,
      me: sideView(seat),
      opp: sideView(opp),
      hand: this.zoneCards(seat, 'hand').map((c) => ({ id: c.id, templateId: c.templateId, deckId: c.deckId, backType: c.backType })),
      // La mano del rival solo se ve si él ha decidido enseñarla
      oppHand: this.zoneCards(opp, 'hand').map((c) =>
        this.players[opp]?.handRevealed ? { deckId: c.deckId, backType: c.backType, templateId: c.templateId } : { deckId: c.deckId, backType: c.backType },
      ),
      life: { me: this.life[seat], opp: this.life[opp] },
      // Los tokens se guardan vistos por p1; a p2 se le dan girados 180º
      tokens: this.tokens.map((t) =>
        t.cardId || seat === 'p1' ? t : { id: t.id, x: BOARD_W - TOKEN_SIZE - t.x, y: BOARD_H - TOKEN_SIZE - t.y },
      ),
      log: this.log,
    };
  }

  // ---------- Acciones ----------
  // Cada acción devuelve { fx?, private? } o lanza un Error con un mensaje para el usuario.

  apply(seat, msg, library) {
    const fn = this[`act_${msg.t}`];
    if (typeof fn !== 'function') throw new Error('Acción desconocida');
    const result = fn.call(this, seat, msg, library) || {};
    this.bump();
    return result;
  }

  act_chooseDeck(seat, msg, library) {
    const deckId = String(msg.deckId || '');
    if (!library.deckNames[deckId]) throw new Error('Ese mazo no existe en el servidor');
    // En 1 vs 1 cada jugador usa un mazo distinto
    if (!this.free && this.players[other(seat)]?.deckId === deckId) throw new Error('Tu rival ya ha elegido ese mazo: elige otro');
    this.players[seat].deckId = deckId;
    this.addLog(`${this.nameOf(seat)} ha elegido el mazo "${library.deckNames[deckId]}".`);
  }

  // Pone el mazo elegido en la biblioteca (sustituye las cartas propias que hubiera)
  act_spawnDeck(seat, _msg, library) {
    const deckId = this.players[seat].deckId;
    if (!deckId) throw new Error('Elige primero un mazo');
    // La carta de vida no entra en la biblioteca: es el contador de vida
    const templates = library.templates.filter((t) => t.deckId === deckId && !t.isLife);
    if (templates.length === 0) throw new Error('El mazo elegido está vacío');

    for (const c of [...this.cards.values()]) if (c.owner === seat) this.cards.delete(c.id);
    this.tokens = this.tokens.filter((t) => !t.cardId || this.cards.has(t.cardId));

    let n = 0;
    for (const t of templates) {
      const qty = clamp(Number(t.quantity) || 1, 1, 60);
      for (let i = 0; i < qty; i++) {
        const card = {
          id: randomId('card'),
          templateId: t.id,
          deckId: t.deckId,
          backType: t.backType === 'backB' ? 'backB' : 'backA',
          isSpecial: !!t.isSpecial,
          owner: seat,
          side: seat,
          zone: 'library',
          order: 0,
          x: 0,
          y: 0,
          isFaceUp: false,
          rotation: 0,
        };
        this.cards.set(card.id, card);
        n++;
      }
    }
    this.shuffleLibrary(seat);
    this.addLog(`${this.nameOf(seat)} ha puesto su mazo barajado en la biblioteca (${n} cartas).`);
  }

  act_draw(seat, msg) {
    const count = clamp(Number(msg.count) || 1, 1, 10);
    let n = 0;
    for (let i = 0; i < count; i++) {
      const top = this.topOf(seat, 'library');
      if (!top) break;
      this.place(top, seat, 'hand');
      n++;
    }
    if (n === 0) throw new Error('Tu biblioteca está vacía');
    this.addLog(`${this.nameOf(seat)} ha robado ${n === 1 ? 'una carta' : `${n} cartas`}.`);
  }

  act_shuffleLibrary(seat) {
    const n = this.shuffleLibrary(seat);
    if (n) this.addLog(`${this.nameOf(seat)} ha barajado su biblioteca.`);
  }

  // Devuelve el cementerio a la biblioteca, barajado
  act_recycleGraveyard(seat) {
    const list = this.zoneCards(seat, 'graveyard');
    if (list.length === 0) throw new Error('El cementerio está vacío');
    for (const c of list) this.place(c, seat, 'library');
    this.shuffleLibrary(seat);
    this.addLog(`${this.nameOf(seat)} ha barajado su cementerio en la biblioteca (${list.length} cartas).`);
  }

  // Coloca una carta en una zona del jugador `side`
  place(card, side, zone, opts = {}) {
    const wasInPlay = card.zone === 'play';
    const oldId = card.id;
    card.side = side;
    card.zone = zone;
    card.order = this.nextOrder();
    if (zone === 'hand' || zone === 'library') {
      card.isFaceUp = false;
      card.rotation = 0;
    } else if (zone === 'graveyard') {
      // En el cementerio: boca abajo y girada 90º a la izquierda
      card.isFaceUp = false;
      card.rotation = -90;
    } else if (zone === 'play') {
      card.x = clamp(isNum(opts.x) ? opts.x : (PLAY_W - CARD_W) / 2, 0, PLAY_W - CARD_W);
      card.y = clamp(isNum(opts.y) ? opts.y : (PLAY_H - CARD_H) / 2, 0, PLAY_H - CARD_H);
      if (typeof opts.faceUp === 'boolean') card.isFaceUp = opts.faceUp;
      if (opts.resetRotation) card.rotation = 0;
    }
    this.reId(card);
    // Los tokens puestos en la carta la siguen en juego y desaparecen si sale de la mesa
    if (wasInPlay) {
      if (zone === 'play') for (const t of this.tokens) if (t.cardId === oldId) t.cardId = card.id;
      this.tokens = this.tokens.filter((t) => t.cardId !== oldId);
    }
    return card;
  }

  // Mover una carta: de cualquier zona pública (o de las propias ocultas) a una zona propia.
  // Solo se puede llevar a tus zonas; así se puede "robar" una carta del rival
  // a tu mano, zona de juego o cementerio, pero nunca sacarla de las zonas.
  act_move(seat, msg) {
    const to = String(msg.to || '');
    if (!ZONES.includes(to)) throw new Error('Zona no válida');

    let card;
    if (msg.from === 'library') {
      const libSide = this.free && SEATS.includes(msg.fromSide) ? msg.fromSide : seat;
      card = this.topOf(libSide, 'library');
      if (!card) throw new Error('Tu biblioteca está vacía');
    } else {
      card = this.cards.get(msg.id);
      if (!card) throw new Error('Esa carta ya no está ahí');
      const own = card.side === seat;
      const publicZone = card.zone === 'play' || card.zone === 'graveyard';
      if (!own && !publicZone && !this.free) throw new Error('No puedes coger esa carta');
      if (card.zone === 'library') throw new Error('Coge las cartas de la biblioteca desde arriba');
    }

    const fromZone = card.zone;
    const fromSide = card.side;

    // Reordenar dentro de tu propia zona de juego
    if (fromZone === 'play' && to === 'play' && fromSide === seat) {
      card.x = clamp(isNum(msg.x) ? msg.x : card.x, 0, PLAY_W - CARD_W);
      card.y = clamp(isNum(msg.y) ? msg.y : card.y, 0, PLAY_H - CARD_H);
      card.order = this.nextOrder();
      return { fx: { select: [card.id], by: seat } };
    }

    let faceUp;
    if (to === 'play') {
      if (fromZone === 'hand') faceUp = msg.faceUp !== false;
      else if (fromZone === 'library') faceUp = msg.faceUp === true;
      else if (fromZone === 'graveyard') faceUp = msg.faceUp !== false;
      else faceUp = card.isFaceUp;
    }
    this.place(card, seat, to, { x: msg.x, y: msg.y, faceUp, resetRotation: fromZone !== 'play' });

    // Registro
    const who = this.nameOf(seat);
    const fromText =
      fromSide === seat
        ? { library: 'de su biblioteca', hand: 'de su mano', play: 'de su zona de juego', graveyard: 'de su cementerio' }[fromZone]
        : { play: `de la zona de juego de ${this.nameOf(fromSide)}`, graveyard: `del cementerio de ${this.nameOf(fromSide)}` }[fromZone];
    let what = 'una carta';
    if (to === 'play' && card.isFaceUp) what = 'una carta boca arriba';
    if (to === 'play' && !card.isFaceUp) what = 'una carta boca abajo';
    this.addLog(`${who} ha movido ${what} ${fromText} a ${ZONE_NAMES[to]}.`);
    return { fx: to === 'play' ? { select: [card.id], by: seat } : undefined };
  }

  act_flip(seat, msg) {
    const c = this.cards.get(msg.id);
    if (!c || c.zone !== 'play' || c.side !== seat) throw new Error('Solo puedes voltear cartas de tu zona de juego');
    c.isFaceUp = !c.isFaceUp;
    this.addLog(`${this.nameOf(seat)} ha volteado una carta ${c.isFaceUp ? 'boca arriba' : 'boca abajo'}.`);
  }

  act_rotate(seat, msg) {
    const c = this.cards.get(msg.id);
    if (!c || c.zone !== 'play' || c.side !== seat) throw new Error('Solo puedes girar cartas de tu zona de juego');
    c.rotation += msg.deg === -90 ? -90 : 90;
  }

  // Reordenar la mano propia
  act_handOrder(seat, msg) {
    const ids = Array.isArray(msg.ids) ? msg.ids : [];
    ids.forEach((id) => {
      const c = this.cards.get(id);
      if (c && c.zone === 'hand' && c.side === seat) c.order = this.nextOrder();
    });
  }

  // Mirar en privado tu biblioteca o tu cementerio
  act_peek(seat, msg, library) {
    const zone = msg.zone === 'graveyard' ? 'graveyard' : 'library';
    const list = this.zoneCards(seat, zone).reverse(); // de arriba a abajo
    if (list.length === 0) throw new Error(zone === 'library' ? 'Tu biblioteca está vacía' : 'Tu cementerio está vacío');
    // La biblioteca vista por id permitiría seguir cartas: se renuevan al cerrar con "barajar"
    this.addLog(`${this.nameOf(seat)} está mirando ${zone === 'library' ? 'su biblioteca' : 'su cementerio'} (${list.length} cartas).`);
    const names = new Map(library.templates.map((t) => [t.id, t.name]));
    return {
      private: {
        t: 'peek',
        zone,
        cards: list.map((c) => ({ id: c.id, templateId: c.templateId, name: names.get(c.templateId) || '' })),
      },
    };
  }

  // Coger a la mano una carta concreta vista con "mirar"
  act_takeFromPeek(seat, msg) {
    const c = this.cards.get(msg.id);
    if (!c || c.side !== seat || (c.zone !== 'library' && c.zone !== 'graveyard')) throw new Error('Esa carta ya no está ahí');
    const from = c.zone === 'library' ? 'su biblioteca' : 'su cementerio';
    this.place(c, seat, 'hand');
    this.addLog(`${this.nameOf(seat)} ha cogido una carta de ${from} a su mano.`);
  }

  // Enseñar al rival una carta de la mano sin jugarla
  act_reveal(seat, msg, library) {
    const c = this.cards.get(msg.id);
    if (!c || c.zone !== 'hand' || c.side !== seat) throw new Error('Esa carta no está en tu mano');
    const t = library.templates.find((tp) => tp.id === c.templateId);
    this.addLog(`${this.nameOf(seat)} enseña una carta de su mano: ${t ? t.name : 'carta'}.`, 'reveal');
    return { fx: { reveal: { by: seat, templateId: c.templateId } } };
  }

  // Cada jugador solo puede cambiar su propio contador de vida
  act_life(seat, msg) {
    if (!isNum(msg.value)) return;
    const value = clamp(Math.round(msg.value), LIFE_MIN, LIFE_MAX);
    const prev = this.life[seat];
    if (value === prev) return;
    this.life[seat] = value;
    this.addLog(`${this.nameOf(seat)}: vida ${prev} → ${value}.`);
  }

  // Tokens: fichas que se ponen encima de las cartas. Las coordenadas llegan
  // desde el punto de vista de quien las mueve.
  toP1(seat, x, y) {
    const cx = clamp(x, 0, BOARD_W - TOKEN_SIZE);
    const cy = clamp(y, 0, BOARD_H - TOKEN_SIZE);
    return seat === 'p1' ? { x: cx, y: cy } : { x: BOARD_W - TOKEN_SIZE - cx, y: BOARD_H - TOKEN_SIZE - cy };
  }

  act_tokenAdd(seat, msg) {
    if (this.tokens.length >= 60) throw new Error('Hay demasiados tokens en la mesa');
    if (msg.cardId) {
      // Token fijado a una carta en juego
      const card = this.cards.get(msg.cardId);
      if (!card || card.zone !== 'play') throw new Error('Esa carta ya no está en juego');
      if (this.tokens.filter((t) => t.cardId === card.id).length >= 6) throw new Error('Esa carta ya tiene muchos tokens');
      // rx/ry: posición dentro de la carta (0-1), igual para los dos jugadores; nace abajo y se puede mover
      const n = this.tokens.filter((t) => t.cardId === card.id).length;
      this.tokens.push({ id: randomId('token'), cardId: card.id, rx: 0.8, ry: Math.max(0.1, 0.88 - n * 0.16) });
      this.addLog(`${this.nameOf(seat)} ha puesto un token en una carta.`);
      return;
    }
    const x = isNum(msg.x) ? msg.x : BOARD_W / 2 - TOKEN_SIZE / 2;
    const y = isNum(msg.y) ? msg.y : 600;
    const token = { id: randomId('token'), ...this.toP1(seat, x, y) };
    this.tokens.push(token);
    this.addLog(`${this.nameOf(seat)} ha añadido un token.`);
  }

  act_tokenMove(seat, msg) {
    const t = this.tokens.find((k) => k.id === msg.id);
    if (!t) return;
    if (t.cardId) {
      // Token de una carta: se mueve por encima de su carta
      if (isNum(msg.rx) && isNum(msg.ry)) Object.assign(t, { rx: clamp(msg.rx, 0, 1), ry: clamp(msg.ry, 0, 1) });
      return;
    }
    if (!isNum(msg.x) || !isNum(msg.y)) return;
    Object.assign(t, this.toP1(seat, msg.x, msg.y));
  }

  act_tokenDelete(seat, msg) {
    const before = this.tokens.length;
    this.tokens = this.tokens.filter((k) => k.id !== msg.id);
    if (this.tokens.length !== before) this.addLog(`${this.nameOf(seat)} ha quitado un token.`);
  }

  // Enseñar (o volver a ocultar) toda la mano al rival
  act_showHand(seat, msg) {
    const value = !!msg.value;
    if (this.players[seat].handRevealed === value) return;
    this.players[seat].handRevealed = value;
    this.addLog(`${this.nameOf(seat)} ${value ? 'enseña su mano al rival' : 'vuelve a ocultar su mano'}.`, value ? 'reveal' : 'event');
  }

  // Fin de partida: devuelve el resultado para guardarlo en el historial
  act_endMatch(seat, msg, library) {
    const winner = msg.winner === 'p1' || msg.winner === 'p2' ? msg.winner : 'draw';
    if (!this.players.p1 || !this.players.p2) throw new Error('Hacen falta dos jugadores para terminar una partida');
    const players = {};
    for (const s of SEATS) {
      const p = this.players[s];
      players[s] = { name: p.name, deck: p.deckId ? library.deckNames[p.deckId] || p.deckId : null };
    }
    const result = { id: randomId('match'), at: Date.now(), room: this.code, players, winner, by: this.nameOf(seat) };
    this.addLog(
      winner === 'draw' ? `${this.nameOf(seat)} ha terminado la partida: empate.` : `${this.nameOf(seat)} ha terminado la partida: gana ${this.nameOf(winner)}.`,
      'reveal',
    );
    // La siguiente partida la empieza el otro jugador
    this.starter = other(this.starter || 'p1');
    if (msg.reset) this.act_reset(seat);
    return { result, fx: { matchEnded: result } };
  }

  act_reset(seat) {
    for (const s of SEATS) if (this.players[s]) this.players[s].handRevealed = false;
    this.cards.clear();
    this.tokens = [];
    this.life = { p1: LIFE_START, p2: LIFE_START };
    this.addLog(`${this.nameOf(seat)} ha reiniciado la mesa (sin cartas ni tokens, vidas a ${LIFE_START}).`);
  }

  // Los jugadores pueden decidir entre ellos quién empieza
  act_toggleStarter(seat) {
    this.starter = other(this.starter || 'p1');
    this.addLog(`${this.nameOf(seat)} ha cambiado quién empieza: empieza ${this.nameOf(this.starter)}.`);
  }

  act_chat(seat, msg) {
    const text = String(msg.text || '').trim().slice(0, 300);
    if (!text) return;
    this.addLog(`${this.nameOf(seat)}: ${text}`, 'chat', seat);
  }
}
