import { spawn, spawnSync } from 'child_process';

/** Variables that would let a user's own Python setup leak into the runtime. */
const STRIPPED_ENV = ['PYTHONHOME', 'PYTHONPATH', 'VIRTUAL_ENV', 'PYTHONSTARTUP', 'PYTHONINSPECT'];

export interface RuntimeEnvOptions {
  hermesHome: string;
  /** Extra variables, for example the API key variable of the active provider profile. */
  extra?: Record<string, string>;
}

export function buildRuntimeEnv(base: NodeJS.ProcessEnv, opts: RuntimeEnvOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of STRIPPED_ENV) delete env[key];
  env.HERMES_HOME = opts.hermesHome;
  env.PYTHONUTF8 = '1';
  env.PYTHONNOUSERSITE = '1';
  env.PYTHONDONTWRITEBYTECODE = '1';
  for (const [key, value] of Object.entries(opts.extra ?? {})) env[key] = value;
  return env;
}

export interface CaptureResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

/** Runs a command to completion with a timeout. Never uses a shell. */
export function runCapture(
  exe: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  cwd?: string,
): Promise<CaptureResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (result: CaptureResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child;
    try {
      child = spawn(exe, args, { env, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: null, stdout, stderr, timedOut: false, spawnError: String(err) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => { stdout += d; });
    child.stderr.on('data', (d: string) => { stderr += d; });
    child.on('error', (err) => finish({ code: null, stdout, stderr, timedOut, spawnError: err.message }));
    child.on('close', (code) => finish({ code, stdout, stderr, timedOut }));
  });
}

/**
 * Ends a process and everything it started. On Windows a plain kill only ends the interpreter, and
 * the Git Bash and tool processes it spawned would keep running.
 */
export function killProcessTree(pid: number | undefined, platform: NodeJS.Platform = process.platform): void {
  if (!pid) return;
  try {
    if (platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // The process already ended.
  }
}
