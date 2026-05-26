/**
 * Per-origin IndexedDB store for the household device identity. We keep
 * a single row keyed by `'device'` that holds the issued device id and the
 * non-extractable ECDSA P-256 private key. CryptoKey objects are storable
 * directly in IndexedDB (the structured-clone algorithm handles them), so
 * we never see the key bytes from JavaScript — which is exactly the
 * property the device challenge/response flow depends on.
 *
 * When a paired tab reloads, `loadPairedDevice` returns the persisted
 * identity and the devices bootstrap re-opens the WebSocket without
 * asking the user to re-pair.
 *
 * The database name `eal-family-phone` is preserved from the previous
 * location of this file so existing paired browsers keep working.
 */

const DB_NAME = 'eal-family-phone';
const DB_VERSION = 1;
const STORE = 'identity';
const KEY = 'device';

export interface PersistedDevice {
  deviceId: number;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeyB64: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
}

export async function savePairedDevice(input: PersistedDevice): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('indexedDB save failed'));
      tx.objectStore(STORE).put(input, KEY);
    });
  } finally {
    db.close();
  }
}

export async function loadPairedDevice(): Promise<PersistedDevice | null> {
  const db = await openDb();
  try {
    return await new Promise<PersistedDevice | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => {
        const v = req.result;
        if (!v || typeof v !== 'object') {
          resolve(null);
          return;
        }
        if (
          'deviceId' in v && typeof v.deviceId === 'number' &&
          'privateKey' in v && v.privateKey instanceof CryptoKey &&
          'publicKey' in v && v.publicKey instanceof CryptoKey &&
          'publicKeyB64' in v && typeof v.publicKeyB64 === 'string'
        ) {
          resolve({
            deviceId: v.deviceId,
            privateKey: v.privateKey,
            publicKey: v.publicKey,
            publicKeyB64: v.publicKeyB64,
          });
        } else {
          resolve(null);
        }
      };
      req.onerror = () => reject(req.error ?? new Error('indexedDB load failed'));
    });
  } finally {
    db.close();
  }
}

export async function clearPairedDevice(): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('indexedDB clear failed'));
      tx.objectStore(STORE).delete(KEY);
    });
  } finally {
    db.close();
  }
}
