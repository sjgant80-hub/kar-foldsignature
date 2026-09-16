// ════════════════════════════════════════════════════════════════
// witness · a deterministic build gate — catch test-theatre and throw-on-malformed BEFORE you push
//
// Four adversarial LLM audit passes across the estate found two classes of problem over and over:
//   1. TEST-THEATRE — a test that stays green even when the behaviour it names is broken.
//   2. THROW-ON-MALFORMED — a validate/verify/classify function that crashes on hostile input
//      (null, BigInt, circular, a toxic getter, a huge array) instead of returning a safe result.
// Both are catchable WITHOUT a language model, deterministically, in seconds:
//   • MUTATION gate — flip one operator in the source, run the tests. If they still pass, that line is
//     unguarded (theatre). A surviving mutant is a hole a real regression would fall straight through.
//   • FUZZ gate — throw the hostile-input battery at a function. If it throws, it fails the never-throw
//     boundary contract.
//
// This is the witness discipline baked into the forge, so the estate stops needing a 1.5M-token audit
// per build. Zero dependencies (Node only — spawns the project's own test runner). Deterministic.
// ════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync, rmSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

// A reviewed-equivalent baseline. Mutation testing has a well-known floor: some mutants are EQUIVALENT
// (semantically identical to the original — an idempotent max-assignment, an out-of-bounds write silently
// dropped by a typed array, a tie-break branch unreachable because ids are unique) and CANNOT be killed by
// any test. They are not test-theatre. Without a way to record them, `clean` is unreachable on real code
// and the gate cries wolf forever. A `witness.baseline.json` next to the source (or in cwd) lists reviewed
// survivors — `[{ mutation, snippet, reason }]` — which are then reported as `ignored`, not counted against
// `clean`. Each entry is a signed-off human judgement, and it is matched by the exact (mutation, code line)
// pair, so it silently stops applying the moment that line changes — you cannot baseline away a future bug.
function loadBaseline(opts, srcPath, cwd) {
  let raw = opts.baseline;
  if (typeof raw === 'string') { try { raw = JSON.parse(readFileSync(raw, 'utf8')); } catch { raw = []; } }
  else if (!Array.isArray(raw)) {
    raw = [];
    for (const p of [join(dirname(srcPath), 'witness.baseline.json'), join(cwd, 'witness.baseline.json')]) {
      try { raw = JSON.parse(readFileSync(p, 'utf8')); break; } catch { /* none here */ }
    }
  }
  const sigs = new Map();
  const rejected = [];
  for (const e of (Array.isArray(raw) ? raw : [])) {
    if (!e || !e.mutation || !e.snippet) continue;
    const sig = `${e.mutation} :: ${e.snippet}`;
    const reason = typeof e.reason === 'string' ? e.reason.trim() : '';
    // ⚑ AN EXEMPTION MUST BE A REASON. This used to read `e.reason || 'reviewed-equivalent'`, which
    // admitted an entry carrying no reason at all and then FABRICATED the sign-off — the report said
    // "reviewed-equivalent" and no human had reviewed anything. A genuinely surviving mutant, real
    // test-theatre, went to `ignored`, `clean` came back true and the process exited 0. And it needed
    // no flag: the loader auto-detects witness.baseline.json beside the source.
    //
    // The bar is a sentence somebody could argue with. Below that it is a shrug, and a shrug is how
    // a gate is talked out of its own verdict. A rejected entry is NOT exempt — the mutant counts as
    // the survivor it is — and it is reported, because silently dropping it is the same bug wearing
    // the other face.
    if (reason.length < MIN_REASON_CHARS) {
      rejected.push({ ...e, why: reason ? `reason is ${reason.length} characters; an exemption needs at least ${MIN_REASON_CHARS}` : 'no reason given' });
      continue;
    }
    sigs.set(sig, reason);
  }
  return { sigs, rejected };
}

// An exemption shorter than this is not an argument. The estate's own rule: under twenty characters
// is a shrug, not an excuse.
export const MIN_REASON_CHARS = 20;

// A child test runner must not inherit OUR test-runner context. node:test sets NODE_TEST_CONTEXT in
// every test-file process; if the `node --test` we spawn inherits it, it switches to the child-reporter
// protocol and exits 0 even when a test FAILS — so every mutant would falsely "survive" whenever witness
// itself runs under `npm test`/CI. Scrub the leak (this bug was found BY witness, running on witness).
function childEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

