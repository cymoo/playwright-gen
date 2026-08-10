/**
 * 一次性 shell 命令执行器(供 run_command 工具),及其在生成用例里的孪生辅助函数源码。
 *
 * shell: true → POSIX 走 sh、Windows 走 cmd(需要 powershell 时命令写 powershell -Command "…")。
 * stdinLines 用于给交互式 CLI(如 hdc shell)逐行输入;无论有无输入都 end() stdin,
 * 防止读 stdin 的命令挂死。stdout+stderr 按到达顺序合并为一个输出串。
 *
 * SHELL_HELPER_TS / WRITE_HELPER_TS 是 codegen 注入生成用例的辅助函数源码,
 * 与真实执行器同文件放置,保证"探索时怎么执行,回放时就怎么执行"不漂移。
 */

import { spawn } from 'node:child_process';

export interface ShellResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

/** 输出累积上限(字符):超过则保头保尾各半,内存有界。 */
const OUT_CAP = 1_000_000;

export function execShell(
  command: string,
  opts: { stdinLines?: string[]; timeoutMs: number; cwd?: string },
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, cwd: opts.cwd, env: process.env });
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    // 采集阶段就封顶(保头保尾),防止命令海量输出撑爆内存;模型侧另有 capOutput 截到 ~6KB
    const push = (d: Buffer) => {
      out += d.toString();
      if (out.length > OUT_CAP) out = out.slice(0, OUT_CAP / 2) + out.slice(-OUT_CAP / 2);
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output: out, timedOut });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, output: out + `\n启动命令失败:${String(e)}`, timedOut });
    });
    if (opts.stdinLines?.length) child.stdin.write(opts.stdinLines.join('\n') + '\n');
    child.stdin.end();
  });
}

/** 截断超长输出(保头保尾,CLI 结果通常在末尾),防止刷爆模型上下文。 */
export function capOutput(text: string, head = 3000, tail = 3000): string {
  if (text.length <= head + tail) return text;
  return text.slice(0, head) + `\n\n[... 省略 ${text.length - head - tail} 字符 ...]\n\n` + text.slice(-tail);
}

/** 生成用例里的 runCommand 辅助函数:与 execShell 同语义,超时/启动失败则 reject 让用例 fail loud。 */
export const SHELL_HELPER_TS = `async function runCommand(cmd: string, stdinLines: string[] | undefined, timeoutMs: number): Promise<number> {
  const cwd = dirname(test.info().file);
  return await new Promise((res, rej) => {
    const child = spawn(cmd, { shell: true, cwd, env: process.env });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); rej(new Error('命令超时 ' + timeoutMs + 'ms: ' + cmd)); }, timeoutMs);
    const push = (d: Buffer) => { out += d; if (out.length > 1000000) out = out.slice(0, 500000) + out.slice(-500000); };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    child.on('error', (e) => { clearTimeout(timer); rej(e); });
    child.on('close', (code) => { clearTimeout(timer); console.log(out); res(code ?? -1); });
    if (stdinLines?.length) child.stdin.write(stdinLines.join('\\n') + '\\n');
    child.stdin.end();
  });
}`;

/** 生成用例里的 writeFileTo 辅助函数:相对路径按 spec 所在目录解析,与探索时的 runDir 一致。 */
export const WRITE_HELPER_TS = `function writeFileTo(p: string, content: string): void {
  const abs = resolve(dirname(test.info().file), p);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}`;
