import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));
vi.mock('../src/services/config.service.js', () => ({
  isSetupComplete: vi.fn(),
  getConfig: vi.fn(async () => null),
  setConfig: vi.fn(),
}));
vi.mock('../src/services/auth.service.js', () => ({ createSession: vi.fn() }));
vi.mock('../src/services/proxmox.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/proxmox.service.js')>();
  return {
    ...actual,
    getClient: vi.fn(async () => ({}) as never),
    getStorages: vi.fn(),
    getBridges: vi.fn(),
    getSdnVnets: vi.fn(),
  };
});

import * as pve from '../src/services/proxmox.service.js';
import { getProxmoxResources } from '../src/services/setup.service.js';

/**
 * The OOBE "Default bridge" dropdown (and auto-setup's DEFAULT_BRIDGE check) used to
 * ask ONLY for classic Linux bridges (`/nodes/<node>/network?type=bridge`). A cluster
 * whose guest networking is entirely SDN VNets — no vmbr0-style bridge at all, as on a
 * per-exercise gamenet — got back an empty list and nothing could ever be chosen,
 * verified live: "DEFAULT_BRIDGE=... was not found on the cluster. Available: (none
 * visible to this token)." on a cluster whose token could see three real VNets.
 *
 * A VNet is exactly as valid a `net0: bridge=<name>` value as a classic bridge, so the
 * fix is additive: merge `/cluster/sdn/vnets` into the same list.
 */

const getStorages = vi.mocked(pve.getStorages);
const getBridges = vi.mocked(pve.getBridges);
const getSdnVnets = vi.mocked(pve.getSdnVnets);

const STORAGES = [
  { storage: 'local', type: 'dir', content: 'iso,backup' },
  { storage: 'local-zfs', type: 'zfspool', content: 'images' },
];

beforeEach(() => {
  vi.clearAllMocks();
  getStorages.mockResolvedValue(STORAGES as never);
  getBridges.mockResolvedValue([]);
  getSdnVnets.mockResolvedValue([]);
});

describe('getProxmoxResources — bridges', () => {
  it('lists SDN VNets when there are no classic bridges at all (the SDN-only cluster)', async () => {
    getBridges.mockResolvedValue([]);
    getSdnVnets.mockResolvedValue([
      { vnet: 'w02in', zone: 'weiss02' },
      { vnet: 'w02lan', zone: 'weiss02' },
      { vnet: 'w02soc', zone: 'weiss02' },
    ]);

    const res = await getProxmoxResources();

    expect(res.bridges).toEqual([{ name: 'w02in' }, { name: 'w02lan' }, { name: 'w02soc' }]);
  });

  it('still lists classic bridges on a cluster with no SDN at all', async () => {
    getBridges.mockResolvedValue([{ iface: 'vmbr0', type: 'bridge' }] as never);
    getSdnVnets.mockResolvedValue([]);

    const res = await getProxmoxResources();

    expect(res.bridges).toEqual([{ name: 'vmbr0' }]);
  });

  it('merges both when a cluster has classic bridges AND SDN VNets', async () => {
    getBridges.mockResolvedValue([{ iface: 'vmbr0', type: 'bridge' }] as never);
    getSdnVnets.mockResolvedValue([{ vnet: 'tenants', zone: 'tenantz' }]);

    const res = await getProxmoxResources();

    expect(res.bridges).toEqual([{ name: 'vmbr0' }, { name: 'tenants' }]);
  });

  it('does not list a VNet twice if it happens to share a name with a classic bridge', async () => {
    getBridges.mockResolvedValue([{ iface: 'vmbr0', type: 'bridge' }] as never);
    getSdnVnets.mockResolvedValue([{ vnet: 'vmbr0', zone: 'oddzone' }]);

    const res = await getProxmoxResources();

    expect(res.bridges).toEqual([{ name: 'vmbr0' }]);
  });

  it('a failed SDN lookup (older PVE, SDN not configured) does not take the classic bridge list down with it', async () => {
    getBridges.mockResolvedValue([{ iface: 'vmbr0', type: 'bridge' }] as never);
    getSdnVnets.mockRejectedValue(new Error('SDN is not configured'));

    const res = await getProxmoxResources();

    expect(res.bridges).toEqual([{ name: 'vmbr0' }]);
  });

  it('is an empty list, not a thrown error, when the token genuinely sees neither', async () => {
    const res = await getProxmoxResources();
    expect(res.bridges).toEqual([]);
  });
});

describe('getProxmoxResources — storages (unaffected by the bridge change)', () => {
  it('still splits storages by content type', async () => {
    const res = await getProxmoxResources();
    expect(res.storages).toEqual([{ name: 'local-zfs', type: 'zfspool' }]);
    expect(res.isoStorages).toEqual([{ name: 'local', type: 'dir' }]);
    expect(res.backupStorages).toEqual([{ name: 'local', type: 'dir' }]);
  });
});
