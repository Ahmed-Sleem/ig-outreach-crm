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
  OUTREACH_SESSIONS: 'outreach_sessions',
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
        templates.createIndex('workspaceId', 'workspaceId', { unique: false });
        templates.createIndex('workspace_pool', ['workspaceId', 'poolId'], { unique: false });

        const runs = db.createObjectStore(Store.SCRAPE_RUNS, { keyPath: 'runId' });
        runs.createIndex('workspaceId', 'workspaceId', { unique: false });
        runs.createIndex('workspace_started', ['workspaceId', 'startedAt'], { unique: false });

        const sessions = db.createObjectStore(Store.OUTREACH_SESSIONS, { keyPath: 'sessionId' });
        sessions.createIndex('workspaceId', 'workspaceId', { unique: false });
        sessions.createIndex('workspace_started', ['workspaceId', 'startedAt'], { unique: false });
        sessions.createIndex('workspace_mode', ['workspaceId', 'mode'], { unique: false });

        const log = db.createObjectStore(Store.ACTION_LOG, { keyPath: 'logId', autoIncrement: true });
        log.createIndex('workspaceId', 'workspaceId', { unique: false });
        log.createIndex('workspace_time', ['workspaceId', 'timestamp'], { unique: false });
        log.createIndex('workspace_action', ['workspaceId', 'actionType'], { unique: false });
        log.createIndex('leadKey', 'leadKey', { unique: false });

        const snapshots = db.createObjectStore(Store.SNAPSHOTS, { keyPath: 'snapshotId' });
        snapshots.createIndex('workspaceId', 'workspaceId', { unique: false });
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

/**
 * The one place a lead record's shape is written down.
 *
 * Every writer (the collector, the importer, the funnel) builds its row through
 * this, so a field cannot exist in one code path and be undefined in another —
 * which is how a table ends up sorting `undefined` against `0` and a filter ends
 * up hiding rows.
 *
 * @param {{workspaceId: string, username: string}} identity
 * @param {object} patch
 */
export function leadRecord(identity, patch = {}) {
  const username = String(identity?.username ?? '');
  const workspaceId = String(identity?.workspaceId ?? '');
  if (!username) throw new Error('a lead needs a username');
  if (!workspaceId) throw new Error('a lead needs a workspace');
  const now = Date.now();
  return {
    leadKey: `${workspaceId}:${username.toLowerCase()}`,
    workspaceId,
    username,
    igUserId: null,
    fullName: '',
    biography: '',
    profilePicUrl: '',
    isPrivate: false,
    isVerified: false,
    isBusiness: false,
    followers: null,
    following: null,

    /** Two-axis lifecycle. Values of RelState / DmState in core/lifecycle.js. */
    relState: 'NONE',
    dmState: 'NONE',

    /** Ranking. core/scoring.js writes these; the table sorts on them. */
    priorityScore: 0,
    warmthTier: 'cold',
    scoreParts: {},

    /** Provenance: which source accounts and edge types produced this lead. */
    sourceAccounts: [],
    edgeTypes: [],
    edgeCount: 0,
    intentLabel: null,

    /** Funnel bookkeeping. */
    groupIds: [],
    followedAt: null,
    /**
     * Set only when THIS extension performed the follow. The cleaner refuses to
     * unfollow anyone without it, so friends the owner followed by hand are
     * never touched by a campaign they never asked for.
     */
    followedViaExtension: false,
    requestedAt: null,
    acceptedAt: null,
    messagedAt: null,
    repliedAt: null,
    unfollowedAt: null,
    nextEligibleAt: null,
    attempts: 0,
    lastError: null,

    /** Protections honoured by lifecycle.js and the cleaner. */
    isWhitelisted: false,
    isProtectedBaseline: false,
    doNotContactReason: null,

    firstSeenAt: now,
    lastSeenAt: now,
    ...patch,
    leadKey: String(patch.leadKey ?? `${workspaceId}:${username.toLowerCase()}`),
    workspaceId,
    username,
    igUserId: patch.igUserId === undefined || patch.igUserId === null ? null : String(patch.igUserId),
  };
}

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

