import { homedir } from "node:os";
import { join } from "node:path";

/** Where Swiftnest keeps keys, paired devices and the audit log: $SWIFTNEST_HOME, else the XDG state directory. */
export function stateDir(): string {
  return process.env.SWIFTNEST_HOME ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "swiftnest");
}
