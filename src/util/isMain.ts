// src/util/isMain.ts
import path from 'path';
import { fileURLToPath } from 'url';

/** True when the current module is the entrypoint (ESM-safe). */
export function isMain(metaUrl: string): boolean {
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
  return fileURLToPath(metaUrl) === entry;
}