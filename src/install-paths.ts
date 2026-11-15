import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The checkout or install this process runs from: the directory that holds `package.json`.
 * Compiled modules live under `dist/`, so the package root is two directories above this file.
 */
export function installRoot(): string {
  return dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));
}