/** Delete multiple leads (and their orphaned provenance edges) in one batch. */
export async function deleteLeads(leadKeys = []) {
  const keys = [...new Set((leadKeys ?? []).map((k) => String(k)).filter(Boolean))];
  if (!keys.length) return { deleted: 0 };
  await tx(Store.LEADS, 'readwrite', (leadsStore) => {
    for (const key of keys) leadsStore.delete(key);
  });
  await tx(Store.LEAD_EDGES, 'readwrite', (edgesStore) => {
    const idx = edgesStore.index('leadKey');
    for (const key of keys) {
      const req = idx.openCursor(IDBKeyRange.only(key));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        edgesStore.delete(cursor.primaryKey ?? cursor.value?.edgeKey);
        cursor.continue();
      };
    }
  });
  return { deleted: keys.length };
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

/* ------------------------------------------------------- buckets (groups) */

/**
 * A bucket is a named subset of leads: "linen suppliers", "Ramadan campaign".
 * Leads carry `groupIds`, so one person can sit in several buckets and deleting
 * a bucket never deletes a person.
 */
export function groupRecord({ workspaceId, name, note = '', groupId = null }) {
  if (!workspaceId) throw new Error('a bucket needs a workspace');
  const label = String(name ?? '').trim();
  if (!label) throw new Error('a bucket needs a name');
  const now = Date.now();
  return {
    groupId: String(groupId ?? `grp_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`),
    workspaceId: String(workspaceId),
    name: label,
    note: String(note ?? ''),
    createdAt: now,
    updatedAt: now,
  };
}

export function putGroup(group) {
  const row = { createdAt: Date.now(), updatedAt: Date.now(), ...group, groupId: String(group.groupId), workspaceId: String(group.workspaceId) };
  return tx(Store.GROUPS, 'readwrite', (s) => wrap(s.put(row)));
}

export function listGroups(workspaceId) {
  return tx(Store.GROUPS, 'readonly', (store) => {
    const out = [];
    const req = store.index('workspaceId').openCursor(IDBKeyRange.only(String(workspaceId)));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      out.push(cursor.value);
      cursor.continue();
    };
    return { get __req() { return { result: out.sort((a, b) => a.name.localeCompare(b.name)) }; } };
  });
}

export function getGroup(groupId) {
  return tx(Store.GROUPS, 'readonly', (s) => wrap(s.get(String(groupId))));
}

/**
 * Delete a bucket and un-tag its leads.
 *
 * Two stores in two transactions on purpose: a single readwrite transaction over
 * both would have to hold every lead in memory anyway, and a failure halfway
 * leaves an orphan tag on a lead, which is harmless, rather than a deleted
 * person, which is not.
 */
export async function deleteGroup(groupId) {
  const id = String(groupId);
  const group = await getGroup(id);
  if (!group) return { deleted: false, untagged: 0 };
  const leads = await listLeads(group.workspaceId, { limit: 100000 });
  let untagged = 0;
  for (const lead of leads) {
    if (!(lead.groupIds ?? []).includes(id)) continue;
    await upsertLead({ ...lead, groupIds: lead.groupIds.filter((entry) => entry !== id) });
    untagged += 1;
  }
  await tx(Store.GROUPS, 'readwrite', (s) => wrap(s.delete(id)));
  return { deleted: true, untagged };
}

/** Add or remove one bucket tag on one lead, keeping firstSeenAt intact. */
export async function setLeadGroup(leadKey, groupId, { on = true } = {}) {
  const lead = await getLead(leadKey);
  if (!lead) return null;
  const id = String(groupId);
  const current = lead.groupIds ?? [];
  const next = on ? (current.includes(id) ? current : [...current, id]) : current.filter((entry) => entry !== id);
  await upsertLead({ ...lead, groupIds: next });
  return { ...lead, groupIds: next };
}

/* ------------------------------------------------- message template pools */

/**
 * A template is one message the autopilot may send, with spintax and
 * {{variables}} left intact: rendering happens per lead at send time, so two
 * people never receive a byte-identical message from the same template.
 */
