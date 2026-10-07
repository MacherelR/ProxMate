import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    template: { findMany: vi.fn() },
    systemConfig: { findUnique: vi.fn() },
  },
}));

import { prisma } from '../src/lib/prisma.js';
import {
  isScoped,
  resolvePlacement,
  assertMayDuplicate,
  assertNotScoped,
  getScopeOptions,
  resetScopeCache,
  treeMayHold,
  poolPath,
  storagePath,
  networkPath,
  templatePath,
  ScopeError,
} from '../src/services/pve-scope.service.js';
import { fakeClient, asClient } from './helpers.js';

/**
 * Environment placement: a confined (non-admin) user must pick a pool / network /
 * storage that ProxMate's OWN Proxmox account is allowed to use. These tests drive the
 * service against a fake Proxmox whose `GET /access/permissions?path=…` answers from a
 * grant table, so every test states exactly what the account holds and asserts what
 * ProxMate does.
 */

const findConfig = vi.mocked(prisma.systemConfig.findUnique);
const findTemplates = vi.mocked(prisma.template.findMany);

const ok = (data: unknown) => Promise.resolve({ data: { data } });

/** Drive getConfig from a plain key→value map. */
function configuredAs(values: Record<string, string>) {
  findConfig.mockImplementation(((args: { where: { key: string } }) => {
    const v = values[args.where.key];
    return Promise.resolve(v === undefined ? null : { key: args.where.key, value: v, sensitive: false });
  }) as never);
}

const actor = { id: 'u1', role: 'user' };

interface FakeOpts {
  vnets?: { vnet: string; zone: string }[];
  pools?: string[];
  storages?: { storage: string; type: string; content: string }[];
  /** Simulate the permissions lookup failing outright. */
  broken?: boolean;
  /** Simulate a Proxmox that ignores `path` and returns the whole tree. */
  ignoresPath?: boolean;
}

/** A Proxmox whose account holds `grants[path] = [privileges]` and nothing else. */
function fakePve(grants: Record<string, string[]>, opts: FakeOpts = {}) {
  const c = fakeClient();
  const asPrivs = (p: string[]) => Object.fromEntries(p.map((x) => [x, 1]));
  const tree = Object.fromEntries(Object.entries(grants).map(([k, v]) => [k, asPrivs(v)]));
  c.get.mockImplementation((url: string) => {
    if (url.startsWith('/access/permissions')) {
      if (opts.broken) return Promise.reject(new Error('socket hang up'));
      const path = new URLSearchParams(url.split('?')[1] ?? '').get('path');
      if (!path || opts.ignoresPath) return ok(tree);
      return ok(grants[path] ? { [path]: asPrivs(grants[path]!) } : {});
    }
    if (url === '/cluster/sdn/vnets') return ok(opts.vnets ?? [{ vnet: 'dnet01', zone: 'delfin02' }]);
    if (url === '/pools') return ok((opts.pools ?? []).map((poolid) => ({ poolid })));
    if (url === '/storage') return ok(opts.storages ?? []);
    return ok(null);
  });
  return c;
}

const permissionCalls = (c: ReturnType<typeof fakeClient>) =>
  c.get.mock.calls.filter((x) => String(x[0]).startsWith('/access/permissions'));
const askedPaths = (c: ReturnType<typeof fakeClient>) =>
  permissionCalls(c).map((x) => new URLSearchParams(String(x[0]).split('?')[1] ?? '').get('path'));

/** Everything a template deploy into delfino-02 needs. */
const FULL_GRANTS = {
  '/pool/delfino/delfino-02': ['VM.Allocate'],
  '/storage/primary_01': ['Datastore.AllocateSpace'],
  '/sdn/zones/delfin02/dnet01': ['SDN.Use'],
  '/vms/9001': ['VM.Clone'],
};
const REQ = { pool: 'delfino/delfino-02', bridge: 'dnet01', storage: 'primary_01' };
const TEMPLATE = { kind: 'template', vmid: 9001 } as const;

beforeEach(() => {
  vi.clearAllMocks();
  resetScopeCache();
  configuredAs({ pve_user_placement: 'true' });
});

// ─── Who is confined ──────────────────────────────────────────

