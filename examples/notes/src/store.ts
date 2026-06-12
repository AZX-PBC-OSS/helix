// Persistence layer: notes live in localStorage, so the app is fully static —
// no server, no network. This is the storage model an AZX app uses before the
// platform data API (gateway /_api/data, M2+) is available.

export interface Note {
  id: string;
  text: string;
  createdAt: number;
}

const STORAGE_KEY = "azx.notes.v1";

export function load(): Note[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Note[]) : [];
  } catch {
    return [];
  }
}

export function save(notes: Note[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
}

export function add(notes: Note[], text: string): Note[] {
  const note: Note = {
    id: crypto.randomUUID(),
    text,
    createdAt: Date.now(),
  };
  return [note, ...notes];
}

export function remove(notes: Note[], id: string): Note[] {
  return notes.filter((n) => n.id !== id);
}
