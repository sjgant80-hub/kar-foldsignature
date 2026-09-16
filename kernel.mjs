// kernel.mjs
// FoldSignature: pure kernel that computes a canonical structural signature
// for nested JSON-like values. Object keys are sorted before hashing (so
// key-insertion order never matters); array element order is preserved (so
// arrays ARE order-sensitive). No I/O. Every exported function is total:
// bad input returns {ok:false, why:...} instead of throwing.

export function isPlainObject(value) {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Recursive canonicalizer. `stack` holds the objects/arrays currently being
// visited on the path from the root, so a true cycle (an object reachable
// from itself) is detected without ever throwing a RangeError.
function canonicalizeInternal(value, stack) {
  if (value === null) return { ok: true, out: 'null' };

  const t = typeof value;

  if (t === 'boolean') return { ok: true, out: value ? 'true' : 'false' };

  if (t === 'number') {
    if (!Number.isFinite(value)) {
      return { ok: false, why: `non-finite number: ${String(value)}` };
    }
    return { ok: true, out: String(value) };
  }

  if (t === 'string') return { ok: true, out: JSON.stringify(value) };

  if (t === 'undefined') return { ok: false, why: 'undefined is not representable' };
  if (t === 'function') return { ok: false, why: 'function is not representable' };
  if (t === 'symbol') return { ok: false, why: 'symbol is not representable' };
  if (t === 'bigint') return { ok: false, why: 'bigint is not representable' };

  // t === 'object' and value !== null from here on.
  if (stack.includes(value)) {
    return { ok: false, why: 'circular reference detected' };
  }

  if (Array.isArray(value)) {
    stack.push(value);
    const parts = [];
    for (let i = 0; i < value.length; i++) {
      const r = canonicalizeInternal(value[i], stack);
      if (!r.ok) { stack.pop(); return r; }
      parts.push(r.out);
    }
    stack.pop();
    return { ok: true, out: '[' + parts.join(',') + ']' };
  }

  if (!isPlainObject(value)) {
    return { ok: false, why: 'non-plain object is not representable' };
  }

  stack.push(value);
  const keys = Object.keys(value).sort(); // canonical order: sorted keys
  const parts = [];
  for (const key of keys) {
    const r = canonicalizeInternal(value[key], stack);
    if (!r.ok) { stack.pop(); return r; }
    parts.push(JSON.stringify(key) + ':' + r.out);
  }
  stack.pop();
  return { ok: true, out: '{' + parts.join(',') + '}' };
}

// canonicalForm(value) -> {ok:true, canonical:string} | {ok:false, why:string}
export function canonicalForm(value) {
  const r = canonicalizeInternal(value, []);
  if (!r.ok) return { ok: false, why: r.why };
  return { ok: true, canonical: r.out };
}

// hash(str) -> {ok:true, value:number} | {ok:false, why:string}
// Deterministic 32-bit rolling hash (h = h*31 + charCode, wrapped unsigned).
export function hash(str) {
  if (typeof str !== 'string') {
    return { ok: false, why: 'hash input must be a string' };
  }
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(h, 31) + str.charCodeAt(i)) >>> 0;
  }
  return { ok: true, value: h };
}

// foldSignature(value) -> {ok:true, signature:number, canonical:string} | {ok:false, why:string}
export function foldSignature(value) {
  const form = canonicalForm(value);
  if (!form.ok) return { ok: false, why: form.why };
  const h = hash(form.canonical);
  if (!h.ok) return { ok: false, why: h.why };
  return { ok: true, signature: h.value, canonical: form.canonical };
}

// sameSignature(a, b) -> {ok:true, equal:boolean} | {ok:false, why:string}
export function sameSignature(a, b) {
  const sa = foldSignature(a);
  if (!sa.ok) return { ok: false, why: sa.why };
  const sb = foldSignature(b);
  if (!sb.ok) return { ok: false, why: sb.why };
  return { ok: true, equal: sa.signature === sb.signature };
}