describe('isScoped', () => {
  it('confines a non-admin while the switch is on', async () => {
    expect(await isScoped(actor)).toBe(true);
  });

  it('never confines an admin — and does not even read the switch', async () => {
    findConfig.mockClear();
    expect(await isScoped({ role: 'admin' })).toBe(false);
    expect(findConfig).not.toHaveBeenCalled();
  });

  it('confines nobody while the switch is off or unset', async () => {
    configuredAs({ pve_user_placement: 'false' });
    expect(await isScoped(actor)).toBe(false);
    configuredAs({});
    expect(await isScoped(actor)).toBe(false);
  });
});

// ─── Path building ────────────────────────────────────────────

describe('path builders', () => {
  it('build the ACL paths Proxmox uses', () => {
    expect(poolPath('delfino')).toBe('/pool/delfino');
    expect(poolPath('delfino/delfino-02')).toBe('/pool/delfino/delfino-02');
    expect(storagePath('primary_01')).toBe('/storage/primary_01');
    expect(networkPath('delfin02', 'dnet01')).toBe('/sdn/zones/delfin02/dnet01');
    expect(templatePath(9001)).toBe('/vms/9001');
  });

  it.each(['..', '../x', 'a/../b', 'a//b', '/a', 'a/', '', 'a b', 'a/b/c/d/e', 'x?y=1', 'a\nb'])(
    'refuses the pool %j',
    (pool) => {
      expect(() => poolPath(pool)).toThrow(ScopeError);
    },
  );

  it.each(['a/b', '../etc', '', '9x', 'a b', 'a,b', 'a=b'])('refuses the storage %j', (s) => {
    expect(() => storagePath(s)).toThrow(ScopeError);
  });

  it('refuses a VNet or zone that smuggles a path segment', () => {
    expect(() => networkPath('delfin02', '../../')).toThrow(ScopeError);
    expect(() => networkPath('a/b', 'dnet01')).toThrow(ScopeError);
  });

  it.each([0, -1, 1.5, NaN])('refuses the template vmid %j', (id) => {
    expect(() => templatePath(id)).toThrow(ScopeError);
  });
});

// ─── resolvePlacement ─────────────────────────────────────────

describe('resolvePlacement — unconfined actors', () => {
  it('is a pass-through (undefined) for a classic request', async () => {
    configuredAs({});
    const c = fakePve({});
    expect(await resolvePlacement(actor, {}, TEMPLATE, asClient(c))).toBeUndefined();
    expect(c.get).not.toHaveBeenCalled();
  });

  it('refuses placement fields while the feature is off', async () => {
    configuredAs({});
    await expect(resolvePlacement(actor, { pool: 'x' }, TEMPLATE, asClient(fakePve({})))).rejects.toMatchObject({
      status: 400,
    });
  });

  it('lets an admin through classically', async () => {
    const c = fakePve({});
    expect(await resolvePlacement({ id: 'a1', role: 'admin' }, {}, TEMPLATE, asClient(c))).toBeUndefined();
    expect(c.get).not.toHaveBeenCalled();
  });
});

