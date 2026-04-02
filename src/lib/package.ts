import { readFileSync } from "fs";
import { fileURLToPath } from "url";

export interface PackageInfo {
  name: string;
  version: string;
  description?: string;
}

let cachedPackageInfo: PackageInfo | null = null;

export function getPackageInfo(): PackageInfo {
  if (cachedPackageInfo) {
    return cachedPackageInfo;
  }

  const packageJsonPath = fileURLToPath(
    new URL("../../package.json", import.meta.url)
  );

  cachedPackageInfo = JSON.parse(
    readFileSync(packageJsonPath, "utf-8")
  ) as PackageInfo;

  return cachedPackageInfo;
}

export function getPackageVersion(): string {
  return getPackageInfo().version;
}