export function templateRecord({ workspaceId, body, label = '', poolId = 'default', language = 'en', enabled = true, templateId = null }) {
  if (!workspaceId) throw new Error('a template needs a workspace');
  if (!String(body ?? '').trim()) throw new Error('a template needs a message body');
  const now = Date.now();
  return {
    templateId: String(templateId ?? `tpl_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`),
    workspaceId: String(workspaceId),
    poolId: String(poolId ?? 'default'),
    label: String(label ?? ''),
    body: String(body),
    language: String(language ?? 'en'),
    enabled: Boolean(enabled),
    createdAt: now,
    updatedAt: now,
    sentCount: 0,
  };
}

export function putTemplate(template) {
  const row = { createdAt: Date.now(), updatedAt: Date.now(), sentCount: 0, ...template, templateId: String(template.templateId), workspaceId: String(template.workspaceId) };
  return tx(Store.TEMPLATES, 'readwrite', (s) => wrap(s.put(row)));
}

export function listTemplates(workspaceId, { poolId = null } = {}) {
  return tx(Store.TEMPLATES, 'readonly', (store) => {
    const out = [];
    const req = store.index('workspaceId').openCursor(IDBKeyRange.only(String(workspaceId)));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      if (!poolId || cursor.value.poolId === poolId) out.push(cursor.value);
      cursor.continue();
    };
    return { get __req() { return { result: out.sort((a, b) => a.createdAt - b.createdAt) }; } };
  });
}

export function deleteTemplate(templateId) {
  return tx(Store.TEMPLATES, 'readwrite', (s) => wrap(s.delete(String(templateId))));
}

/** Counting enabled templates is what decides whether a message run may start. */
export async function countEnabledTemplates(workspaceId, { poolId = null } = {}) {
  const rows = await listTemplates(workspaceId, { poolId });
  return rows.filter((row) => row.enabled !== false).length;
}

/* ------------------------------------------------------ collection sessions */

/**
 * One Tab 1 collection: what was asked for, what came back, and why it stopped.
 * Kept permanently — a run that returned 300 leads yesterday is the evidence for
 * "these people came from @comp_a", and re-collecting costs account risk.
 */
export function runRecord({ workspaceId, kind = 'collect', source = null, sourceAccount = null, tabId = null, runId = null }) {
  const now = Date.now();
  return {
    runId: String(runId ?? `run_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`),
    workspaceId: String(workspaceId),
    kind,
    source,
    sourceAccount,
    tabId: tabId === null || tabId === undefined ? null : Number(tabId),
    startedAt: now,
    finishedAt: null,
    status: 'running',
    counts: { leads: 0, edges: 0, pages: 0 },
    reason: null,
    severity: null,
  };
}

export function putScrapeRun(run) {
  const row = { startedAt: Date.now(), status: 'running', ...run, runId: String(run.runId), workspaceId: String(run.workspaceId) };
  return tx(Store.SCRAPE_RUNS, 'readwrite', (s) => wrap(s.put(row)));
}

export async function finishScrapeRun(runId, patch = {}) {
  const row = await tx(Store.SCRAPE_RUNS, 'readonly', (s) => wrap(s.get(String(runId))));
  if (!row) return null;
  const next = { ...row, ...patch, finishedAt: patch.finishedAt ?? Date.now(), status: patch.status ?? 'done' };
  await tx(Store.SCRAPE_RUNS, 'readwrite', (s) => wrap(s.put(next)));
  return next;
}

export function listScrapeRuns(workspaceId, { limit = 200, kind = null } = {}) {
  return tx(Store.SCRAPE_RUNS, 'readonly', (store) => {
    const out = [];
    const req = store.index('workspaceId').openCursor(IDBKeyRange.only(String(workspaceId)));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      if (!kind || cursor.value.kind === kind) out.push(cursor.value);
      cursor.continue();
    };
    return { get __req() { return { result: out.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit) }; } };
  });
}

/* ------------------------------------------------------- outreach sessions */

