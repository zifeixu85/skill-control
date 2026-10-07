/**
 * What a page looked like when you left it — which groups were open, which item you opened —
 * kept in memory for this session so 查看详情 → back lands where you were. Values are
 * primitives so snapshots compare by value.
 */

export type MemoryValue = string | number | boolean | null;

type Listener = () => void;

const values = new Map<string, MemoryValue>();
const listeners = new Map<string, Set<Listener>>();

export function readMemory<T extends MemoryValue>(key: string, fallback: T): T {
  return values.has(key) ? (values.get(key) as T) : fallback;
}

export function writeMemory(key: string, value: MemoryValue): void {
  if (values.get(key) === value && values.has(key)) return;
  values.set(key, value);
  listeners.get(key)?.forEach((listener) => listener());
}

export function subscribeMemory(key: string, listener: Listener): () => void {
  const set = listeners.get(key) || new Set<Listener>();
  set.add(listener);
  listeners.set(key, set);
  return () => {
    set.delete(listener);
  };
}

/** The item last opened from `page` (a finding id, an update unit key, …). */
export const openedKey = (page: string) => `${page}:opened`;

const arrivalKey = (page: string) => `${page}:arrival`;

/** Remember the item a 查看详情 left from; the next visit to `page` flashes it once. */
export function markOpened(page: string, id: string): void {
  writeMemory(openedKey(page), id);
  writeMemory(arrivalKey(page), id);
}

/** The item to flash on arriving back at `page`, once. */
export function takeArrival(page: string): string | null {
  const id = readMemory<string | null>(arrivalKey(page), null);
  if (id) writeMemory(arrivalKey(page), null);
  return id;
}

/** Test hook: forget everything. */
export function clearMemory(): void {
  values.clear();
}