// ── mutation operators ───────────────────────────────────────────────────────
// Spaced operators only, so we never mis-hit `=>`, `>=` inside `===`, or bit-shifts. Each flips the
// behaviour at exactly one point; a suite that can't tell the difference isn't testing that point.
export const OPERATORS = [
  [' >= ', ' > '], [' <= ', ' < '], [' > ', ' >= '], [' < ', ' <= '],
  [' === ', ' !== '], [' !== ', ' === '], [' == ', ' != '],
  [' && ', ' || '], [' || ', ' && '],
  ['return true', 'return false'], ['return false', 'return true'],
  [' + 1', ' - 1'], [' - 1', ' + 1'],
];

// ── comments are not code, and a comment mutant is not a mutant ──────────────
//
// ⚑ Every offset in the file was fair game, comments included. Rewriting `===` to `!==` inside a
// `//` line changes no behaviour whatsoever, so no test can possibly kill it — the "mutant" ALWAYS
// survives, and witness reports the file as test-theatre on the strength of a sentence somebody
// wrote about the code.
//
// That is not a cosmetic annoyance. It has bitten seven repositories in this estate, always the
// same way: a comment explaining a defect quotes the offending expression, and the quotation
// becomes an unkillable survivor. The gate then says THEATRE about a suite that is fine, which
// leaves two exits — delete the explanation, or baseline the mutant. Both are worse than the
// problem, and the second one trains people to talk the gate out of its verdict, which is the exact
// door MIN_REASON_CHARS above exists to shut. **An instrument that produces failures nobody can fix
// teaches people to ignore it.**
//
// String literals are deliberately NOT skipped. Mutating inside a string really does change the
// program — an error message can be asserted on, a pattern can be compiled — so a surviving string
// mutant is weak evidence but it is still evidence. A comment mutant is not evidence of anything,
// and that is a fact about the language, not a judgement call.
//
// Scanned rather than regexed, because `//` inside a string and a quote inside a comment both defeat
// a regex, and a masker that gets those wrong hides real code instead.
// Where a `/` begins a REGEX rather than a division. Only the unambiguous openers are listed: after
// an identifier, a number, `)` or `]` a slash is division, and guessing wrong in THAT direction would
// consume real code as a pattern. Missing a regex only costs a weak mutant inside it; masking real
// code costs a false clean, so the bias is deliberate.
const REGEX_OPENERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', ';', '}', '+', '-', '*', '%', '^', '~', '<', '>']);
function regexAllowed(prevCode) {
  if (prevCode === null) return true;                 // start of file
  if (REGEX_OPENERS.has(prevCode)) return true;
  return false;
}

export function commentMask(source) {
  const src = String(source ?? '');
  const mask = new Uint8Array(src.length);
  let i = 0;
  const chr10 = String.fromCharCode(10);
  let prev = null;                                    // last significant CODE character seen
  while (i < src.length) {
    const c = src[i], d = src[i + 1];

    // ⚑ A REGEX LITERAL IS NOT A COMMENT, AND `/\//` LOOKS EXACTLY LIKE ONE. The scanner had no
    // branch for regexes: it stepped over the backslash one character at a time, then read the next
    // two as `//` and masked to end of line — or as `/*` and masked to the next `*/` anywhere in the
    // file, swallowing whole functions. Every masked byte is skipped by mutants(), so those decision
    // points were never offered and never reported, and the gate returned clean:true and score 1 for
    // a file with live test-theatre in it. `p.split(/\//g)` is enough to trigger it.
    //
    // That is worse than missing a line: clean:true is an affirmative claim that the line WAS tested.
    if (c === '/' && d !== '/' && d !== '*' && regexAllowed(prev)) {
      i += 1;                                         // past the opening slash
      let inClass = false;
      while (i < src.length) {
        const ch = src[i];
        if (ch === '\\') { i += 2; continue; }        // an escape covers the next character whole
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) { i += 1; break; }
        else if (ch === chr10) break;                  // an unterminated regex is not a regex
        i += 1;
      }
      prev = '/';
      continue;
    }

    if (c === '/' && d === '/') {
      while (i < src.length && src[i] !== '\n') mask[i++] = 1;
      continue;
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      while (i < stop) mask[i++] = 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i += 1; break; }
        i += 1;
      }
      prev = c;
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return mask;
}

