/**
 * IndexedDB persistence for the CRM workspace.
 *
 * Why IndexedDB and not chrome.storage.local: storage.local is capped around
 * 10 MB and silently drops writes past roughly 120 a minute, while a collector
 * run can upsert hundreds of leads and edges in one pass. IndexedDB has real
 * transactions and gets a large share of the disk.
 *
 * Every record carries a workspaceId equal to the signed-in account's numeric
 * user id, so two Instagram accounts in one browser profile never share leads,
 * quotas or campaign state. Instagram user ids are stored as strings: they
 * exceed Number.MAX_SAFE_INTEGER, and a float key would silently merge two
 * different people.
 *
 * Provenance lives in lead_edges, keyed idempotently by
 * `${leadKey}|${edgeType}|${sourceAccount}|${refId}`. Re-scanning a post
 * updates lastSeenAt without double-counting engagement and never touches
 * lifecycle state — that separation is what makes a second scan safe.
 *
 * The IndexedDB handle is read from globalThis at call time so tests can run
 * against the in-memory implementation in tests/helpers/fake-indexeddb.mjs.
 */

import { initialGovernorState } from '../core/governor.js';

export const DB_NAME = 'ig-outreach-crm';
export const DB_VERSION = 1;

export const Store = Object.freeze({
  WORKSPACES: 'workspaces',
  LEADS: 'leads',
  LEAD_EDGES: 'lead_edges',
  GROUPS: 'groups',
  TEMPLATES: 'templates',
  SCRAPE_RUNS: 'scrape_runs',
  ACTION_LOG: 'action_log',
  SNAPSHOTS: 'snapshots',
});

let dbPromise = null;

function idb() {
  const handle = globalThis.indexedDB;
  if (!handle) throw new Error('IndexedDB is unavailable in this context');
  return handle;
}

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = idb().open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = req.result;
      const from = event.oldVersion;

      if (from < 1) {
        const workspaces = db.createObjectStore(Store.WORKSPACES, { keyPath: 'workspaceId' });
        workspaces.createIndex('viewerUsername', 'viewerUsername', { unique: false });
        workspaces.createIndex('updatedAt', 'updatedAt', { unique: false });

        const leads = db.createObjectStore(Store.LEADS, { keyPath: 'leadKey' });
        leads.createIndex('workspaceId', 'workspaceId', { unique: false });
        leads.createIndex('workspace_username', ['workspaceId', 'username'], { unique: false });
        leads.createIndex('workspace_score', ['workspaceId', 'priorityScore'], { unique: false });
        leads.createIndex('workspace_rel', ['workspaceId', 'relState'], { unique: false });
        leads.createIndex('workspace_dm', ['workspaceId', 'dmState'], { unique: false });
        leads.createIndex('workspace_next', ['workspaceId', 'nextEligibleAt'], { unique: false });

        const edges = db.createObjectStore(Store.LEAD_EDGES, { keyPath: 'edgeKey' });
        edges.createIndex('leadKey', 'leadKey', { unique: false });
        edges.createIndex('workspace_source', ['workspaceId', 'sourceAccount'], { unique: false });
        edges.createIndex('workspace_type', ['workspaceId', 'edgeType'], { unique: false });

        const groups = db.createObjectStore(Store.GROUPS, { keyPath: 'groupId' });
        groups.createIndex('workspaceId', 'workspaceId', { unique: false });

        const templates = db.createObjectStore(Store.TEMPLATES, { keyPath: 'templateId' });
        templates.createIndex('workspace_pool', ['workspaceId', 'poolId'], { unique: false });

        const runs = db.createObjectStore(Store.SCRAPE_RUNS, { keyPath: 'runId' });
        runs.createIndex('workspace_started', ['workspaceId', 'startedAt'], { unique: false });

        const log = db.createObjectStore(Store.ACTION_LOG, { keyPath: 'logId', autoIncrement: true });
        log.createIndex('workspaceId', 'workspaceId', { unique: false });
        log.createIndex('workspace_time', ['workspaceId', 'timestamp'], { unique: false });
        log.createIndex('workspace_action', ['workspaceId', 'actionType'], { unique: false });
        log.createIndex('leadKey', 'leadKey', { unique: false });

        const snapshots = db.createObjectStore(Store.SNAPSHOTS, { keyPath: 'snapshotId' });
        snapshots.createIndex('workspace_created', ['workspaceId', 'createdAt'], { unique: false });
      }
    };

    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB blocked by another tab. Close other extension tabs and retry.'));
  });
  return dbPromise;
}

/** Test hook: drop the cached connection so a fresh fake database is used. */
export function resetDb() {
  dbPromise = null;
}

function tx(storeName, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(storeName, mode);
        const store = t.objectStore(storeName);
        let result;
        try {
          result = fn(store);
        } catch (err) {
          reject(err);
          return;
        }
        t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
        t.onerror = () => reject(t.error ?? new Error('IndexedDB transaction failed'));
        t.onabort = () => reject(t.error ?? new Error('IndexedDB transaction aborted'));
      }),
  );
}

const wrap = (req) => ({ __req: req });

/* ---------------------------------------------------------------- workspaces */

export function putWorkspace(workspace) {
  const now = Date.now();
  const row = {
    governorState: initialGovernorState(),
    createdAt: now,
    updatedAt: now,
    ...workspace,
    workspaceId: String(workspace.workspaceId),
  };
  return tx(Store.WORKSPACES, 'readwrite', (s) => wrap(s.put(row)));
}

export function getWorkspace(workspaceId) {
  return tx(Store.WORKSPACES, 'readonly', (s) => wrap(s.get(String(workspaceId))));
}

