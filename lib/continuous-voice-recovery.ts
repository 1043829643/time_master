export type PendingVoiceTurn = {
  key: string;
  scope: string;
  id: string;
  createdAt: string;
  blob?: Blob;
  text?: string;
  delivered?: boolean;
  size: number;
};

export const MAX_PENDING_VOICE_TURNS = 8;
export const MAX_PENDING_VOICE_BYTES = 24_000_000;

export function pendingVoiceKey(scope: string, id: string) { return `${scope}\u0000${id}`; }

export function canStorePendingVoice(existing: PendingVoiceTurn[], next: PendingVoiceTurn) {
  const others = existing.filter(item => item.id !== next.id);
  return others.length < MAX_PENDING_VOICE_TURNS && others.reduce((size, item) => size + item.size, next.size) <= MAX_PENDING_VOICE_BYTES;
}

function open() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('time-master-continuous-voice-recovery', 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('pending', {keyPath: 'key'});
      store.createIndex('scope', 'scope');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法打开语音暂存。'));
  });
}

export async function listPendingVoice(scope: string): Promise<PendingVoiceTurn[]> {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('pending', 'readonly');
      const request = tx.objectStore('pending').index('scope').getAll(scope);
      request.onsuccess = () => resolve((request.result as PendingVoiceTurn[]).sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
      request.onerror = () => reject(request.error || new Error('无法读取语音暂存。'));
    });
  } finally { db.close(); }
}

export async function savePendingVoice(item: PendingVoiceTurn): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('pending', 'readwrite');
      const store = tx.objectStore('pending');
      const request = store.index('scope').getAll(item.scope);
      let problem: Error | null = null;
      request.onsuccess = () => {
        if (!canStorePendingVoice(request.result as PendingVoiceTurn[], item)) {
          problem = new Error('待重试语音已达到浏览器暂存上限，请先下载或清理旧录音。');
          tx.abort();
          return;
        }
        store.put(item);
      };
      request.onerror = () => { problem = request.error || new Error('无法检查语音暂存。'); tx.abort(); };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(problem || tx.error || new Error('无法暂存语音。'));
      tx.onabort = () => reject(problem || tx.error || new Error('无法暂存语音。'));
    });
  } finally { db.close(); }
}

export async function removePendingVoice(scope: string, id: string): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('pending', 'readwrite');
      tx.objectStore('pending').delete(pendingVoiceKey(scope, id));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('无法清理语音暂存。'));
      tx.onabort = () => reject(tx.error || new Error('无法清理语音暂存。'));
    });
  } finally { db.close(); }
}

export async function clearPendingVoice(scope: string): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('pending', 'readwrite');
      const request = tx.objectStore('pending').index('scope').openKeyCursor(scope);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        tx.objectStore('pending').delete(cursor.primaryKey);
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('无法清理语音暂存。'));
      tx.onabort = () => reject(tx.error || new Error('无法清理语音暂存。'));
    });
  } finally { db.close(); }
}
