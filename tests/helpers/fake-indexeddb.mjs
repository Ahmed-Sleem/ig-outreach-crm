/**
 * A minimal in-memory IndexedDB, just large enough for src/storage/db.js.
 *
 * Why hand-rolled: the project is deliberately zero-dependency so that `npm test`
 * works on a bare Node install with no lockfile and no supply chain. Pulling in
 * fake-indexeddb to test one 160-line module would trade that for convenience.
 *
 * This is NOT a spec-compliant implementation. It supports only what db.js calls:
 * open/onupgradeneeded with versioning, createObjectStore/deleteObjectStore,
 * objectStoreNames.contains, autoIncrement keyPath, single and compound indexes,
 * add/put/get/getAll/delete/clear, openCursor with direction and IDBKeyRange.only, and
 * transaction oncomplete/onerror. Anything else is intentionally absent so that a
 * future call to an unsupported API throws loudly instead of silently passing.
 */

/** Queue a callback the way a real IDB request fires: async, after the caller returns. */
const soon = (fn) => queueMicrotask(fn);

class FakeRequest {
  constructor() {
    this.result = undefined;
    this.error = null;
    this.onsuccess = null;
    this.onerror = null;
  }
  _succeed(value, tx = null) {
    this.result = value;
    if (tx) tx._enter();
    soon(() => {
      if (this.onsuccess) this.onsuccess({ target: this });
      if (tx) tx._leave();
    });
  }

  /** A failed request aborts its transaction, the way real IndexedDB does. */
  _fail(error, tx = null) {
    this.error = error;
    if (tx) tx._fail(error);
    soon(() => {
      if (this.onerror) this.onerror({ target: this });
    });
  }
}

class FakeIndex {
  constructor(store, name, keyPath) {
    this.store = store;
    this.name = name;
    this.keyPath = keyPath;
  }

  _keyFor(row) {
    if (Array.isArray(this.keyPath)) return this.keyPath.map((k) => row[k]);
    return row[this.keyPath];
  }

  openCursor(range = null, direction = 'next') {
    const req = new FakeRequest();
    let rows = [...this.store.rows.values()];

    if (range) rows = rows.filter((r) => range.includes(this._keyFor(r)));

    const cmp = (a, b) => {
      const ka = this._keyFor(a);
      const kb = this._keyFor(b);
      const aa = Array.isArray(ka) ? ka : [ka];
      const bb = Array.isArray(kb) ? kb : [kb];
      for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
        if (aa[i] === bb[i]) continue;
        return aa[i] < bb[i] ? -1 : 1;
      }
      return 0;
    };
    rows.sort(cmp);
    if (direction === 'prev') rows.reverse();

    const tx = this.store._tx ?? null;
    let i = 0;
    if (tx) tx._enter();
    const step = () => {
      if (i >= rows.length) {
        req.result = null;
        if (req.onsuccess) req.onsuccess({ target: req });
        if (tx) tx._leave();
        return;
      }
      const value = rows[i++];
      let advanced = false;
      req.result = { value, continue: () => { advanced = true; soon(step); } };
      if (req.onsuccess) req.onsuccess({ target: req });
      // db.js stops calling continue() once it has enough rows; that ends the walk.
      if (!advanced && tx) tx._leave();
    };
    soon(step);
    return req;
  }
}

class FakeObjectStore {
  constructor(name, { keyPath = null, autoIncrement = false } = {}) {
    this.name = name;
    this.keyPath = keyPath;
    this.autoIncrement = autoIncrement;
    this.rows = new Map();
    this.indexes = new Map();
    this.nextKey = 1;
    this._tx = null;
  }

  createIndex(name, keyPath) {
    const idx = new FakeIndex(this, name, keyPath);
    this.indexes.set(name, idx);
    return idx;
  }

  index(name) {
    const idx = this.indexes.get(name);
    if (!idx) throw new Error(`No such index: ${name}`);
    return idx;
  }

  add(value) {
    const req = new FakeRequest();
    let key = this.keyPath ? value[this.keyPath] : undefined;
    if (key === undefined && this.autoIncrement) {
      key = this.nextKey++;
      value = { ...value, [this.keyPath]: key };
    }
    if (this.rows.has(key)) {
      req._fail(new Error('ConstraintError: key already exists'), this._tx);
      return req;
    }
    this.rows.set(key, value);
    req._succeed(key, this._tx);
    return req;
  }

  put(value) {
    const req = new FakeRequest();
    let key = this.keyPath ? value[this.keyPath] : undefined;
    if (key === undefined && this.autoIncrement) {
      key = this.nextKey++;
      value = { ...value, [this.keyPath]: key };
    }
    this.rows.set(key, value);
    req._succeed(key, this._tx);
    return req;
  }

