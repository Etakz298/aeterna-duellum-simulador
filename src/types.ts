export interface CardTemplate {
  id: string;
  name: string;
  imageBlob?: Blob;
  imageUrl?: string; // Object URL created in memory
  deckId: string; // 'mazo1' | 'mazo2' | 'mazo3' | 'mazo4'
  backType: 'backA' | 'backB';
  quantity: number; // Number of copies of this card in the deck
  createdAt: number;
}

export interface CardBack {
  id: string;
  imageBlob?: Blob;
  imageUrl?: string; // Object URL created in memory
}

export interface BoardCard {
  id: string;
  templateId: string;
  x: number;
  y: number;
  isFaceUp: boolean;
  rotation: number; // 0, 90, 180, 270
  zIndex: number;
}

export interface LifeCounter {
  id: string;
  x: number;
  y: number;
  value: number; // 0 to 10
  label: string;
  zIndex: number;
}

export interface Position {
  x: number;
  y: number;
}

export interface SelectionArea {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  isActive: boolean;
}
