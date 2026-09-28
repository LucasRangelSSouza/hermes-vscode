import * as os from 'os';
import * as path from 'path';

/** Layout of the extension-owned data directory (product spec section 29). */
export interface DataPaths {
  root: string;
  runtime: string;
  home: string;
  skills: string;
  cache: string;
  logs: string;
  state: string;
}

export function dataRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homedir: string = os.homedir(),
): string {
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA && env.LOCALAPPDATA.trim()
      ? env.LOCALAPPDATA
      : path.win32.join(homedir, 'AppData', 'Local');
    return path.win32.join(base, 'HermesByRangelTech');
  }
  const base = env.XDG_DATA_HOME && env.XDG_DATA_HOME.trim()
    ? env.XDG_DATA_HOME
    : path.posix.join(homedir, '.local', 'share');
  return path.posix.join(base, 'hermes-by-rangel-tech');
}

export function dataPaths(root: string, platform: NodeJS.Platform = process.platform): DataPaths {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return {
    root,
    runtime: join(root, 'runtime'),
    home: join(root, 'home'),
    skills: join(root, 'skills'),
    cache: join(root, 'cache'),
    logs: join(root, 'logs'),
    state: join(root, 'state'),
  };
}

/**
 * Default Hermes data directory for an existing (user-installed) Hermes.
 * Native Windows installs live under %LOCALAPPDATA%\hermes, everything else under ~/.hermes.
 */
export function defaultExistingHermesHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homedir: string = os.homedir(),
): string {
  if (env.HERMES_HOME && env.HERMES_HOME.trim()) return env.HERMES_HOME;
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA && env.LOCALAPPDATA.trim()
      ? env.LOCALAPPDATA
      : path.win32.join(homedir, 'AppData', 'Local');
    return path.win32.join(base, 'hermes');
  }
  return path.posix.join(homedir, '.hermes');
}

let activeHome: string | null = null;

/** The HERMES_HOME of the agent process currently in use. Every reader of Hermes files goes through this. */
export function activeHermesHome(): string {
  return activeHome ?? path.join(os.homedir(), '.hermes');
}

/** The explicitly selected home, or null while none has been selected. */
export function activeHermesHomeOrNull(): string | null {
  return activeHome;
}

export function setActiveHermesHome(home: string | null): void {
  activeHome = home;
}
