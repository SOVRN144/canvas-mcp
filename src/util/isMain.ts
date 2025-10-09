// src/util/isMain.ts
import { fileURLToPath } from 'url';
import path from 'path';

/** True when the current module is the entrypoint (ESM-safe). */
export function isMain(metaUrl: string): boolean {
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
  return fileURLToPath(metaUrl) === entry;
}