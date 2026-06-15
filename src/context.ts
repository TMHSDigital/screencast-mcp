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