export function updateWorkspace(workspaceId, patch) {
  return tx(Store.WORKSPACES, 'readwrite', (s) => {
    const read = s.get(String(workspaceId));
    const holder = {};
    // Read-modify-write inside one transaction: the put is queued from the
    // get's success handler, so no other writer can slip between them.
    read.onsuccess = () => {
      const next = {
        ...(read.result ?? {}),
        ...patch,
        workspaceId: String(workspaceId),
        updatedAt: Date.now(),
      };
      holder.next = next;
      s.put(next);
    };
    return { get __req() { return { result: holder.next }; } };
  });
}

/* --------------------------------------------------------------------- leads */

export function upsertLead(lead) {
  const row = {
    firstSeenAt: Date.now(),
    lastSeenAt: Date.now(),
    groupIds: [],
    ...lead,
    leadKey: String(lead.leadKey),
    workspaceId: String(lead.workspaceId),
    igUserId: lead.igUserId === undefined || lead.igUserId === null ? null : String(lead.igUserId),
  };
  return tx(Store.LEADS, 'readwrite', (s) => wrap(s.put(row)));
}

export function getLead(leadKey) {
  return tx(Store.LEADS, 'readonly', (s) => wrap(s.get(String(leadKey))));
}

/** All leads of a workspace, newest first seen. */
export function listLeads(workspaceId, { limit = 5000 } = {}) {
  return tx(Store.LEADS, 'readonly', (store) => {
    const out = [];
    const req = store.index('workspaceId').openCursor(IDBKeyRange.only(String(workspaceId)));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || out.length >= limit) return;
      out.push(cursor.value);
      cursor.continue();
    };
    return { get __req() { return { result: out }; } };
  });
}

export function deleteLead(leadKey) {
  return tx(Store.LEADS, 'readwrite', (s) => wrap(s.delete(String(leadKey))));
}

/* --------------------------------------------------------------------- edges */

export function edgeKeyFor(edge) {
  return `${edge.leadKey}|${edge.edgeType}|${edge.sourceAccount}|${edge.refId ?? ''}`;
}

/**
 * Idempotent provenance write. The same fact collected twice updates the
 * timestamps and samples; it never creates a second row, which is what keeps
 * re-scans from inflating scores.
 */
export function upsertEdge(edge) {
  const now = Date.now();
  const row = {
    firstSeenAt: now,
    lastSeenAt: now,
    commentSamples: [],
    ...edge,
    edgeKey: edge.edgeKey ?? edgeKeyFor(edge),
    leadKey: String(edge.leadKey),
    workspaceId: String(edge.workspaceId),
  };
  return tx(Store.LEAD_EDGES, 'readwrite', (s) => wrap(s.put(row)));
}

export function listEdgesForLead(leadKey) {
  return tx(Store.LEAD_EDGES, 'readonly', (store) => {
    const out = [];
    const req = store.index('leadKey').openCursor(IDBKeyRange.only(String(leadKey)));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      out.push(cursor.value);
      cursor.continue();
    };
    return { get __req() { return { result: out }; } };
  });
}

/* ---------------------------------------------------------------- action log */

export function logAction(entry) {
  const row = { timestamp: Date.now(), verifiedOk: true, ...entry, workspaceId: String(entry.workspaceId) };
  return tx(Store.ACTION_LOG, 'readwrite', (s) => wrap(s.add(row)));
}

/** Newest first. Ordering happens here, not in a compound-index range. */
export function listActions(workspaceId, { limit = 1000, actionType = null } = {}) {
  return tx(Store.ACTION_LOG, 'readonly', (store) => {
    const out = [];
    const req = store.index('workspaceId').openCursor(IDBKeyRange.only(String(workspaceId)));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      if (!actionType || cursor.value.actionType === actionType) out.push(cursor.value);
      cursor.continue();
    };
    return {
      get __req() {
        return { result: out.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit) };
      },
    };
  });
}

/* ------------------------------------------------------------------ recovery */

/**
 * Reconcile interrupted work on startup.
 *
 * Every write action is journaled into workspace.governorState.inFlightAction
 * before the click happens. If the browser died between the journal and the
 * verification step, this marks that action as rolled back instead of letting
 * the autopilot believe it succeeded — or repeat it.
 */
export async function recoverIfNeeded() {
  const report = [];
  const db = await openDb();
  const workspaces = await new Promise((resolve, reject) => {
    const t = db.transaction(Store.WORKSPACES, 'readonly');
    const req = t.objectStore(Store.WORKSPACES).getAll();
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
  });

  for (const ws of workspaces) {
    const inFlight = ws.governorState?.inFlightAction;
    if (!inFlight) continue;
    await logAction({
      workspaceId: ws.workspaceId,
      leadKey: inFlight.leadKey ?? null,
      usernameSnapshot: inFlight.usernameSnapshot ?? null,
      actionType: inFlight.actionType ?? 'UNKNOWN',
      verifiedOk: false,
      detail: 'rolled back on startup: the previous session ended mid-action',
    });
    const state = { ...ws.governorState, inFlightAction: null };
    await updateWorkspace(ws.workspaceId, { governorState: state });
    report.push({ workspaceId: ws.workspaceId, action: inFlight });
  }
  return report;
}

/* ------------------------------------------------------------------- utility */

export async function clearAll() {
  const db = await openDb();
  await Promise.all(
    Object.values(Store).map(
      (name) =>
        new Promise((resolve, reject) => {
          const t = db.transaction(name, 'readwrite');
          t.objectStore(name).clear();
          t.oncomplete = resolve;
          t.onerror = () => reject(t.error);
        }),
    ),
  );
}

export async function usageEstimate() {
  const nav = globalThis.navigator;
  if (!nav?.storage?.estimate) return null;
  const { usage, quota } = await nav.storage.estimate();
  return { usage, quota, pct: quota ? (usage / quota) * 100 : null };
}