// Generate one mutant per operator occurrence (single-point mutation), skipping comment text.
export function mutants(source) {
  const out = [];
  const inComment = commentMask(source);
  for (const [from, to] of OPERATORS) {
    let idx = source.indexOf(from);
    while (idx !== -1) {
      if (!inComment[idx]) {
        const mutated = source.slice(0, idx) + to + source.slice(idx + from.length);
        const line = source.slice(0, idx).split('\n').length;
        out.push({ line, from: from.trim(), to: to.trim(), pos: idx, source: mutated });
      }
      idx = source.indexOf(from, idx + from.length);
    }
  }
  return out;
}

// Run the mutation gate: for each mutant, write it to srcPath, run the test command, and see if the
// tests catch it. A mutant that leaves the tests GREEN survived — that line is unguarded.
//
// CRASH-SAFE. `finally` restores on a normal finish or a thrown error, but NOT on SIGTERM/SIGKILL — a
// hard kill mid-run would leave srcPath holding a live mutant (this actually happened while dogfooding
// witness on itself). So before mutating we drop a sidecar backup holding the true original; if a prior
// run was killed, that backup is still on disk and we self-heal from it on the next run. The estate can
// never be left silently corrupted by an interrupted gate.
// opts: { testCmd?: string[], cwd?: string, cap?: number, timeout?: number, baseline?: string|array }
// ── run the suite once, and leave nothing behind ─────────────────────────────
//
// ⚑ A TIMEOUT KILLED THE CHILD AND ORPHANED ITS DESCENDANTS. spawnSync's `timeout` sends a signal to
// the process it started — and that process is almost never the one doing the work. `npm test`
// spawns `sh`, which spawns `node`. Kill npm and the grandchildren carry on, holding CPU, holding the
// source file open, and racing the next mutant.
//
// This is not cosmetic; it is what stops a gate finishing at all. Gating this very file on a GitHub
// runner leaked 324 processes — 164 node, 82 npm, 78 sh — and the job was SIGTERMed at 75 minutes
// having never printed a score. The same leak locally left 301 node processes alive and turned a
// 3-hour run into a 5-hour one: orphans slow the machine, slow runs hit the wall, timed-out runs
// orphan more. It compounds. The estate had this written down as a Windows quirk. It is not — the
// runner that died was Linux.
//
// The fix is to make the child a process-group leader (`detached`) and then kill the GROUP once the
// run is over, whether it exited or timed out. Killing a group is only safe because of `detached`:
// without it the child shares OUR group and a negative-pid kill would take down witness itself. So
// the two must never be separated, which is why they live in one function and the raw spawnSync
// calls are gone.
// The bound is enforced by runner.mjs, a supervisor that keeps the handle and kills the tree WHILE
// it is still the ancestor — the one moment at which the descendants are still reachable. spawnSync
// keeps its own bound as a backstop, generously larger, for the case where the supervisor itself
// wedges; reapTree() below is a second backstop for whatever escapes both.
const RUNNER = join(dirname(fileURLToPath(import.meta.url)), 'runner.mjs');

function runSuiteOnce(testCmd, { cwd, timeout }) {
  const detached = process.platform !== 'win32';
  const r = spawnSync(process.execPath, [RUNNER, String(timeout), ...testCmd], {
    cwd, env: childEnv(), encoding: 'utf8',
    maxBuffer: 1 << 26, timeout: timeout + 15000, detached,
  });
  reapTree(r.pid, detached);
  return r;
}

// Kill anything the run left behind. Called after EVERY run, not only after a timeout: a suite can
// leak a daemon on its way out just as easily. `catch {}` because "already gone" is the normal case
// and the only other outcome worth a word would be a permissions failure we could not act on anyway.
// Is this a process we could actually own? In kill(2) the target is not always a process: -1 means
// EVERY process the caller may signal and 0 means the caller's own group, so a value that coerces to
// 1 turns a cleanup call into "kill the machine". A pid is an integer above 1 — one is init, zero
// and minus one are broadcasts, and a non-integer is not a pid at all.
//
// Written as separate statements on purpose. As one expression it would carry a `||` that a single
// mutation could collapse into a bypass, and the only way to notice would be to send the signal.
export function isReapablePid(pid) {
  if (!Number.isInteger(pid)) return false;
  if (pid <= 1) return false;
  return true;
}

