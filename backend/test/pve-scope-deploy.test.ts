import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    virtualMachine: { findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn() },
    systemConfig: { findUnique: vi.fn() },
  },
}));
vi.mock('../src/services/proxmox.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/proxmox.service.js')>();
  return { ...actual, getClient: vi.fn(), getIsoNodes: vi.fn(), pickBestNode: vi.fn(), getTemplateNodes: vi.fn() };
});

import { prisma } from '../src/lib/prisma.js';
import * as pve from '../src/services/proxmox.service.js';
import { createVm, createContainer, deployFromTemplate, duplicateVm, rebuildVm } from '../src/services/vm.service.js';
import { fakeClient, asClient, bodyOf } from './helpers.js';

/**
 * What a Proxmox-scoped placement changes in the guest that actually gets built.
 *
 * `resolvePlacement` (pve-scope.test.ts) decides whether a placement is ALLOWED; these
 * tests pin that, once allowed, the guest really lands there — in the requested pool,
 * on the requested storage and VNet — and that none of the server-default behaviours
 * that would move it elsewhere (default bridge, default storage, ProxMate's own
 * firewall) leak back in. A placement that was vetted and then quietly ignored would be
 * worse than no scoping: the UI would say "delfino-02" while the guest sat in the
 * default pool.
 */

const NODE = 'pve-1';
const VMID = 101;
const PLACEMENT = { pool: 'delfino/delfino-02', bridge: 'dnet01', storage: 'primary_01' };

const getClient = vi.mocked(pve.getClient);
const createRow = vi.mocked(prisma.virtualMachine.create);
const updateRow = vi.mocked(prisma.virtualMachine.update);
const findManyVm = vi.mocked(prisma.virtualMachine.findMany);
const findUser = vi.mocked(prisma.user.findUnique);
const findConfig = vi.mocked(prisma.systemConfig.findUnique);

const user = { id: 'u1', role: 'user', maxCpu: 8, maxRam: 16384, maxStorage: 200 } as never;
const input = { name: 'app-01', cpu: 2, ram: 2048, storage: 5 };
const ok = (data: unknown) => Promise.resolve({ data: { data } });

function configuredAs(values: Record<string, string>) {
  findConfig.mockImplementation(((args: { where: { key: string } }) => {
    const v = values[args.where.key];
    return Promise.resolve(v === undefined ? null : { key: args.where.key, value: v, sensitive: false });
  }) as never);
}

/** Server defaults deliberately DIFFERENT from the placement, so any leak shows. */
const DEFAULTS = {
  default_storage: 'default_store',
  default_bridge: 'vmbr0',
  iso_storage: 'isos',
  isolation_enabled: 'true',
};

