import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run } from '../src/engine';
import { runPlaywright } from '../src/runner';
import { Trajectory } from '../src/trajectory';

test('完整探索回放失败后，较短的重探不覆盖原脚本和首次回放日志', async () => {
  test.setTimeout(60000);
  const root = join(process.cwd(), 'output'); mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'diagnostic-attempts-'));
  const exitCode = process.exitCode;
  try {
    const html = join(dir, 'fixture.html');
    writeFileSync(html, '<p data-testid="app">wrong.app</p>');
    const url = pathToFileURL(html).href;
    const full = new Trajectory();
    full.add({ kind: 'goto', url });
    full.add({ kind: 'stepStart', title: 'connect' });
    full.add({ kind: 'assertVisible', target: { kind: 'testId', testId: 'app' } });
    full.add({ kind: 'stepStart', title: 'select application' });
    full.add({ kind: 'assertText', target: { kind: 'testId', testId: 'app' }, text: 'FIRST_REPLAY_FAILURE' });
    const partial = new Trajectory();
    partial.add({ kind: 'goto', url });
    await run({ target: { mode: 'web', url }, description: '步骤1：连接。步骤2：选择应用',
      outDir: dir, name: 'case', maxRepairs: 1 }, {
      explore: async (_opts, _plan, _dir, round, replayHint) => {
        if (round === 1) return { traj: full, summaries: ['connected', 'selected'] };
        expect(replayHint).toContain('FIRST_REPLAY_FAILURE');
        return { traj: partial, summaries: [], failed: { index: 0, reason: 'SECOND_EXPLORATION_FAILURE' } };
      },
    });
    const runDir = join(dir, 'case');
    expect(process.exitCode).toBe(1);
    expect(readFileSync(join(runDir, 'test_generated.spec.ts'), 'utf8'))
      .toBe(readFileSync(join(runDir, 'test_generated.round1.ts'), 'utf8'));
    expect(readFileSync(join(runDir, 'test_generated.round2.ts'), 'utf8')).not.toContain('select application');
    const replayLog = readFileSync(join(runDir, 'replay_round1.log'), 'utf8');
    expect(replayLog).toContain('FIRST_REPLAY_FAILURE');
    expect(replayLog).toContain('Running 1 test');
    expect(existsSync(join(runDir, 'replay_round2.log'))).toBe(false);
  } finally {
    process.exitCode = exitCode;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('回放诊断文件保留完整输出，包括返回摘要省略的中段', async () => {
  const root = join(process.cwd(), 'output'); mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'diagnostic-log-'));
  try {
    const spec = join(dir, 'logging.spec.ts');
    const log = join(dir, 'replay.log');
    writeFileSync(spec, `import { test } from '@playwright/test';
test('log', () => {
  console.log('A'.repeat(4000));
  console.log('MIDDLE_DIAGNOSTIC_MARKER');
  console.error('B'.repeat(4000));
});`);
    const result = await runPlaywright(spec, 20000, {}, log);
    expect(result.passed, result.output).toBe(true);
    expect(result.output).toContain('省略');
    expect(result.output).not.toContain('MIDDLE_DIAGNOSTIC_MARKER');
    const fullLog = readFileSync(log, 'utf8');
    expect(fullLog).toContain('MIDDLE_DIAGNOSTIC_MARKER');
    expect(fullLog).toContain('A'.repeat(4000));
    expect(fullLog).toContain('B'.repeat(4000));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