export function reapTree(pid, detached) {
  // ⚑ A TRUTHY NON-PID COULD SIGNAL THE WHOLE MACHINE. The guard used to be `!pid`, which stops 0
  // and -0 but lets through anything else truthy — and in kill(2) the target is not just a process:
  // `kill(-1, …)` means EVERY process the caller may signal, and `kill(0, …)` means the caller's own
  // group. So `reapTree(true)` or `reapTree('1')` computes -1 and sends SIGKILL to everything.
  //
  // This is not hypothetical. A test in this repo passed `true` in a list of hostile inputs, and on
  // the Linux CI runner it killed the runner agent itself: the job reported no conclusion at all
  // for the step, because nothing survived to report one. In normal use `pid` comes from spawnSync
  // and is a real child, which is exactly the kind of "cannot happen" this session keeps disproving.
  //
  // ⚑ AND THE GUARD MUST NOT BE TESTABLE BY CALLING IT. The first fix put the check inline here, as
  // `!Number.isInteger(pid) || pid <= 1`, and the only way to assert it was to hand reapTree a
  // broadcast value and check it came back false. That is a test which, under the very mutation it
  // exists to catch, SENDS THE SIGNAL: flip `<=` to `<` and reapTree(1) reaches process.kill(-1),
  // which is SIGKILL to every process the user owns. The suite then kills the runner instead of
  // reporting a survivor, the step ends with no conclusion at all, and the gate can never go green —
  // it took four CI runs to see that the gate was not failing, it was dying.
  //
  // So the decision is a pure predicate, asserted without sending anything, and the guards here are
  // separate statements rather than one expression: there is no `||` left for a mutation to collapse
  // into a bypass, and nothing below can be reached with a target that is not a real child.
  if (!isReapablePid(pid)) return false;
  if (pid === process.pid) return false;            // never signal ourselves
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
    } else {
      if (!detached) return false;                  // no group of our own to kill — refuse rather than guess
      process.kill(-pid, 'SIGKILL');                // negative pid = the whole process group
    }
    return true;
  } catch {
    return false;                                   // the group had already gone, which is the good case
  }
}

// Is the per-mutant bound comfortably above an honest run of the suite? Only a mutant that genuinely
// hangs should ever reach the wall; if a NORMAL run is anywhere near it, every mutant times out, each
// timeout counts as KILLED, and the gate scores a perfect clean having finished nothing.
//
// Pulled out as a pure function on purpose. Testing it through a real subprocess means engineering a
// suite whose duration lands in a factor-of-two window, which is a coin toss on a loaded machine —
// so the decision is checked exactly here, and the wiring is checked loosely.
export const BOUND_HEADROOM = 2;
export function boundIsAdequate(baselineMs, timeout) {
  if (!Number.isFinite(baselineMs) || !Number.isFinite(timeout)) return false;
  return baselineMs * BOUND_HEADROOM <= timeout;
}

// The backup is the one file that must never be half-written: it is what a killed run recovers from,
// and a truncated one is worse than none because the recovery applies it. Written to a temp name and
// renamed, so on disk it either does not exist or is complete.
function writeBackupAtomically(backup, contents) {
  const tmp = backup + '.tmp';
  writeFileSync(tmp, contents);
  renameSync(tmp, backup);        // atomic on POSIX and on Windows for a same-directory rename
}

