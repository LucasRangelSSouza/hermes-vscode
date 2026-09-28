import * as fs from 'fs';
import * as path from 'path';

/**
 * Hermes's terminal tool keeps a warm-shell snapshot for each session under
 * `<HERMES_HOME>/cache/terminal/hermes-snap-*.sh`, written with `declare -x` for the whole
 * environment — including whatever provider API key variable this process injected. That is a
 * real gap in "the key only lives in the child's environment, never on disk" (found in manual
 * verification, 2026-09-28): the guarantee holds for our own config writer, but not once the
 * agent runs a terminal command.
 *
 * There is no known Hermes setting to disable the snapshot. Since the extension owns this
 * private home, it purges the folder before every launch and again when the agent stops, so a
 * key is on disk only while a shell is actually warm, never across restarts or profile switches.
 */
export function purgeTerminalSnapshots(hermesHome: string): void {
  const dir = path.join(hermesHome, 'cache', 'terminal');
  try {
    for (const name of fs.readdirSync(dir)) {
      if (/^hermes-snap-[0-9a-f]+\.sh$/.test(name)) fs.rmSync(path.join(dir, name), { force: true });
    }
  } catch {
    // No cache yet, or nothing to remove.
  }
}
