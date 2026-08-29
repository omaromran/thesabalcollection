const DB_NAME = "sabal-festival";
const DB_VERSION = 1;
const STORE = "leads";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveLead(lead) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(lead);
    tx.oncomplete = () => resolve(lead);
    tx.onerror = () => reject(tx.error);
  });
}

export async function listLeads() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).index("createdAt").getAll();
    request.onsuccess = () => {
      const rows = request.result || [];
      rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      resolve(rows);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function clearLeads() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function leadsToCsv(leads) {
  const header = ["id", "createdAt", "name", "email", "phone", "theme"];
  const lines = [header.join(",")];
  for (const lead of leads) {
    const row = [
      lead.id,
      new Date(lead.createdAt).toISOString(),
      lead.name || "",
      lead.email || "",
      lead.phone || "",
      lead.theme || "",
    ].map((value) => `"${String(value).replaceAll('"', '""')}"`);
    lines.push(row.join(","));
  }
  return lines.join("\n");
}
