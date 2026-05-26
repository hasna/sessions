import { hostname, platform } from "node:os";

/**
 * The canonical name of the machine this process runs on (e.g. apple03, spark01).
 * Override with HASNA_MACHINE; otherwise the short hostname (domain stripped).
 */
export function getMachineName(): string {
  const override = process.env.HASNA_MACHINE;
  if (override && override.trim()) return override.trim();
  return hostname().split(".")[0];
}

export interface MachineInfo {
  name: string;
  hostname: string;
  platform: string;
}

export function getMachineInfo(): MachineInfo {
  return { name: getMachineName(), hostname: hostname(), platform: platform() };
}