function fakeCluster(opts: { nodeStorages?: string[]; templateStorage?: string } = {}) {
  const c = fakeClient();
  const nodeStorages = opts.nodeStorages ?? ['primary_01', 'default_store'];
  const templateStorage = opts.templateStorage ?? 'primary_01';
  c.get.mockImplementation((url: string) => {
    if (url === '/cluster/nextid') return ok(String(VMID));
    if (/\/nodes\/[^/]+\/storage$/.test(url)) return ok(nodeStorages.map((storage) => ({ storage, type: 'rbd', active: 1 })));
    if (/\/qemu\/9000\/config$/.test(url)) return ok({ scsi0: `${templateStorage}:base-9000-disk-0,size=5G` });
    if (/\/qemu\/101\/config$/.test(url)) {
      return ok({ scsi0: 'x:vm-101-disk-0,size=5G', net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,firewall=1' });
    }
    if (/\/tasks\/.*\/status$/.test(url)) return ok({ status: 'stopped', exitstatus: 'OK' });
    if (/\/firewall\/rules$/.test(url)) return ok([]);
    return ok(null);
  });
  return c;
}

const template = (over: Record<string, unknown> = {}) =>
  ({ id: 't1', name: 'Debian 12', os: 'Debian 12', proxmoxVmId: 9000, proxmoxNode: NODE, cloudInit: false, diskGb: 5, ...over }) as never;

const postTo = (c: ReturnType<typeof fakeClient>, re: RegExp) => c.post.mock.calls.find((x) => re.test(String(x[0])));
const firewallWrites = (c: ReturnType<typeof fakeClient>) => c.put.mock.calls.filter((x) => /\/firewall\//.test(String(x[0])));
const rowData = () => createRow.mock.calls[0]![0].data as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  configuredAs(DEFAULTS);
  findManyVm.mockResolvedValue([] as never);
  findUser.mockResolvedValue(user);
  createRow.mockResolvedValue({ id: 'vm1', name: input.name, proxmoxVmId: VMID, proxmoxNode: NODE } as never);
  updateRow.mockImplementation(((args: { data: Record<string, unknown> }) => Promise.resolve({ id: 'vm1', ...args.data })) as never);
  vi.mocked(pve.getIsoNodes).mockResolvedValue([NODE]);
  vi.mocked(pve.pickBestNode).mockResolvedValue(NODE);
  vi.mocked(pve.getTemplateNodes).mockResolvedValue([NODE]);
});

// ─── Template deploy ──────────────────────────────────────────

describe('deployFromTemplate with a scoped placement', () => {
  it('clones INTO the requested pool', async () => {
    const c = fakeCluster();
    getClient.mockResolvedValue(asClient(c));

    await deployFromTemplate(user, template(), { ...input, placement: PLACEMENT });

    expect(bodyOf(postTo(c, /\/qemu\/9000\/clone$/)!)['pool']).toBe('delfino/delfino-02');
  });

  it('puts the NIC on the requested VNet, not the admin default bridge', async () => {
    const c = fakeCluster();
    getClient.mockResolvedValue(asClient(c));

    await deployFromTemplate(user, template(), { ...input, placement: PLACEMENT });

    const nic = c.put.mock.calls.map(bodyOf).find((b) => b['net0'] !== undefined);
    expect(nic!['net0']).toBe('virtio=AA:BB:CC:DD:EE:FF,bridge=dnet01,firewall=1');
  });

  it('targets the requested storage instead of the default', async () => {
    // Template on node-local storage, chosen storage elsewhere → full clone onto it.
    const c = fakeCluster({ templateStorage: 'tank', nodeStorages: ['tank', 'primary_01', 'default_store'] });
    getClient.mockResolvedValue(asClient(c));

    await deployFromTemplate(user, template(), { ...input, placement: PLACEMENT });

    expect(bodyOf(postTo(c, /\/qemu\/9000\/clone$/)!)).toMatchObject({ full: '1', storage: 'primary_01' });
  });

  it('does NOT apply ProxMate\'s own firewall: the granted SDN zone is the boundary', async () => {
    const c = fakeCluster();
    getClient.mockResolvedValue(asClient(c));

    await deployFromTemplate(user, template(), { ...input, placement: PLACEMENT });

    expect(firewallWrites(c)).toHaveLength(0);
  });

  it('records the pool and bridge so duplicates stay in the zone', async () => {
    getClient.mockResolvedValue(asClient(fakeCluster()));

    await deployFromTemplate(user, template(), { ...input, placement: PLACEMENT });

    expect(rowData()).toMatchObject({ pool: 'delfino/delfino-02', bridge: 'dnet01' });
  });

  it('refuses — rather than silently relocating — when the chosen storage is not on the template\'s node', async () => {
    const c = fakeCluster({ nodeStorages: ['default_store'] });
    getClient.mockResolvedValue(asClient(c));

    await expect(deployFromTemplate(user, template(), { ...input, placement: PLACEMENT })).rejects.toThrow(
      /Storage "primary_01" isn't available on node "pve-1"/,
    );
    expect(postTo(c, /\/clone$/)).toBeUndefined();
  });

  it('leaves the classic path untouched without a placement (no pool, defaults, isolation on)', async () => {
    configuredAs({ ...DEFAULTS, default_bridge: 'vmbr9' });
    const c = fakeCluster({ templateStorage: 'default_store' });
    getClient.mockResolvedValue(asClient(c));

    await deployFromTemplate(user, template(), input);

    expect(bodyOf(postTo(c, /\/qemu\/9000\/clone$/)!)['pool']).toBeUndefined();
    const nic = c.put.mock.calls.map(bodyOf).find((b) => b['net0'] !== undefined);
    expect(nic!['net0']).toContain('bridge=vmbr9');
    expect(firewallWrites(c).length).toBeGreaterThan(0);
    expect(rowData()['pool']).toBeUndefined();
  });
});

// ─── ISO install ──────────────────────────────────────────────

describe('createVm with a scoped placement', () => {
  const isoInput = { ...input, os: 'debian.iso' };

  it('creates in the requested pool, on the requested storage and VNet', async () => {
    const c = fakeCluster();
    getClient.mockResolvedValue(asClient(c));

    await createVm(user, { ...isoInput, placement: PLACEMENT });

    const body = bodyOf(postTo(c, new RegExp(`/nodes/${NODE}/qemu$`))!);
    expect(body['pool']).toBe('delfino/delfino-02');
    expect(body['scsi0']).toBe('primary_01:5');
    expect(body['net0']).toBe('virtio,bridge=dnet01,firewall=1');
  });

  it('schedules against the requested storage, not the default one', async () => {
    getClient.mockResolvedValue(asClient(fakeCluster()));

    await createVm(user, { ...isoInput, placement: PLACEMENT });

    expect(vi.mocked(pve.pickBestNode).mock.calls[0]![1]).toBe('primary_01');
  });

  it('skips ProxMate\'s firewall and records the placement', async () => {
    const c = fakeCluster();
    getClient.mockResolvedValue(asClient(c));

    await createVm(user, { ...isoInput, placement: PLACEMENT });

    expect(firewallWrites(c)).toHaveLength(0);
    expect(rowData()).toMatchObject({ pool: 'delfino/delfino-02', bridge: 'dnet01' });
  });

  it('is unchanged without a placement: default storage/bridge, no pool, isolation on', async () => {
    const c = fakeCluster();
    getClient.mockResolvedValue(asClient(c));

    await createVm(user, isoInput);

    const body = bodyOf(postTo(c, new RegExp(`/nodes/${NODE}/qemu$`))!);
    expect(body['pool']).toBeUndefined();
    expect(body['scsi0']).toBe('default_store:5');
    expect(body['net0']).toBe('virtio,bridge=vmbr0,firewall=1');
    expect(firewallWrites(c).length).toBeGreaterThan(0);
  });
});

// ─── LXC ──────────────────────────────────────────────────────

describe('createContainer with a scoped placement', () => {
  it('creates in the requested pool, rootfs storage and VNet', async () => {
    const c = fakeCluster();
    getClient.mockResolvedValue(asClient(c));

    await createContainer(user, {
      ...input,
      template: 'local:vztmpl/debian-12.tar.zst',
      password: 'hunter22',
      placement: PLACEMENT,
    });

    const body = bodyOf(postTo(c, new RegExp(`/nodes/${NODE}/lxc$`))!);
    expect(body['pool']).toBe('delfino/delfino-02');
    expect(body['rootfs']).toBe('primary_01:5');
    expect(body['net0']).toContain('bridge=dnet01');
    expect(firewallWrites(c)).toHaveLength(0);
    expect(rowData()).toMatchObject({ pool: 'delfino/delfino-02', bridge: 'dnet01', type: 'lxc' });
  });
});

// ─── Duplicate ────────────────────────────────────────────────

describe('duplicateVm of a scoped guest', () => {
  const source = (over: Record<string, unknown> = {}) =>
    ({ id: 'src', userId: 'u1', name: 'web', type: 'qemu', proxmoxVmId: 120, proxmoxNode: NODE, cpu: 2, ram: 4096, storage: 40, os: 'x', tags: null, status: 'stopped', pool: null, bridge: null, ...over }) as never;

  function dupCluster() {
    const c = fakeClient();
    c.get.mockImplementation((url: string) => {
      if (url === '/cluster/resources') return ok([{ type: 'qemu', vmid: 120, node: NODE }]);
      if (/\/qemu\/120\/status\/current$/.test(url)) return ok({ status: 'stopped' });
      if (url === '/cluster/nextid') return ok('130');
      if (/\/nodes\/[^/]+\/storage$/.test(url)) return ok([{ storage: 'default_store', type: 'rbd', active: 1 }]);
      // The copy inherits the source's NIC; a stamp of the admin default would be visible.
      if (/\/qemu\/130\/config$/.test(url)) return ok({ net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=dnet01,firewall=1' });
      if (/\/tasks\/.*\/status$/.test(url)) return ok({ status: 'stopped', exitstatus: 'OK' });
      if (/\/firewall\/rules$/.test(url)) return ok([]);
      return ok(null);
    });
    return c;
  }

  it('copies INTO the source\'s pool, leaves its bridge alone, and keeps its storage', async () => {
    const c = dupCluster();
    getClient.mockResolvedValue(asClient(c));
    findManyVm.mockResolvedValue([source()] as never);

    await duplicateVm(source({ pool: 'delfino/delfino-02', bridge: 'dnet01' }), 'web-copy');

    const body = bodyOf(postTo(c, /\/qemu\/120\/clone$/)!);
    expect(body['pool']).toBe('delfino/delfino-02');
    expect(body['storage']).toBeUndefined(); // stays where the source was vetted to be
    // The default bridge must not be stamped over the zone's VNet.
    expect(c.put.mock.calls.map(bodyOf).some((b) => b['net0'] !== undefined)).toBe(false);
    expect(firewallWrites(c)).toHaveLength(0);
    expect(rowData()).toMatchObject({ pool: 'delfino/delfino-02', bridge: 'dnet01' });
  });

  it('a classic guest is copied exactly as before (default storage and bridge, no pool)', async () => {
    configuredAs({ ...DEFAULTS, default_bridge: 'vmbr9' });
    const c = dupCluster();
    getClient.mockResolvedValue(asClient(c));
    findManyVm.mockResolvedValue([source()] as never);

    await duplicateVm(source(), 'web-copy');

    const body = bodyOf(postTo(c, /\/qemu\/120\/clone$/)!);
    expect(body['pool']).toBeUndefined();
    expect(body['storage']).toBe('default_store');
    expect(c.put.mock.calls.map(bodyOf).find((b) => b['net0'] !== undefined)!['net0']).toContain('bridge=vmbr9');
    expect(firewallWrites(c).length).toBeGreaterThan(0);
  });
});

// ─── Rebuild ──────────────────────────────────────────────────

describe('rebuildVm of a pooled guest', () => {
  it('refuses BEFORE touching anything: a rebuild would drop it out of its pool', async () => {
    const c = fakeCluster();
    getClient.mockResolvedValue(asClient(c));

    await expect(
      rebuildVm(user, { id: 'v', userId: 'u1', proxmoxVmId: 120, proxmoxNode: NODE, pool: 'delfino/delfino-02', bridge: 'dnet01' } as never, {
        kind: 'iso',
        os: 'x.iso',
      }),
    ).rejects.toThrow(/isn't supported for machines deployed into a Proxmox pool/);

    expect(getClient).not.toHaveBeenCalled();
    expect(c.delete).not.toHaveBeenCalled();
    expect(updateRow).not.toHaveBeenCalled();
  });
});
