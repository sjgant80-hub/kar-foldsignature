#!/usr/bin/env node
// runner.mjs — run one test command under a bound, and take its whole tree down with it.
//
// ⚑ WHY THIS PROCESS EXISTS AT ALL. witness used to hand the bound to spawnSync's own `timeout`,
// which signals the process it started — and that process is almost never the one doing the work.
// `npm test` spawns `sh`, which spawns `node`. Node kills npm; the grandchildren carry on.
//
// The reason it cannot be fixed in the parent is timing. By the moment spawnSync RETURNS, the child
// it killed is already dead, and with it every link witness could have followed to find the rest:
// on Windows the tree is walked parent-to-child, so an orphan whose parent has gone is unreachable;
// on POSIX the group survives, which is why a group kill helps there and nowhere else. The killing
// has to happen while the parent is still alive, and nothing that blocks until the child exits can
// do that. So a supervisor sits in between, holding the handle, watching its own clock.
//
//   node runner.mjs <timeoutMs> <cmd> [args...]
//
// Exits with the child's own code, or 124 (the conventional timeout code) when the bound was hit.
// Either way the tree is gone before this process returns.
import { spawn, spawnSync } from 'node:child_process';

const [, , boundArg, ...cmd] = process.argv;
const bound = Number(boundArg);
if (!Number.isFinite(bound) || bound <= 0 || cmd.length === 0) {
  console.error('runner: usage — node runner.mjs <timeoutMs> <cmd> [args...]');
  process.exit(2);
}

const onWindows = process.platform === 'win32';

// ⚑ ONE ARGUMENT WITH SPACES IN IT IS A COMMAND LINE, NOT A FILENAME.
// `--test "node --test a.mjs"` reaches us as a single argv element. Windows ran everything through
// a shell anyway, so it worked there and only there; on POSIX the shell was off, and cmd[0] was
// looked up as an executable literally named "node --test a.mjs" — which cannot exist. spawn fails
// instantly, the baseline is read as red, and the gate refuses to run against a perfectly green
// tree. Same root as the false greens this tool exists to catch: a spawn nobody checked started.
const isCommandLine = cmd.length === 1 && /\s/.test(cmd[0]);

// ⚑ AND THE SHELL IS NOT FREE. Turning it on unconditionally on Windows re-splits the command on
// spaces, so an absolute interpreter path under "Program Files" is torn in half and the run dies as
// 'C:\Program' is not recognized. The shell is needed for a command LINE anywhere, and for a bare
// name on Windows (npm is really npm.cmd, which spawn cannot find on its own). Handed an actual
// path, spawn it directly — that is the one form that survives a space in the path.
const bareName = !/[\\/]/.test(cmd[0]);
const useShell = isCommandLine || (onWindows && bareName);
const child = spawn(
  cmd[0],
  isCommandLine ? [] : cmd.slice(1),
  {
    stdio: 'inherit',
    shell: useShell,         // npm is npm.cmd on Windows; a quoted command line needs a shell anywhere
    detached: !onWindows,    // POSIX: its own process group, so one signal reaches the whole tree
  },
);

// Kill the tree while this process is still its ancestor and the links still resolve.
function killTree() {
  try {
    if (onWindows) spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { /* already gone is the good case */ }
}

let timedOut = false;
const timer = setTimeout(() => { timedOut = true; killTree(); }, bound);

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  // Even on a clean exit: a suite can leave a daemon behind on its way out, and the next mutant
  // would then be racing it. Sweep regardless of how the run ended.
  killTree();
  if (timedOut) process.exit(124);
  process.exit(signal ? 128 + 15 : (code ?? 1));
});

child.on('error', (e) => {
  clearTimeout(timer);
  console.error(`runner: could not start ${cmd[0]}: ${e.message}`);
  process.exit(127);
});