  getAll() {
    const req = new FakeRequest();
    req._succeed([...this.rows.values()], this._tx);
    return req;
  }

  get(key) {
    const req = new FakeRequest();
    req._succeed(this.rows.get(key), this._tx);
    return req;
  }

  delete(key) {
    const req = new FakeRequest();
    this.rows.delete(key);
    req._succeed(undefined, this._tx);
    return req;
  }

  clear() {
    const req = new FakeRequest();
    this.rows.clear();
    req._succeed(undefined, this._tx);
    return req;
  }
}

class FakeTransaction {
  constructor(db, storeNames) {
    this.db = db;
    this.names = Array.isArray(storeNames) ? storeNames : [storeNames];
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this.error = null;
    this._settled = false;
    // Real IndexedDB keeps a transaction alive while any request is outstanding and
    // commits only once none remain. Guessing a fixed number of microtask hops
    // instead truncates cursor walks — which is exactly the bug this replaced.
    this._pending = 0;
    this._started = false;
    soon(() => { this._started = true; this._maybeComplete(); });
  }
  _enter() { this._pending += 1; }
  _leave() {
    this._pending -= 1;
    soon(() => this._maybeComplete());
  }
  _maybeComplete() {
    if (this._settled || !this._started || this._pending > 0) return;
    this._complete();
  }
  _fail(error) {
    if (this._settled) return;
    this._settled = true;
    this.error = error;
    if (this.onerror) this.onerror();
    if (this.onabort) this.onabort();
  }
  objectStore(name) {
    const s = this.db.stores.get(name);
    if (!s) throw new Error(`No such object store: ${name}`);
    s._tx = this;
    return s;
  }
  _complete() {
    if (this._settled) return;
    this._settled = true;
    if (this.oncomplete) this.oncomplete();
  }
}

class FakeDatabase {
  constructor(name, version) {
    this.name = name;
    this.version = version;
    this.stores = new Map();
    this.onversionchange = null;
  }
  get objectStoreNames() {
    const names = [...this.stores.keys()];
    return { contains: (n) => names.includes(n), length: names.length, [Symbol.iterator]: () => names[Symbol.iterator]() };
  }
  createObjectStore(name, opts) {
    const s = new FakeObjectStore(name, opts);
    this.stores.set(name, s);
    return s;
  }
  deleteObjectStore(name) {
    this.stores.delete(name);
  }
  transaction(names) {
    return new FakeTransaction(this, names);
  }
  close() {}
}

class FakeKeyRange {
  constructor(value) { this.value = value; }
  includes(key) {
    if (Array.isArray(key)) return false;
    return key === this.value;
  }
  static only(value) { return new FakeKeyRange(value); }
}

/**
 * Install the fake as a global. `seed` lets a test pretend a previous version of
 * the database already exists on disk, which is the only way to exercise a
 * migration path.
 *
 * @param {{version?: number, stores?: string[]}|null} seed
 */
export function installFakeIndexedDB(seed = null) {
  const databases = new Map();

  if (seed) {
    const db = new FakeDatabase('ig-intel', seed.version ?? 1);
    for (const name of seed.stores ?? []) {
      const opts = name === 'scans' ? { keyPath: 'id', autoIncrement: true } : { keyPath: 'key' };
      const store = db.createObjectStore(name, opts);
      if (name === 'scans') {
        store.createIndex('username', 'username');
        store.createIndex('scannedAt', 'scannedAt');
        store.createIndex('username_scannedAt', ['username', 'scannedAt']);
      }
    }
    databases.set('ig-intel', db);
  }

  const factory = {
    open(name, version) {
      const req = new FakeRequest();
      req.onupgradeneeded = null;
      req.onblocked = null;

      soon(() => {
        let db = databases.get(name);
        const oldVersion = db ? db.version : 0;
        if (!db) {
          db = new FakeDatabase(name, version);
          databases.set(name, db);
        }
        req.result = db;

        if (version > oldVersion) {
          db.version = version;
          if (req.onupgradeneeded) req.onupgradeneeded({ oldVersion, newVersion: version, target: req });
        }
        soon(() => req.onsuccess && req.onsuccess({ target: req }));
      });
      return req;
    },
  };

  globalThis.indexedDB = factory;
  globalThis.IDBKeyRange = FakeKeyRange;
  globalThis.navigator = globalThis.navigator ?? {};

  return {
    databases,
    uninstall() {
      delete globalThis.indexedDB;
      delete globalThis.IDBKeyRange;
    },
  };
}