/**
 * One autopilot session: mode, when it started, when it stopped, and how many
 * actions landed. This is the record the owner reads the next morning to know
 * what the extension did while the tab was open, and it survives a browser
 * restart because it lives in IndexedDB, not in a page.
 */
export function sessionRecord({ workspaceId, mode, groupId = null, tabId = null, policy = {}, sessionId = null }) {
  const now = Date.now();
  return {
    sessionId: String(sessionId ?? `ses_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`),
    workspaceId: String(workspaceId),
    mode,
    groupId: groupId === null || groupId === undefined ? null : String(groupId),
    tabId: tabId === null || tabId === undefined ? null : Number(tabId),
    policy,
    startedAt: now,
    endedAt: null,
    status: 'running',
    planned: 0,
    counts: { attempted: 0, done: 0, refused: 0, skipped: 0, failed: 0 },
    lastActionAt: null,
    reason: null,
    severity: null,
  };
}

export function putOutreachSession(session) {
  const row = { startedAt: Date.now(), status: 'running', ...session, sessionId: String(session.sessionId), workspaceId: String(session.workspaceId) };
  return tx(Store.OUTREACH_SESSIONS, 'readwrite', (s) => wrap(s.put(row)));
}

export async function updateOutreachSession(sessionId, patch = {}) {
  const row = await tx(Store.OUTREACH_SESSIONS, 'readonly', (s) => wrap(s.get(String(sessionId))));
  if (!row) return null;
  const counts = patch.counts ? { ...row.counts, ...patch.counts } : row.counts;
  const next = { ...row, ...patch, counts, sessionId: row.sessionId, workspaceId: row.workspaceId };
  await tx(Store.OUTREACH_SESSIONS, 'readwrite', (s) => wrap(s.put(next)));
  return next;
}

export async function endOutreachSession(sessionId, { status = 'stopped', reason = null, severity = null } = {}) {
  return updateOutreachSession(sessionId, { status, reason, severity, endedAt: Date.now() });
}

export function listOutreachSessions(workspaceId, { limit = 200, mode = null } = {}) {
  return tx(Store.OUTREACH_SESSIONS, 'readonly', (store) => {
    const out = [];
    const req = store.index('workspaceId').openCursor(IDBKeyRange.only(String(workspaceId)));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      if (!mode || cursor.value.mode === mode) out.push(cursor.value);
      cursor.continue();
    };
    return { get __req() { return { result: out.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit) }; } };
  });
}

/** A session left running by a crash is not running: mark it, do not hide it. */
export async function reconcileSessions(workspaceId) {
  const rows = await listOutreachSessions(workspaceId, { limit: 500 });
  const stale = rows.filter((row) => row.status === 'running');
  for (const row of stale) {
    await endOutreachSession(row.sessionId, { status: 'interrupted', reason: 'the dashboard was closed while this session was running' });
  }
  return stale.length;
}

/* ---------------------------------------------------------------- snapshots */

export function putSnapshot(snapshot) {
  const row = { createdAt: Date.now(), ...snapshot, workspaceId: String(snapshot.workspaceId), snapshotId: String(snapshot.snapshotId) };
  return tx(Store.SNAPSHOTS, 'readwrite', (s) => wrap(s.put(row)));
}

export function listSnapshots(workspaceId, { limit = 100 } = {}) {
  return tx(Store.SNAPSHOTS, 'readonly', (store) => {
    const out = [];
    const req = store.index('workspaceId').openCursor(IDBKeyRange.only(String(workspaceId)));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      // The payload can be megabytes; the list only needs the label.
      const { payload, ...meta } = cursor.value;
      out.push({ ...meta, bytes: payload ? JSON.stringify(payload).length : 0 });
      cursor.continue();
    };
    return { get __req() { return { result: out.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit) }; } };
  });
}

export function getSnapshot(snapshotId) {
  return tx(Store.SNAPSHOTS, 'readonly', (s) => wrap(s.get(String(snapshotId))));
}

export function deleteSnapshot(snapshotId) {
  return tx(Store.SNAPSHOTS, 'readwrite', (s) => wrap(s.delete(String(snapshotId))));
}