describe('resolvePlacement — confined actors', () => {
  it('returns the vetted placement when the account holds everything', async () => {
    const c = fakePve(FULL_GRANTS);
    expect(await resolvePlacement(actor, REQ, TEMPLATE, asClient(c))).toEqual(REQ);
  });

  it('asks Proxmox about its OWN account: no userid, one exact path per need', async () => {
    const c = fakePve(FULL_GRANTS);
    await resolvePlacement(actor, REQ, TEMPLATE, asClient(c));
    for (const call of permissionCalls(c)) {
      expect(new URLSearchParams(String(call[0]).split('?')[1]).has('userid')).toBe(false);
    }
    expect(askedPaths(c).sort()).toEqual(
      ['/pool/delfino/delfino-02', '/sdn/zones/delfin02/dnet01', '/storage/primary_01', '/vms/9001'].sort(),
    );
  });

  it.each([
    ['pool', { pool: undefined }],
    ['network', { bridge: undefined }],
    ['storage', { storage: undefined }],
  ])('refuses a request that leaves out the %s — no default fallback', async (_n, missing) => {
    const c = fakePve(FULL_GRANTS);
    await expect(resolvePlacement(actor, { ...REQ, ...missing }, TEMPLATE, asClient(c))).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/pool, a network and a storage/),
    });
    expect(c.get).not.toHaveBeenCalled();
  });

  it('refuses a pool outside the account\'s reach, naming the privilege and path', async () => {
    // The account is scoped to delfino-02; asking for another instance's pool is refused.
    const c = fakePve(FULL_GRANTS);
    await expect(
      resolvePlacement(actor, { ...REQ, pool: 'delfino/delfino-03' }, TEMPLATE, asClient(c)),
    ).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('VM.Allocate on /pool/delfino/delfino-03'),
    });
  });

  it('refuses a network the account cannot SDN.Use', async () => {
    const c = fakePve({ ...FULL_GRANTS, '/sdn/zones/delfin02/dnet01': [] });
    await expect(resolvePlacement(actor, REQ, TEMPLATE, asClient(c))).rejects.toThrow(/SDN\.Use on \/sdn\/zones\/delfin02\/dnet01/);
  });

  it('refuses a VNet of another zone even when this zone is granted', async () => {
    const c = fakePve(FULL_GRANTS, { vnets: [{ vnet: 'other', zone: 'delfin03' }] });
    await expect(resolvePlacement(actor, { ...REQ, bridge: 'other' }, TEMPLATE, asClient(c))).rejects.toThrow(
      /SDN\.Use on \/sdn\/zones\/delfin03\/other/,
    );
  });

  it('refuses a storage without Datastore.AllocateSpace', async () => {
    const c = fakePve({ ...FULL_GRANTS, '/storage/primary_01': ['Datastore.Audit'] });
    await expect(resolvePlacement(actor, REQ, TEMPLATE, asClient(c))).rejects.toThrow(/Datastore\.AllocateSpace on \/storage\/primary_01/);
  });

  it('refuses a template the account cannot clone', async () => {
    const c = fakePve({ ...FULL_GRANTS, '/vms/9001': ['VM.Audit'] });
    await expect(resolvePlacement(actor, REQ, TEMPLATE, asClient(c))).rejects.toThrow(/VM\.Clone on \/vms\/9001/);
  });

  it('reports EVERYTHING that is missing in one refusal', async () => {
    const c = fakePve({});
    const err = (await resolvePlacement(actor, REQ, TEMPLATE, asClient(c)).catch((e) => e)) as ScopeError;
    expect(err).toBeInstanceOf(ScopeError);
    for (const path of ['/pool/delfino/delfino-02', '/storage/primary_01', '/sdn/zones/delfin02/dnet01', '/vms/9001']) {
      expect(err.message).toContain(path);
    }
  });

  it('treats a bridge that is not an SDN VNet as a classic bridge under localnetwork', async () => {
    const c = fakePve({ ...FULL_GRANTS, '/sdn/zones/localnetwork/vmbr0': ['SDN.Use'] }, { vnets: [] });
    expect(await resolvePlacement(actor, { ...REQ, bridge: 'vmbr0' }, TEMPLATE, asClient(c))).toMatchObject({
      bridge: 'vmbr0',
    });
  });

  it('requires Datastore.Audit on the ISO storage for an ISO install', async () => {
    const iso = { kind: 'iso', isoStorage: 'isos' } as const;
    await expect(resolvePlacement(actor, REQ, iso, asClient(fakePve(FULL_GRANTS)))).rejects.toThrow(
      /Datastore\.Audit on \/storage\/isos/,
    );

    resetScopeCache();
    const allowed = fakePve({ ...FULL_GRANTS, '/storage/isos': ['Datastore.Audit'] });
    expect(await resolvePlacement(actor, REQ, iso, asClient(allowed))).toEqual(REQ);
  });

  it('requires Datastore.Audit on the storage an LXC template lives on', async () => {
    const lxc = { kind: 'lxc', templateVolid: 'local:vztmpl/debian-12.tar.zst' } as const;
    await expect(resolvePlacement(actor, REQ, lxc, asClient(fakePve(FULL_GRANTS)))).rejects.toThrow(
      /Datastore\.Audit on \/storage\/local/,
    );
  });

  it('fails CLOSED when the lookup errors — never "no answer means allowed"', async () => {
    const c = fakePve(FULL_GRANTS, { broken: true });
    await expect(resolvePlacement(actor, REQ, TEMPLATE, asClient(c))).rejects.toMatchObject({
      status: 502,
      message: expect.stringMatching(/Could not check/),
    });
  });

  it('never trusts a Proxmox that ignores `path` and returns the whole tree', async () => {
    // The account holds everything on /pool/other only. A tree answer must not be
    // merged into "holds it on the requested pool".
    const c = fakePve(
      { '/pool/other': ['VM.Allocate', 'Datastore.AllocateSpace', 'SDN.Use', 'VM.Clone'] },
      { ignoresPath: true },
    );
    await expect(resolvePlacement(actor, REQ, TEMPLATE, asClient(c))).rejects.toMatchObject({ status: 403 });
  });

  it('does not look anything up for a malformed name (no path injection)', async () => {
    const c = fakePve(FULL_GRANTS);
    for (const bad of [
      { ...REQ, pool: '../..' },
      { ...REQ, pool: 'delfino/../../x' },
      { ...REQ, storage: 'a/b' },
      { ...REQ, bridge: 'x/../y' },
    ]) {
      await expect(resolvePlacement(actor, bad, TEMPLATE, asClient(c))).rejects.toMatchObject({ status: 400 });
    }
    expect(permissionCalls(c)).toHaveLength(0);
  });

  it('caches an answer briefly, and forgets it on reset', async () => {
    const c = fakePve(FULL_GRANTS);
    await resolvePlacement(actor, REQ, TEMPLATE, asClient(c));
    await resolvePlacement(actor, REQ, TEMPLATE, asClient(c));
    expect(permissionCalls(c)).toHaveLength(4); // second call served from cache

    resetScopeCache(); // e.g. the admin swapped the Proxmox token
    await resolvePlacement(actor, REQ, TEMPLATE, asClient(c));
    expect(permissionCalls(c)).toHaveLength(8);
  });
});

