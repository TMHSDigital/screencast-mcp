/** Process-wide singletons shared by every tool. */
import { SessionStore } from "./utils/sessions.js";
import { registryPath } from "./utils/paths.js";

let store: SessionStore | null = null;

/** Lazily construct and load the on-disk session registry. */
export function getStore(): SessionStore {
  if (!store) {
    store = new SessionStore(registryPath());
    store.load();
  }
  return store;
}

let shuttingDown = false;

/** Set once shutdown begins: from then on nothing writes to the client, whose
 * pipe may already be closed (#229). */
export function markShuttingDown(): void {
  shuttingDown = true;
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}
