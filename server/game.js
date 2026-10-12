// Estado autoritativo de una partida online 1 contra 1.
// El servidor es el único que conoce qué carta es cada carta boca abajo y qué
// hay en cada mano; a cada jugador solo se le envía su propia vista.

import crypto from 'node:crypto';

export const SEATS = ['p1', 'p2'];
const LOG_LIMIT = 80;

// Posiciones iniciales del mazo de cada jugador sobre la mesa
const SPAWN = {
  p1: { x: 260, y: 520 },
  p2: { x: 1000, y: 150 },
};

const randomId = (prefix) => `${prefix}-${crypto.randomBytes(6).toString('hex')}`;

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const clampCoord = (n) => Math.max(-2000, Math.min(7000, n));

export class Game {
  constructor(code) {
    this.code = code;
    this.players = {}; // seat -> { name, token, deckId, connected }
    this.cards = new Map(); // id -> card (board o mano)
    this.counters = [];
    this.nextZ = 10;
    this.log = [];
    this.rev = 0;
    this.lastActivity = Date.now();
  }

  // ---------- Jugadores ----------

  addPlayer(name) {
    const seat = SEATS.find((s) => !this.players[s]);
    if (!seat) return null;
    const token = crypto.randomBytes(16).toString('hex');
    this.players[seat] = { name, token, deckId: null, connected: false };

    // Contador de vida propio para cada jugador
    this.nextZ++;
    this.counters.push({
      id: randomId('counter'),
      x: seat === 'p1' ? 100 : 820,
      y: seat === 'p1' ? 520 : 180,
      value: 10,
      label: name.slice(0, 12).toUpperCase(),
      zIndex: this.nextZ,
    });

    this.addLog(`${name} se ha unido a la sala.`);
    return { seat, token };
  }

  seatForToken(token) {
    return SEATS.find((s) => this.players[s] && this.players[s].token === token) || null;
  }

  nameOf(seat) {
    return this.players[seat]?.name || seat;
  }