// ─── Duplicate / not-scoped guards ────────────────────────────

describe('assertMayDuplicate', () => {
  const vm = { pool: 'delfino/delfino-02', bridge: 'dnet01' };

  it('is false (proceed classically) for an unconfined actor', async () => {
    configuredAs({});
    expect(await assertMayDuplicate(actor, { pool: null, bridge: null }, asClient(fakePve({})))).toBe(false);
  });

  it('refuses a confined actor copying a guest that was never placed in a pool', async () => {
    await expect(assertMayDuplicate(actor, { pool: null, bridge: null }, asClient(fakePve({})))).rejects.toThrow(
      /not deployed into a pool/,
    );
  });

  it('allows the copy while the account still holds the source pool and network', async () => {
    expect(await assertMayDuplicate(actor, vm, asClient(fakePve(FULL_GRANTS)))).toBe(true);
  });

  it('refuses once the account has lost the source pool', async () => {
    const { '/pool/delfino/delfino-02': _drop, ...rest } = FULL_GRANTS;
    void _drop;
    await expect(assertMayDuplicate(actor, vm, asClient(fakePve(rest)))).rejects.toThrow(/VM\.Allocate/);
  });
});

describe('assertNotScoped', () => {
  it('passes for an unconfined actor', async () => {
    configuredAs({});
    await expect(assertNotScoped(actor, 'Rebuilding a machine')).resolves.toBeUndefined();
  });

  it('refuses a confined actor, naming the feature', async () => {
    await expect(assertNotScoped(actor, 'Rebuilding a machine')).rejects.toThrow(/Rebuilding a machine isn't available/);
  });
});

// ─── What the wizard may offer ────────────────────────────────

describe('treeMayHold', () => {
  const tree = { '/': { 'Sys.Audit': 1 }, '/pool/delfino': { 'VM.Allocate': 1 }, '/sdn/zones/delfin02': { 'SDN.Use': 1 } };

  it('accepts the path itself and its descendants', () => {
    expect(treeMayHold(tree, '/pool/delfino', 'VM.Allocate')).toBe(true);
    expect(treeMayHold(tree, '/pool/delfino/delfino-02', 'VM.Allocate')).toBe(true);
    expect(treeMayHold(tree, '/sdn/zones/delfin02/dnet01', 'SDN.Use')).toBe(true);
  });

  it('rejects siblings, other privileges and prefix look-alikes', () => {
    expect(treeMayHold(tree, '/pool/ragno', 'VM.Allocate')).toBe(false);
    expect(treeMayHold(tree, '/pool/delfino-evil/x', 'VM.Allocate')).toBe(false);
    expect(treeMayHold(tree, '/pool/delfino', 'VM.Clone')).toBe(false);
  });

  it('honours a grant on the root', () => {
    expect(treeMayHold({ '/': { 'SDN.Use': 1 } }, '/sdn/zones/z/v', 'SDN.Use')).toBe(true);
  });
});

describe('getScopeOptions', () => {
  it('is null for an unconfined actor', async () => {
    configuredAs({});
    expect(await getScopeOptions(actor, asClient(fakePve({})))).toBeNull();
  });

  it('lists only the pools, networks, storages and templates the account holds', async () => {
    configuredAs({ pve_user_placement: 'true', iso_storage: 'isos' });
    findTemplates.mockResolvedValue([
      { id: 't-ok', proxmoxVmId: 9001 },
      { id: 't-no', proxmoxVmId: 9002 },
    ] as never);
    const c = fakePve(
      {
        // propagate from the parent pool covers the instance pool
        '/pool/delfino': ['VM.Allocate'],
        '/pool/delfino/delfino-02': ['VM.Allocate'],
        '/storage/primary_01': ['Datastore.AllocateSpace'],
        '/sdn/zones/delfin02': ['SDN.Use'],
        '/sdn/zones/delfin02/dnet01': ['SDN.Use'],
        '/sdn/zones/delfin02/dnet02': ['SDN.Use'],
        '/vms/9001': ['VM.Clone'],
        '/storage/isos': ['Datastore.Audit'],
      },
      {
        pools: ['delfino', 'delfino/delfino-02', 'ragno', 'ragno/ragno-01'],
        vnets: [
          { vnet: 'dnet01', zone: 'delfin02' },
          { vnet: 'dnet02', zone: 'delfin02' },
          { vnet: 'rnet01', zone: 'ragno01' },
        ],
        storages: [
          { storage: 'primary_01', type: 'rbd', content: 'images,rootdir' },
          { storage: 'secondary_01', type: 'nfs', content: 'images' },
          { storage: 'isos', type: 'dir', content: 'iso' },
        ],
      },
    );

    const o = await getScopeOptions(actor, asClient(c));

    expect(o!.pools.map((p) => p.id)).toEqual(['delfino', 'delfino/delfino-02']);
    expect(o!.networks).toEqual([
      { id: 'dnet01', zone: 'delfin02' },
      { id: 'dnet02', zone: 'delfin02' },
    ]);
    expect(o!.storages.map((s) => s.name)).toEqual(['primary_01']);
    expect(o!.templateIds).toEqual(['t-ok']);
    expect(o!.isoAllowed).toBe(true);
    expect(o!.lxcAllowed).toBe(true);
    expect(o).not.toHaveProperty('pveUserId');
  });

  it('a token scoped to one instance offers exactly that instance', async () => {
    findTemplates.mockResolvedValue([] as never);
    const c = fakePve(
      { '/pool/delfino/delfino-02': ['VM.Allocate'], '/sdn/zones/delfin02': ['SDN.Use'], '/sdn/zones/delfin02/dnet01': ['SDN.Use'] },
      {
        pools: ['delfino', 'delfino/delfino-01', 'delfino/delfino-02'],
        vnets: [
          { vnet: 'dnet01', zone: 'delfin02' },
          { vnet: 'dnet01b', zone: 'delfin01' },
        ],
      },
    );
    const o = await getScopeOptions(actor, asClient(c));
    expect(o!.pools.map((p) => p.id)).toEqual(['delfino/delfino-02']);
    expect(o!.networks.map((n) => n.id)).toEqual(['dnet01']);
  });

  it('does not confirm pools the tree cannot possibly grant (no per-pool call for them)', async () => {
    findTemplates.mockResolvedValue([] as never);
    const c = fakePve({ '/pool/delfino': ['VM.Allocate'] }, { pools: ['delfino', 'ragno', 'bastione', 'rigi'] });
    await getScopeOptions(actor, asClient(c));
    expect(askedPaths(c).filter((p): p is string => !!p && p.startsWith('/pool/'))).toEqual(['/pool/delfino']);
  });

  it('skips a cluster object whose name our strict path check rejects, instead of failing the list', async () => {
    findTemplates.mockResolvedValue([] as never);
    const c = fakePve({ '/pool/delfino': ['VM.Allocate'] }, { pools: ['delfino', '_weird pool'] });
    const o = await getScopeOptions(actor, asClient(c));
    expect(o!.pools.map((p) => p.id)).toEqual(['delfino']);
  });

  it('surfaces a clear error when the permission lookup fails', async () => {
    const c = fakePve(FULL_GRANTS, { broken: true });
    await expect(getScopeOptions(actor, asClient(c))).rejects.toBeInstanceOf(ScopeError);
  });
});