export function runMutations(srcPath, opts = {}) {
  const backup = srcPath + '.witnessbak';
  // Self-heal: a leftover backup means a previous run was hard-killed with srcPath mutated. The backup
  // holds the real original — restore from it before reading, so a crash never poisons the next run.
  //
  // ⚑ THE RECOVERY PATH WAS THE CORRUPTION PATH. This restored from the backup unconditionally, and
  // the backup used to be written with a plain writeFileSync — which is not atomic. A hard kill
  // DURING that write is the exact scenario this mechanism exists for, and it leaves a TRUNCATED
  // backup on disk. The next run then dutifully copied that truncation over the real source. An empty
  // backup emptied the file. It happened to this repo's own fixture, and the run that did it went on
  // to report a clean gate, because a file with nothing in it has no mutants and no mutants used to
  // score 1.0 (see below). "The estate can never be left silently corrupted by an interrupted gate"
  // was the promise directly above this line.
  //
  // Two changes. The backup is now written atomically — to a temp file, then renamed, so it either
  // does not exist or is complete. And a backup that is EMPTY while the source is not is refused
  // rather than applied: it is not a recovery, it is a loss, and the operator is told so instead of
  // being handed a green.
  if (existsSync(backup)) {
    const saved = readFileSync(backup, 'utf8');
    const current = existsSync(srcPath) ? readFileSync(srcPath, 'utf8') : '';
    if (saved === '' && current !== '') {
      throw new Error(
        `witness: ${backup} is empty, which means a previous run was killed while writing it. ` +
        `Restoring from it would destroy ${srcPath}. Delete the backup once you have confirmed ` +
        `${srcPath} is the source you want, then run again.`);
    }
    writeFileSync(srcPath, saved);
    rmSync(backup);
  }
  const original = readFileSync(srcPath, 'utf8');
  writeBackupAtomically(backup, original);   // durable copy of truth, survives even a SIGKILL
  const cwd = opts.cwd || process.cwd();
  const testCmd = opts.testCmd || ['npm', 'test'];
  const cap = opts.cap ?? 80;
  // Per-mutant timeout. Some mutants break termination (flip `lo < hi` → `lo <= hi` in a binary search and
  // the loop never exits). Without a bound, one such mutant hangs the whole gate forever — this actually
  // happened sweeping fallherd. A timed-out run is a mutant the suite could NOT survive, i.e. KILLED.
  const timeout = opts.timeout ?? 20000;
  const { sigs: baseline, rejected: rejectedExemptions } = loadBaseline(opts, srcPath, cwd);

  // BASELINE-GREEN GUARD. If the UNMUTATED suite does not already pass, every mutant will also "fail" and be
  // counted as KILLED — a false clean. This is exactly how a missing package.json (npm test errors) or a
  // broken generated test silently produced a green verdict. Refuse to gate a red baseline.
  {
    const started = Date.now();
    const base = runSuiteOnce(testCmd, { cwd, timeout });
    const baselineMs = Date.now() - started;
    if (base.status !== 0) {
      if (existsSync(backup)) rmSync(backup);
      return { total: 0, capped: false, killed: 0, survived: [], ignored: [], score: 0, clean: false,
        baselineFailed: true, reason: 'the unmutated test suite does not pass — cannot gate (a red baseline makes every mutant look killed)' };
    }
    // ⚑ THE BOUND MUST BE COMFORTABLY ABOVE THE SUITE, AND NOTHING USED TO CHECK.
    // A timed-out run counts as KILLED, which is right for a mutant that hangs and catastrophic for
    // one that was merely slow: a suite slower than the bound makes EVERY mutant time out, so the
    // gate scores a perfect 100% having proved nothing at all. It is the worst kind of false clean,
    // because the number it produces is the best possible one. The estate has already been bitten:
    // a repo with real filesystem fixtures ran 16s typical and 37s under load against a 20s wall.
    // This file's own suite now takes ~107s, and gating it with the 20s default would have reported
    // a flawless score from a run in which not one test ever finished.
    // The baseline has just been timed, so the check costs nothing: refuse when the bound is not at
    // least twice the honest run. Only a mutant that genuinely hangs should ever reach the wall.
    if (!boundIsAdequate(baselineMs, timeout)) {
      if (existsSync(backup)) rmSync(backup);
      return { total: 0, capped: false, killed: 0, survived: [], ignored: [], score: 0, clean: false,
        baselineFailed: true, baselineMs,
        reason: `the per-mutant bound (${timeout}ms) is not comfortably above the suite's own run (${baselineMs}ms). `
          + `Every mutant would time out and be counted KILLED, scoring a perfect clean from a gate that finished nothing. `
          + `Pass --timeout ${Math.max(timeout, baselineMs * 3)} or faster tests.` };
    }
  }

  let all = mutants(original);
  const capped = all.length > cap;
  all = all.slice(0, cap);

  const survived = [], ignored = [];
  let killed = 0;
  try {
    for (const m of all) {
      writeFileSync(srcPath, m.source);
      const r = runSuiteOnce(testCmd, { cwd, timeout });
      // Killed unless the tests genuinely PASSED. status 0 = passed ⇒ survived. A timeout kills the child
      // (status null, signal set) ⇒ not passed ⇒ killed, which is correct: a mutant that hangs is caught.
      const passed = r.status === 0;
      if (passed) {
        const entry = { line: m.line, mutation: `${m.from} → ${m.to}`, snippet: lineOf(original, m.line) };
        const sig = `${entry.mutation} :: ${entry.snippet}`;
        if (baseline.has(sig)) ignored.push({ ...entry, reason: baseline.get(sig) });
        else survived.push(entry);
      } else killed++;
    }
  } finally {
    writeFileSync(srcPath, original);   // restore on a normal finish or a thrown error
    if (existsSync(backup)) rmSync(backup);   // and drop the sidecar — a clean exit needs no self-heal
  }

  return {
    total: all.length,
    capped: capped ? all.length : false,
    killed,
    survived,
    ignored,                                   // reviewed-equivalent survivors, with reasons — not theatre
    // ⚑ Entries the baseline REFUSED, reported rather than dropped. An exemption that quietly failed
    // to apply looks exactly like one that was never written, and the mutant it named is now counted
    // as the survivor it always was.
    rejectedExemptions,
    // ⚑ NO MUTANTS USED TO SCORE 1.0 AND REPORT CLEAN. A file the gate could find nothing to mutate
    // in — a mistyped path, a README, a config, a source emptied by the recovery bug above — came
    // back with a perfect score and a green verdict. That is the same false clean as a suite slower
    // than the timeout: a number produced by a gate that ran nothing. An empty run proves nothing, so
    // it says so, and CI that reads `clean` fails instead of passing.
    score: all.length ? Math.round((killed / all.length) * 1000) / 1000 : null,
    clean: all.length > 0 && survived.length === 0,   // clean = mutants existed AND none survived unreviewed
    ...(all.length === 0 && {
      noMutants: true,
      reason: `no mutable operator found in ${srcPath} — nothing was tested, so this is not a pass. Check the path, and that the file contains spaced operators the gate knows how to flip.`,
    }),
  };
}