  addLog(text, kind = 'event') {
    this.log.push({ id: randomId('log'), at: Date.now(), kind, text });
    if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);
  }

  // ---------- Vista por jugador ----------

  viewFor(seat) {
    const other = seat === 'p1' ? 'p2' : 'p1';
    const board = [];
    const hand = [];
    const oppHand = [];

    for (const c of this.cards.values()) {
      if (c.zone === 'board') {
        const base = {
          id: c.id,
          owner: c.owner,
          deckId: c.deckId,
          backType: c.backType,
          x: c.x,
          y: c.y,
          isFaceUp: c.isFaceUp,
          rotation: c.rotation,
          zIndex: c.zIndex,
        };
        // Las cartas boca abajo no revelan su diseño a ningún cliente
        if (c.isFaceUp) base.templateId = c.templateId;
        board.push(base);
      } else if (c.zone === 'hand' && c.owner === seat) {
        hand.push({ id: c.id, templateId: c.templateId, deckId: c.deckId, backType: c.backType, order: c.order });
      } else if (c.zone === 'hand' && c.owner === other) {
        // Del rival solo se envía el reverso: ni id ni diseño
        oppHand.push({ deckId: c.deckId, backType: c.backType, order: c.order });
      }
    }

    hand.sort((a, b) => a.order - b.order);
    oppHand.sort((a, b) => a.order - b.order);

    const players = {};
    for (const s of SEATS) {
      const p = this.players[s];
      if (!p) continue;
      players[s] = {
        name: p.name,
        connected: p.connected,
        deckId: p.deckId,
        handCount: [...this.cards.values()].filter((c) => c.zone === 'hand' && c.owner === s).length,
        left: !!p.left,
      };
    }

    return {
      code: this.code,
      you: seat,
      rev: this.rev,
      players,
      cards: board,
      hand: hand.map(({ order: _o, ...rest }) => rest),
      oppHand: oppHand.map(({ order: _o, ...rest }) => rest),
      counters: this.counters,
      log: this.log,
    };
  }

  // ---------- Utilidades internas ----------

  boardCards(ids) {
    const set = new Set(Array.isArray(ids) ? ids : []);
    return [...this.cards.values()].filter((c) => c.zone === 'board' && set.has(c.id));
  }

  bump() {
    this.rev++;
    this.lastActivity = Date.now();
  }

  // Cambia el id de una carta para que no se pueda seguir su rastro
  reId(card) {
    this.cards.delete(card.id);
    card.id = randomId('card');
    this.cards.set(card.id, card);
    return card;
  }

  nextHandOrder(seat) {
    let max = 0;
    for (const c of this.cards.values()) if (c.zone === 'hand' && c.owner === seat) max = Math.max(max, c.order || 0);
    return max + 1;
  }

  // ---------- Acciones ----------
  // Cada acción devuelve { ok, fx?, private? } o lanza un Error con mensaje para el usuario.

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
    this.players[seat].deckId = deckId;
    this.addLog(`${this.nameOf(seat)} ha elegido el mazo "${library.deckNames[deckId]}".`);
  }

  act_spawnDeck(seat, _msg, library) {
    const deckId = this.players[seat].deckId;
    if (!deckId) throw new Error('Elige primero un mazo');
    const templates = library.templates.filter((t) => t.deckId === deckId);
    if (templates.length === 0) throw new Error('El mazo elegido está vacío');

    const pile = [];
    for (const t of templates) {
      const qty = Math.max(1, Math.min(60, Number(t.quantity) || 1));
      for (let i = 0; i < qty; i++) pile.push(t);
    }
    shuffleInPlace(pile);

    const { x, y } = SPAWN[seat];
    const ids = [];
    for (const t of pile) {
      this.nextZ++;
      const card = {
        id: randomId('card'),
        templateId: t.id,
        deckId: t.deckId,
        backType: t.backType === 'backB' ? 'backB' : 'backA',
        owner: seat,
        zone: 'board',
        x,
        y,
        isFaceUp: false,
        rotation: 0,
        zIndex: this.nextZ,
      };
      this.cards.set(card.id, card);
      ids.push(card.id);
    }
    this.addLog(`${this.nameOf(seat)} ha puesto su mazo barajado en la mesa (${pile.length} cartas).`);
    return { fx: { shuffle: ids } };
  }

  act_move(_seat, msg) {
    const updates = Array.isArray(msg.updates) ? msg.updates.slice(0, 300) : [];
    for (const u of updates) {
      const c = this.cards.get(u?.id);
      if (!c || c.zone !== 'board' || !isNum(u.x) || !isNum(u.y)) continue;
      c.x = clampCoord(u.x);
      c.y = clampCoord(u.y);
    }
  }

  act_front(_seat, msg) {
    const list = this.boardCards(msg.ids).sort((a, b) => a.zIndex - b.zIndex);
    for (const c of list) c.zIndex = ++this.nextZ;
  }

  act_flip(seat, msg) {
    const list = this.boardCards(msg.ids);
    for (const c of list) c.isFaceUp = !c.isFaceUp;
    if (list.length) this.addLog(`${this.nameOf(seat)} ha volteado ${list.length === 1 ? 'una carta' : `${list.length} cartas`}.`);
  }

  act_rotate(_seat, msg) {
    const deg = msg.deg === -90 ? -90 : 90;
    for (const c of this.boardCards(msg.ids)) c.rotation += deg;
  }

  act_shuffle(seat, msg) {
    const list = this.boardCards(msg.ids);
    if (list.length <= 1) return {};
    const avgX = list.reduce((s, c) => s + c.x, 0) / list.length;
    const avgY = list.reduce((s, c) => s + c.y, 0) / list.length;
    shuffleInPlace(list);
    const ids = [];
    for (const c of list) {
      c.x = avgX;
      c.y = avgY;
      c.zIndex = ++this.nextZ;
      this.reId(c);
      ids.push(c.id);
    }
    this.addLog(`${this.nameOf(seat)} ha barajado ${list.length} cartas.`);
    return { fx: { shuffle: ids, select: ids } };
  }

  act_delete(seat, msg) {
    const cards = this.boardCards(msg.cardIds);
    for (const c of cards) this.cards.delete(c.id);
    const counterIds = new Set(Array.isArray(msg.counterIds) ? msg.counterIds : []);
    const before = this.counters.length;
    this.counters = this.counters.filter((c) => !counterIds.has(c.id));
    const removedCounters = before - this.counters.length;
    if (cards.length || removedCounters) {
      const parts = [];
      if (cards.length) parts.push(cards.length === 1 ? 'una carta' : `${cards.length} cartas`);
      if (removedCounters) parts.push(removedCounters === 1 ? 'un contador' : `${removedCounters} contadores`);
      this.addLog(`${this.nameOf(seat)} ha retirado de la mesa ${parts.join(' y ')}.`);
    }
  }

  // Mover cartas concretas de la mesa a la mano
  act_toHand(seat, msg) {
    const list = this.boardCards(msg.ids).sort((a, b) => b.zIndex - a.zIndex);
    if (list.length === 0) return {};
    const faceDown = list.filter((c) => !c.isFaceUp).length;
    let order = this.nextHandOrder(seat);
    for (const c of list) {
      c.zone = 'hand';
      c.owner = seat;
      c.order = order++;
      c.isFaceUp = false;
      c.rotation = 0;
      this.reId(c);
    }
    const n = list.length;
    const visible = n - faceDown;
    let text = `${this.nameOf(seat)} ha cogido ${n === 1 ? 'una carta' : `${n} cartas`} a su mano`;
    if (visible > 0) text += visible === n ? ' (estaban boca arriba)' : ` (${visible} boca arriba)`;
    this.addLog(`${text}.`);
    return {};
  }

  // Robar la carta superior de un montón (o del mazo propio si no se indica)
  act_draw(seat, msg) {
    let pile;
    if (Array.isArray(msg.ids) && msg.ids.length > 0) {
      pile = this.boardCards(msg.ids);
    } else {
      // Montón boca abajo más grande del jugador
      const groups = new Map();
      for (const c of this.cards.values()) {
        if (c.zone !== 'board' || c.owner !== seat || c.isFaceUp) continue;
        const key = `${c.x},${c.y}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(c);
      }
      pile = [...groups.values()].sort((a, b) => b.length - a.length)[0] || [];
    }
    if (pile.length === 0) throw new Error('No hay ningún mazo tuyo boca abajo del que robar');
    const count = Math.max(1, Math.min(10, Number(msg.count) || 1));
    const top = pile.sort((a, b) => b.zIndex - a.zIndex).slice(0, count);
    let order = this.nextHandOrder(seat);
    for (const c of top) {
      c.zone = 'hand';
      c.owner = seat;
      c.order = order++;
      c.isFaceUp = false;
      c.rotation = 0;
      this.reId(c);
    }
    this.addLog(`${this.nameOf(seat)} ha robado ${top.length === 1 ? 'una carta' : `${top.length} cartas`}.`);
  }

  // Jugar una carta de la mano a la mesa
  act_play(seat, msg) {
    const c = this.cards.get(msg.id);
    if (!c || c.zone !== 'hand' || c.owner !== seat) throw new Error('Esa carta no está en tu mano');
    if (!isNum(msg.x) || !isNum(msg.y)) throw new Error('Posición no válida');
    c.zone = 'board';
    c.x = clampCoord(msg.x);
    c.y = clampCoord(msg.y);
    c.isFaceUp = msg.faceUp !== false;
    c.rotation = 0;
    c.zIndex = ++this.nextZ;
    delete c.order;
    this.reId(c);
    this.addLog(
      c.isFaceUp
        ? `${this.nameOf(seat)} ha jugado una carta boca arriba.`
        : `${this.nameOf(seat)} ha colocado una carta boca abajo.`,
    );
    return { fx: { select: [c.id] } };
  }

  // Reordenar la mano propia
  act_handOrder(seat, msg) {
    const ids = Array.isArray(msg.ids) ? msg.ids : [];
    ids.forEach((id, i) => {
      const c = this.cards.get(id);
      if (c && c.zone === 'hand' && c.owner === seat) c.order = i + 1;
    });
  }

  // Mirar en privado cartas propias boca abajo (p. ej. buscar en el mazo)
  act_peek(seat, msg, library) {
    const list = this.boardCards(msg.ids).filter((c) => !c.isFaceUp && c.owner === seat);
    if (list.length === 0) throw new Error('Selecciona cartas tuyas boca abajo para mirarlas');
    list.sort((a, b) => b.zIndex - a.zIndex);
    this.addLog(`${this.nameOf(seat)} está mirando ${list.length === 1 ? 'una carta suya boca abajo' : `${list.length} cartas suyas boca abajo`}.`);
    const names = new Map(library.templates.map((t) => [t.id, t.name]));
    return {
      private: {
        t: 'peek',
        cards: list.map((c) => ({ id: c.id, templateId: c.templateId, name: names.get(c.templateId) || '' })),
      },
    };
  }

  // Enseñar al rival una carta de la mano sin jugarla
  act_reveal(seat, msg, library) {
    const c = this.cards.get(msg.id);
    if (!c || c.zone !== 'hand' || c.owner !== seat) throw new Error('Esa carta no está en tu mano');
    const t = library.templates.find((tp) => tp.id === c.templateId);
    this.addLog(`${this.nameOf(seat)} enseña una carta de su mano: ${t ? t.name : 'carta'}.`, 'reveal');
    return { fx: { reveal: { by: seat, templateId: c.templateId } } };
  }

  act_counterAdd(seat) {
    this.nextZ++;
    this.counters.push({
      id: randomId('counter'),
      x: 600 + crypto.randomInt(100),
      y: 330 + crypto.randomInt(100),
      value: 10,
      label: 'VIDA',
      zIndex: this.nextZ,
    });
    this.addLog(`${this.nameOf(seat)} ha añadido un contador.`);
  }

  act_counterMove(_seat, msg) {
    const updates = Array.isArray(msg.updates) ? msg.updates.slice(0, 50) : [];
    for (const u of updates) {
      const c = this.counters.find((k) => k.id === u?.id);
      if (!c || !isNum(u.x) || !isNum(u.y)) continue;
      c.x = clampCoord(u.x);
      c.y = clampCoord(u.y);
    }
  }

  act_counterFront(_seat, msg) {
    const ids = new Set(Array.isArray(msg.ids) ? msg.ids : []);
    const list = this.counters.filter((c) => ids.has(c.id)).sort((a, b) => a.zIndex - b.zIndex);
    for (const c of list) c.zIndex = ++this.nextZ;
  }

  act_counterValue(seat, msg) {
    const c = this.counters.find((k) => k.id === msg.id);
    if (!c || !isNum(msg.value)) return;
    const value = Math.max(0, Math.min(10, Math.round(msg.value)));
    if (value === c.value) return;
    const prev = c.value;
    c.value = value;
    this.addLog(`${this.nameOf(seat)}: ${c.label || 'VIDA'} ${prev} → ${value}.`);
  }

  act_counterLabel(_seat, msg) {
    const c = this.counters.find((k) => k.id === msg.id);
    if (!c) return;
    c.label = String(msg.label || '').slice(0, 12);
  }

  act_reset(seat) {
    this.cards.clear();
    for (const c of this.counters) c.value = 10;
    this.addLog(`${this.nameOf(seat)} ha reiniciado la mesa (se han retirado todas las cartas y las manos).`);
  }

  act_chat(seat, msg) {
    const text = String(msg.text || '').trim().slice(0, 300);
    if (!text) return;
    this.addLog(`${this.nameOf(seat)}: ${text}`, 'chat');
  }
}

