# Seeding fictional demo data (for screenshots only)

Run this in the **dashboard's DevTools console** (`chrome-extension://<id>/app/index.html`)
to fill the library with invented people before capturing screenshots. It uses the
same storage API the app uses — no seed script is committed into the extension
folder, and nothing here touches Instagram.

**Only fictional data.** Every username, name and bio below is invented. Never seed
real usernames, real names, real bios, or the owner's account name.

## What it does

1. Imports `storage/db.js` through `chrome.runtime.getURL`.
2. Reads the workspace the dashboard is actually using (the remembered active
   workspace in `chrome.storage.local`, falling back to `default`) so the demo rows
   show up in the UI you are looking at.
3. Creates one demo bucket and ~25 leads with varied warmth, followers and states.

Signatures used, confirmed against `src/storage/db.js`:
`leadRecord(identity, patch)`, `upsertLead(lead)`, `groupRecord({ workspaceId, name })`,
`putGroup(group)`, `getWorkspace(id)`, `putWorkspace(workspace)`.
`identity` is `{ workspaceId, username }`; `leadRecord` fills every other field with
a safe default, so the patch only sets what the shot needs.

## Snippet

```js
// Paste into the dashboard DevTools console. Fictional data only.
const db = await import(chrome.runtime.getURL('storage/db.js'));

// Match the workspace the dashboard is showing.
const { ig_crm_active_workspace_v1: active } = await chrome.storage.local.get('ig_crm_active_workspace_v1');
const WS = String(active?.workspaceId || 'default');
if (!(await db.getWorkspace(WS))) await db.putWorkspace({ workspaceId: WS, viewerUsername: 'demo' });

// Ready Default bucket + two custom buckets so Your people bucket tabs shine.
const defId = `${WS}:default`;
await db.putGroup({ ...db.groupRecord({ workspaceId: WS, name: 'Default', note: 'Ready default bucket', groupId: defId }), isDefault: true });
const linenGrp = db.groupRecord({ workspaceId: WS, name: 'Linen & home textiles', note: 'Warm artisan shops' });
const cairoGrp = db.groupRecord({ workspaceId: WS, name: 'Cairo studios', note: 'Local design studios' });
await db.putGroup(linenGrp);
await db.putGroup(cairoGrp);

// 25 invented leads, varied warmth / followers / lifecycle across buckets.
const hot = ['linen.studio.demo', 'home_textiles_demo', 'cotton.and.co.demo', 'woven.home.demo'];
const warm = ['flax.thread.demo', 'ceramic.nook.demo', 'slow.made.demo', 'loom.and.leaf.demo', 'terra.craft.demo', 'natural.dye.demo'];
const lukewarm = ['bazaar.finds.demo', 'thrift.weave.demo', 'market.stall.demo', 'fiber.arts.demo', 'rustic.loft.demo'];
const cold = ['canvas.cove.demo', 'threadbare.demo', 'hearth.and.home.demo', 'knot.and.grain.demo', 'linen.loft.demo',
              'cotton.club.demo', 'woolen.way.demo', 'silk.road.demo', 'denim.den.demo', 'jute.journey.demo'];
const relStates = ['NONE', 'FOLLOW_REQUESTED', 'FOLLOWING', 'MUTUAL', 'FOLLOWED_BY_ONLY'];
const dmStates  = ['NONE', 'WAITING_FOR_ACCEPT', 'DM_SENT_REQUEST', 'DM_REPLIED'];

let i = 0;
const seed = (username, warmthTier) => {
  i += 1;
  const groupIds = i % 3 === 0 ? [defId, cairoGrp.groupId] : i % 2 === 0 ? [linenGrp.groupId] : [defId, linenGrp.groupId];
  return db.upsertLead(db.leadRecord({ workspaceId: WS, username }, {
    fullName: username.replace(/\./g, ' ').replace(/ demo$/, '') + ' (demo)',
    biography: `A fictional demo profile for screenshots. Seed #${i}.`,
    followers: 500 + ((i * 733) % 24000),
    following: 200 + ((i * 311) % 1800),
    warmthTier,
    priorityScore: warmthTier === 'hot' ? 88 - i : warmthTier === 'warm' ? 68 - i : warmthTier === 'lukewarm' ? 42 - i : 20 - (i % 15),
    relState: relStates[i % relStates.length],
    dmState: dmStates[i % dmStates.length],
    groupIds,
    sourceAccounts: ['demo.source.account'],
    edgeTypes: ['PROFILE_CAPTURE'],
    edgeCount: 1 + (i % 4),
  }));
};

for (const u of hot) await seed(u, 'hot');
for (const u of warm) await seed(u, 'warm');
for (const u of lukewarm) await seed(u, 'lukewarm');
for (const u of cold) await seed(u, 'cold');

console.log(`Seeded ${i} demo leads into workspace "${WS}". Reload the dashboard to see them.`);
```

## After seeding

Reload the dashboard. Shot 1 (empty Collect state) must be captured **before**
seeding; shots 2–6 want the seeded library. To start over, delete the demo leads by
key `${WS}:${username.toLowerCase()}` with `db.deleteLead(leadKey)`, or clear the
whole database from DevTools → Application → IndexedDB → `ig-outreach-crm` →
Delete database.
