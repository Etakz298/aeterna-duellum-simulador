import type { CardTemplate, CardBack } from './types';

// Declare the Electron IPC bindings globally for TypeScript compile safety
declare global {
  interface Window {
    electronAPI?: {
      loadDatabase: () => Promise<{
        templates: CardTemplate[];
        backs: CardBack[];
        deckNames: Record<string, string>;
        boardState: any;
      }>;
      saveDeckNames: (deckNames: Record<string, string>) => Promise<boolean>;
      saveCardTemplate: (template: Omit<CardTemplate, 'imageBlob'>, imageBuffer?: Uint8Array) => Promise<CardTemplate>;
      deleteCardTemplate: (id: string) => Promise<boolean>;
      saveCardBack: (id: string, imageBuffer?: Uint8Array) => Promise<CardBack>;
      deleteCardBack: (id: string) => Promise<boolean>;
      saveBoardState: (cards: any[], counters: any[], nextZIndex: number) => Promise<boolean>;
    };
  }
}

// Check if running inside Electron wrapper
export const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

const DB_NAME = 'CardSimulatorDB';
const DB_VERSION = 2;
const STORE_NAME = 'card_templates';
const BACKS_STORE = 'card_backs';

export function initDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = () => {
      const db = request.result;
      
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
      
      if (!db.objectStoreNames.contains(BACKS_STORE)) {
        db.createObjectStore(BACKS_STORE, { keyPath: 'id' });
      }
    };
  });
}

export async function saveCardTemplate(template: CardTemplate): Promise<void> {
  if (isElectron) {
    const metadata = { ...template };
    delete metadata.imageBlob;
    delete metadata.imageUrl;

    let buffer: Uint8Array | undefined = undefined;
    if (template.imageBlob) {
      const arrayBuf = await template.imageBlob.arrayBuffer();
      buffer = new Uint8Array(arrayBuf);
    }

    const saved = await window.electronAPI!.saveCardTemplate(metadata, buffer);
    template.imageUrl = saved.imageUrl;
    return;
  }

  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    
    const templateToSave = { ...template };
    delete templateToSave.imageUrl;
    
    const request = store.put(templateToSave);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function deleteCardTemplate(id: string): Promise<void> {
  if (isElectron) {
    await window.electronAPI!.deleteCardTemplate(id);
    return;
  }

  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(id);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function getCardTemplates(): Promise<CardTemplate[]> {
  if (isElectron) {
    const db = await window.electronAPI!.loadDatabase();
    return db.templates || [];
  }

  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();

    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

export async function saveCardBack(back: CardBack): Promise<void> {
  if (isElectron) {
    let buffer: Uint8Array | undefined = undefined;
    if (back.imageBlob) {
      const arrayBuf = await back.imageBlob.arrayBuffer();
      buffer = new Uint8Array(arrayBuf);
    }
    const saved = await window.electronAPI!.saveCardBack(back.id, buffer);
    back.imageUrl = saved.imageUrl;
    return;
  }

  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(BACKS_STORE, 'readwrite');
    const store = transaction.objectStore(BACKS_STORE);
    
    const backToSave = { ...back };
    delete backToSave.imageUrl;
    
    const request = store.put(backToSave);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function getCardBacks(): Promise<CardBack[]> {
  if (isElectron) {
    const db = await window.electronAPI!.loadDatabase();
    return db.backs || [];
  }

  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(BACKS_STORE, 'readonly');
    const store = transaction.objectStore(BACKS_STORE);
    const request = store.getAll();

    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteCardBack(id: string): Promise<void> {
  if (isElectron) {
    await window.electronAPI!.deleteCardBack(id);
    return;
  }

  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(BACKS_STORE, 'readwrite');
    const store = transaction.objectStore(BACKS_STORE);
    const request = store.delete(id);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