// ── fuzz gate ────────────────────────────────────────────────────────────────
// The hostile-input battery — every value class that crashed a verify/classify/validate in the audits.
export function hostileInputs() {
  const circular = {}; circular.self = circular;
  const toxicGetter = { get x() { throw new Error('toxic getter'); }, get id() { throw new Error('toxic id'); } };
  const toxicToString = { toString() { throw new Error('toxic toString'); } };
  return [
    ['null', null], ['undefined', undefined], ['NaN', NaN], ['Infinity', Infinity],
    ['empty string', ''], ['whitespace', '   '], ['empty array', []], ['empty object', {}],
    ['true', true], ['false', false], ['BigInt', 10n], ['function', () => {}],
    ['huge string', 'x'.repeat(200000)], ['huge array', new Array(200000).fill(0)],
    ['circular object', circular], ['toxic getter', toxicGetter], ['toxic toString', toxicToString],
    ['negative', -1], ['zero', 0], ['nested', { a: { b: { c: null } } }],
  ];
}

// Throw the battery at `fn`; return the inputs that made it THROW (empty ⇒ it honours the never-throw
// boundary). Async-aware. Use for functions documented as tolerant (verify/validate/classify/parse).
export async function fuzz(fn) {
  const throwsOn = [];
  for (const [label, value] of hostileInputs()) {
    try { await fn(value); }
    catch (e) { throwsOn.push({ input: label, error: String(e && e.message || e).slice(0, 80) }); }
  }
  return { throwsOn, neverThrows: throwsOn.length === 0 };
}

function lineOf(src, n) { return (src.split('\n')[n - 1] || '').trim().slice(0, 90); }

