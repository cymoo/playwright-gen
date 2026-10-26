/** Run a single spec without shell interpolation; retain an isolated diagnostic bundle. */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const RUN_CONFIG = `import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', reporter: 'list' });
`;
export type TraceMode = 'off' | 'on' | 'retain-on-failure';
export interface RunOptions {
  debug?: boolean;
  pauseOnFailure?: boolean;
  trace?: TraceMode;
  /** Receives live stdout/stderr, while the complete output is also saved. */
  onOutput?: (text: string) => void;
}
export interface RunResult {
  passed: boolean;
  output: string;
  logPath?: string;
  artifactsDir?: string;
  reportPath?: string;
  failureSummary?: string;
  exitCode?: number | null;
  timedOut?: boolean;
}

interface ReportError { message?: string; stack?: string }
interface ReportSuite {
  file?: string;
  suites?: ReportSuite[];
  specs?: { file?: string; line?: number; title?: string;
    tests?: { results?: { status?: string; errors?: ReportError[] }[] }[] }[];
  errors?: ReportError[];
}

/** Read test errors directly, rather than relying on the tail of terminal output. */
export function failureSummary(reportPath: string): string | undefined {
  try {
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as ReportSuite;
    const failures: string[] = [];
    const visit = (suite: ReportSuite) => {
      for (const spec of suite.specs ?? []) {
        for (const test of spec.tests ?? []) {
          for (const result of test.results ?? []) {
            if (['passed', 'skipped'].includes(result.status ?? '')) continue;
            for (const error of result.errors ?? []) {
              failures.push(`${spec.file ?? suite.file ?? ''}:${spec.line ?? ''} ${spec.title}\n${error.message ?? error.stack ?? JSON.stringify(error)}`);
            }
          }
        }
      }
      for (const child of suite.suites ?? []) visit(child);
    };
    visit(report);
    for (const error of report.errors ?? []) failures.push(error.message ?? error.stack ?? JSON.stringify(error));
    return failures.length ? failures.join('\n\n') : undefined;
  } catch { return undefined; }
}

export function runPlaywright(specFile: string, timeoutMs = 120_000, params: Record<string, string> = {}, logPath?: string, options: RunOptions = {}): Promise<RunResult> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error('timeout 必须是有效的正数毫秒数');
  const spec = resolve(specFile);
  const dir = dirname(spec);
  const interactive = !!(options.debug || options.pauseOnFailure || (process.env.PWDEBUG && process.env.PWDEBUG !== '0'));
  const modernDebug = interactive && /^\/\/ pwgen-debug: 1$/m.test(readFileSync(spec, 'utf8'));
  if (options.pauseOnFailure && !modernDebug) {
    throw new Error('--pause-on-failure 需要支持失败暂停的新用例；请重新生成，旧用例仍可使用 --debug 单步检查');
  }
  const cfg = join(dir, 'playwright.config.ts');
  if (!existsSync(cfg)) writeFileSync(cfg, RUN_CONFIG, 'utf8');
  const artifactsRoot = join(dir, '.pwgen-replays');
  mkdirSync(artifactsRoot, { recursive: true });
  const artifactsDir = mkdtempSync(join(artifactsRoot, 'run-'));
  const reportPath = join(artifactsDir, 'report.json');
  const fullLog = join(artifactsDir, 'replay.log');
  const logs = [...new Set([fullLog, ...(logPath ? [resolve(logPath)] : [])])];
  for (const log of logs) { mkdirSync(dirname(log), { recursive: true }); writeFileSync(log, '', 'utf8'); }
  const packagePath = createRequire(import.meta.url).resolve('@playwright/test/package.json');
  const metadata = JSON.parse(readFileSync(packagePath, 'utf8')) as { bin: { playwright: string } };
  const cliPath = join(dirname(packagePath), metadata.bin.playwright);
  const base = '(?:^|[/\\\\])' + basename(spec).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$';
  const args = [cliPath, 'test', base, '--workers=1', '--retries=0', '--reporter=list,json', '-c', cfg,
    '--output', join(artifactsDir, 'test-results'), '--trace', options.trace ?? 'retain-on-failure'];
  if (options.debug) args.push('--debug');
  else if (options.pauseOnFailure) args.push('--headed');
  if (interactive) args.push('--global-timeout=0');
  const env: NodeJS.ProcessEnv = { ...process.env, PWGEN_PARAMS: JSON.stringify(params),
    PWGEN_DEBUG: interactive ? '1' : '0', PWGEN_PAUSE_ON_FAILURE: options.pauseOnFailure ? '1' : '0',
    PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath, PLAYWRIGHT_LIST_PRINT_STEPS: '1', FORCE_COLOR: '0' };
  delete env.NO_COLOR;

  return new Promise((complete) => {
    let timedOut = false;
    let out = '';
    let outputLength = 0;
    const collect = (text: string) => {
      outputLength += text.length;
      out += text;
      if (out.length > 1_000_000) out = out.slice(0, 500_000) + out.slice(-500_000);
      for (const log of logs) appendFileSync(log, text, 'utf8');
      options.onOutput?.(text);
    };
    if (interactive && !modernDebug) {
      collect('[调试] 旧用例可能显式设置了超时；需要时在脚本中临时设置 test.setTimeout(0)。\n');
    }
    const child = spawn(process.execPath, args, { cwd: dir, env, detached: process.platform !== 'win32',
      stdio: [interactive ? 'inherit' : 'ignore', 'pipe', 'pipe'] });
    const timer = interactive ? undefined : setTimeout(() => {
      collect(`\n[playwright 超时,超过 ${timeoutMs}ms]\n`);
      timedOut = true;
      if (child.pid && process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f']);
        killer.on('error', () => child.kill());
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    }, timeoutMs);
    // Decode across chunks so split UTF-8 characters do not corrupt saved diagnostics.
    child.stdout!.setEncoding('utf8').on('data', d => collect(d));
    child.stderr!.setEncoding('utf8').on('data', d => collect(d));
    let finished = false;
    const finish = (exitCode: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      complete({ passed: !timedOut && exitCode === 0, output: trimOutput(out, outputLength), logPath: fullLog,
        artifactsDir, reportPath, failureSummary: failureSummary(reportPath), exitCode, timedOut });
    };
    child.on('close', finish);
    child.on('error', error => { collect(`启动 playwright 失败:${String(error)}\n`); finish(null); });
  });
}

function trimOutput(text: string, totalLength = text.length, head = 1500, tail = 1500): string {
  if (text.length <= head + tail) return text;
  return text.slice(0, head) + `\n\n[... 省略 ${totalLength - head - tail} 字符，详见完整日志 ...]\n\n` + text.slice(-tail);
}
