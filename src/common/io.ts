/**
 * 时间戳输出目录（所有版本共用）。
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function makeRunDir(outDir: string, name?: string | null): string {
  const stamp = name && name.trim() ? name.trim() : timestamp();
  const dir = join(outDir, stamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}
