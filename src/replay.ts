import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, extname, basename, dirname } from 'node:path';
import { runPlaywright, type RunResult } from './runner';
import type { Params } from './runtime';

export function scanFiles(dir: string, ext: string, recursive = false): string[] {
  if (!['pb', 'rdc'].includes(ext.toLowerCase())) throw new Error('--ext 必须是 pb 或 rdc');
  const files: string[] = [];
  const visit = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory() && recursive) visit(full);
      else if (entry.isFile() && extname(entry.name).toLowerCase() === `.${ext.toLowerCase()}`) files.push(full);
    }
  };
  visit(resolve(dir));
  files.sort();
  if (!files.length) throw new Error(`目录中没有 ${ext} 文件: ${dir}`);
  return files;
}
interface ReplayOpts {
  spec: string; params: Params; inputDir?: string; ext?: string;
  recursive?: boolean; timeoutMs: number; report: string;
}
export interface FileResult extends RunResult { file?: string }
export async function replay(opts: ReplayOpts, runner = runPlaywright): Promise<FileResult[]> {
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0 || opts.timeoutMs > 2_147_483_647) throw new Error('timeout 必须是有效的正数秒数');
  const spec = resolve(opts.spec);
  if (!statSync(spec).isFile()) throw new Error('spec 必须是文件');
  if (!!opts.inputDir !== !!opts.ext) throw new Error('--input-dir 和 --ext 必须一起提供');
  const files: (string | undefined)[] = opts.inputDir ? scanFiles(opts.inputDir, opts.ext!, opts.recursive) : [undefined];
  if (opts.inputDir) {
    const header = readFileSync(spec, 'utf8').match(/^\/\/ pwgen-parameters: (.+)$/m);
    const names: string[] = header ? JSON.parse(header[1]) : [];
    if (!names.includes('inputFile') && !names.includes('inputName')) {
      throw new Error('批量用例必须在实际操作或断言中引用 ${inputFile} 或 ${inputName}；请按单文件模板重新生成');
    }
    if (!names.includes('inputFile')) {
      const basenames = files.map(file => basename(file!));
      if (new Set(basenames).size !== basenames.length) throw new Error('目录中存在同名文件，请使用 inputFile 完整路径定位');
    }
  }
  const report = resolve(opts.report);
  if (report === spec || files.includes(report)) throw new Error('报告路径不能覆盖用例或输入文件');
  const results: FileResult[] = [];
  for (const file of files) {
    const params = { ...opts.params, ...(file ? { inputFile: file, inputName: basename(file) } : {}) };
    let result: RunResult;
    try { result = await runner(spec, opts.timeoutMs, params); }
    catch (error) { result = { passed: false, output: String(error) }; }
    results.push({ file, ...result });
    mkdirSync(dirname(report), { recursive: true });
    writeFileSync(report, JSON.stringify({ files, results }, null, 2));
    console.log(`${result.passed ? 'PASS' : 'FAIL'} ${file ?? spec}`);
  }
  return results;
}
