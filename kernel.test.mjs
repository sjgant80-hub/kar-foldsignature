import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as K from './kernel.mjs';

test('hash() pins exact rolling-hash values for short strings', () => {
  assert.equal(K.hash('').ok, true);
  assert.equal(K.hash('').value, 0);
  assert.equal(K.hash('a').value, 97);
  assert.equal(K.hash('ab').value, 3105);
});

test('foldSignature pins exact signatures for simple scalar values', () => {
  const t = K.foldSignature(true);
  assert.equal(t.ok, true);
  assert.equal(t.canonical, 'true');
  assert.equal(t.signature, 3569038);

  const f = K.foldSignature(false);
  assert.equal(f.canonical, 'false');
  assert.equal(f.signature, 97196323);
});

test('arrays are order-sensitive: same elements, different order fold to different pinned signatures', () => {
  const s12 = K.foldSignature([1, 2]);
  assert.equal(s12.canonical, '[1,2]');
  assert.equal(s12.signature, 85544097);

  const s21 = K.foldSignature([2, 1]);
  assert.equal(s21.canonical, '[2,1]');
  assert.equal(s21.signature, 85573857);

  assert.notEqual(s12.signature, s21.signature);
  assert.equal(K.sameSignature([1, 2], [1, 2]).equal, true);
});

test('objects are key-order-insensitive: keys are sorted before hashing', () => {
  const c1 = K.canonicalForm({ b: 1, a: 2 });
  const c2 = K.canonicalForm({ a: 2, b: 1 });
  assert.equal(c1.canonical, '{"a":2,"b":1}');
  assert.equal(c1.canonical.length, 13);
  assert.equal(c2.canonical, c1.canonical);
  assert.equal(K.sameSignature({ b: 1, a: 2 }, { a: 2, b: 1 }).equal, true);
});

test('bad input is total: {ok:false, why} instead of throwing', () => {
  assert.equal(K.foldSignature(undefined).ok, false);
  assert.equal(K.foldSignature(NaN).ok, false);
  assert.equal(K.foldSignature(function () {}).ok, false);
  assert.equal(K.canonicalForm(new Date()).ok, false);

  const circ = {};
  circ.self = circ;
  assert.equal(K.foldSignature(circ).ok, false);

  assert.equal(K.hash(42).ok, false);
  assert.equal(K.hash(null).ok, false);
});

// ⚑ isPlainObject's null-check is unreachable through canonicalizeInternal's
// only call site (value there is already guaranteed non-null typeof 'object'),
// so mutants on that guard are equivalent/undetectable through the public
// canonicalForm/foldSignature surface alone. Pin isPlainObject directly.
test('isPlainObject(null) is false, and does not throw reaching Object.getPrototypeOf', () => {
  // Kills || -> &&: under &&, the clause pair (false && true) no longer
  // short-circuits to `return false`, so execution falls through to
  // Object.getPrototypeOf(null), which throws TypeError. assert.equal must
  // both not throw AND observe false.
  let threw = false;
  let result;
  try {
    result = K.isPlainObject(null);
  } catch {
    threw = true;
  }
  assert.equal(threw, false);
  assert.equal(result, false);
});

test('isPlainObject(42) is false, not true (non-object, typeof clause)', () => {
  // Kills return false -> return true: 42 satisfies typeof!=='object', so the
  // guard clause is live; original returns false, mutant returns true.
  assert.equal(K.isPlainObject(42), false);
});

test('isPlainObject accepts only plain object literals, not arrays/dates/class instances', () => {
  assert.equal(K.isPlainObject({}), true);
  assert.equal(K.isPlainObject({ a: 1 }), true);
  assert.equal(K.isPlainObject([]), false);
  assert.equal(K.isPlainObject(new Date()), false);
  assert.equal(K.isPlainObject(Object.create(null)), true);
});
