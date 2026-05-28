import { hostname, platform } from "node:os";

let cachedAuto: string | undefined;

/**
 * The canonical name of the machine this process runs on (e.g. apple03, spark01).
 *
 * Resolution order:
 *  1. HASNA_MACHINE env (explicit override; always honored, never cached).
 *  2. macOS: the stable ComputerName (`scutil --get ComputerName`) — the plain
 *     hostname can flip to "Mac" on DHCP changes, which would mis-tag sessions.
 *  3. Short hostname (domain stripped).
 *
 * The auto-detected value is cached (scutil is a subprocess; this is called per
 * ingested session).
 */
export function getMachineName(): string {
  const override = process.env.HASNA_MACHINE;
  if (override && override.trim()) return override.trim();
  if (cachedAuto) return cachedAuto;

  if (platform() === "darwin") {
    try {
      const r = Bun.spawnSync(["scutil", "--get", "ComputerName"]);
      const name = r.success ? new TextDecoder().decode(r.stdout).trim() : "";
      if (name) {
        cachedAuto = name.split(".")[0];
        return cachedAuto;
      }
    } catch {
      // fall through to hostname
    }
  }
  cachedAuto = hostname().split(".")[0];
  return cachedAuto;
}

export interface MachineInfo {
  name: string;
  hostname: string;
  platform: string;
}

export function getMachineInfo(): MachineInfo {
  return { name: getMachineName(), hostname: hostname(), platform: platform() };
}