// ── CLI ──────────────────────────────────────────────────────────────────────
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'mutate') {
    const [srcPath] = rest;
    if (!srcPath) { console.error('usage: witness mutate <sourceFile> [--cap N] [--timeout MS] [--baseline <file>] [--test <cmd...>]'); process.exit(2); }
    const capArg = rest.indexOf('--cap');
    const cap = capArg !== -1 ? Number(rest[capArg + 1]) : 80;
    const baseArg = rest.indexOf('--baseline');   // else auto-detects witness.baseline.json by the source
    const baseline = baseArg !== -1 ? rest[baseArg + 1] : undefined;

    // ⚑ The per-run bound was fixed at 20s and unreachable from the command line, which meant witness
    // could not gate ANY project whose suite honestly takes longer — and the failure was silent in the
    // worst possible way. A timed-out run counts as KILLED, so a suite that is always too slow scores
    // a perfect 100% having proved nothing. Worse, on Windows the killed subprocess tree orphans; the
    // orphans slow the next run, which then also times out. A repository with real filesystem fixtures
    // walked straight into that: 16s typical, 37s under load, against a 20s wall.
    //
    // Must be given BEFORE --test, because --test deliberately swallows everything after it.
    const toArg = rest.indexOf('--timeout');
    const timeout = toArg !== -1 && toArg < (rest.indexOf('--test') === -1 ? Infinity : rest.indexOf('--test'))
      ? Number(rest[toArg + 1]) : undefined;
    if (toArg !== -1 && !(timeout > 0)) {
      console.error('witness: --timeout wants a positive number of milliseconds, and must come before --test');
      process.exit(2);
    }
    // Everything after `--test` is the target project's test command (put it LAST). Defaults to `npm test`,
    // so the gate can target any repo's own runner — that's what makes witness usable as a CI Action.
    const testArg = rest.indexOf('--test');
    const testCmd = testArg !== -1 && rest.length > testArg + 1 ? rest.slice(testArg + 1) : undefined;
    console.error(`mutation gate: ${srcPath}${testCmd ? ` · tests: ${testCmd.join(' ')}` : ''} …`);
    const r = runMutations(srcPath, { cap, testCmd, baseline, timeout });
    console.log(JSON.stringify(r, null, 2));
    const ign = r.ignored.length ? `, ${r.ignored.length} reviewed-equivalent ignored` : '';
    // ⚑ Say it out loud. A refused exemption that nobody mentions looks exactly like one that was
    // never written, and the author goes on believing the mutant is excused.
    for (const x of (r.rejectedExemptions || [])) {
      console.error(`  ⚑ baseline entry REFUSED (${x.why}) — this mutant counts as a survivor: ${x.mutation} :: ${String(x.snippet).slice(0, 70)}`);
    }
    // A run with nothing to mutate is not a pass and must not print like one. It used to reach the
    // ✓ branch and exit 0, so a mistyped path was indistinguishable from a gated file.
    if (r.noMutants) console.error(`\n✗ NOTHING WAS TESTED — ${r.reason}`);
    else if (!r.clean) console.error(`\n✗ ${r.survived.length} mutant(s) SURVIVED — those lines are test-theatre.${ign}`);
    else console.error(`\n✓ ${r.killed}/${r.total} killed${ign} — no test-theatre.`);
    process.exit(r.clean ? 0 : 1);
  }
  if (cmd === 'fuzz') {
    const [modulePath, exportName] = rest;
    if (!modulePath || !exportName) { console.error('usage: witness fuzz <module.mjs> <exportedFnName>'); process.exit(2); }
    const mod = await import(new URL(modulePath, `file://${process.cwd()}/`).href);
    const fn = mod[exportName];
    if (typeof fn !== 'function') { console.error(`${exportName} is not an exported function`); process.exit(2); }
    const r = await fuzz(fn);
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.neverThrows ? 0 : 1);
  }
  console.error('witness — deterministic build gate\n  witness mutate <sourceFile> [--cap N]\n  witness fuzz <module.mjs> <exportedFnName>');
  process.exit(2);
}

// ⛑ THIS GUARD COMPARED A RAW PATH AGAINST A PERCENT-ENCODED URL. import.meta.url encodes, argv[1]
// does not — so in any directory whose name needs encoding (a SPACE, an accent, any CJK character)
// neither hand-built form matched, main() was never called, and the process fell off the end of the
// module printing nothing and exiting 0. CI reads exit 0 as a clean gate.
//
// That is this tool's own worst failure — a green from a run that did nothing — reached by the most
// ordinary fact about a filesystem there is, and it is not a Windows quirk: /home/josé encodes too.
// Reproduced by copying witness into a folder called "my gate": no banner, no JSON, no verdict,
// exit 0, on a file with a live surviving mutant.
//
// Canonical URLs on both sides, so there is nothing left to hand-build wrongly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export default { mutants, runMutations, fuzz, OPERATORS, hostileInputs };
