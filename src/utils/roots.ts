/**
 * MCP client roots (#221). A client with the `roots` capability says which
 * folders the server may work in; paths.ts confines caller-chosen outputs to
 * them (plus SCREENCAST_HOME and SCREENCAST_ALLOWED_DIRS). The list is read
 * once the client finishes initializing and again on every
 * notifications/roots/list_changed.
 */
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { setClientRoots } from "./paths.js";

/** The local directories among root URIs; non-file URIs are skipped. Pure. */
export function rootDirs(roots: Array<{ uri: string }>): string[] {
  const dirs: string[] = [];
  for (const { uri } of roots) {
    if (!uri.startsWith("file:")) continue;
    try {
      dirs.push(fileURLToPath(uri));
    } catch {
      /* malformed file URI: not a usable root */
    }
  }
  return dirs;
}

/** Track the connected client's roots for output confinement. */
export function trackClientRoots(server: McpServer): void {
  const low = server.server;
  const refresh = async (initial: boolean): Promise<void> => {
    if (!low.getClientCapabilities()?.roots) {
      setClientRoots(null);
      return;
    }
    // Only the first read blocks writes outside SCREENCAST_HOME; a refresh
    // keeps the previous roots until the new list arrives.
    if (initial) setClientRoots("pending");
    try {
      const { roots } = await low.listRoots();
      setClientRoots(rootDirs(roots));
    } catch (err) {
      // A client that advertises roots but cannot list them is treated as
      // having none, rather than locking every caller-chosen path out.
      if (initial) setClientRoots(null);
      process.stderr.write(`roots/list failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  };
  const previous = low.oninitialized;
  low.oninitialized = () => {
    previous?.();
    void refresh(true);
  };
  low.setNotificationHandler(RootsListChangedNotificationSchema, () => refresh(false));
}
