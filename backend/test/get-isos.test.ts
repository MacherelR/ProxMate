import { describe, it, expect } from 'vitest';
import { getIsos } from '../src/services/proxmox.service.js';
import { fakeClient, asClient } from './helpers.js';

/**
 * The install-ISO picker (and auto-setup's resource listing) used to show EVERY volume
 * Proxmox classifies as `content=iso` on the configured storage — which includes other
 * guests' own cdrom volumes, not just genuinely shared install media. Most commonly a
 * VM's cloud-init seed: a NoCloud datasource is itself an ISO9660 image, so Proxmox
 * legitimately tags it `content=iso` too. Verified live: a shared ISO storage on a
 * multi-tenant cluster showed every other tenant's cloud-init seed in the dropdown
 * alongside the real install media.
 *
 * The fix relies on the SAME convention this file already uses elsewhere to recognize a
 * real ISO attachment (`<storage>:iso/<file>`, exactly what createVm() constructs) —
 * anything outside that shared-library path is a guest-owned volume, never something a
 * tenant should install FROM.
 */

const NODE = 'pve-1';
const STORAGE = 'secondary_01';
const ok = (data: unknown) => Promise.resolve({ data: { data } });

function fakeCluster(items: Array<{ volid: string; size?: number }>) {
  const c = fakeClient();
  c.get.mockImplementation((url: string) => {
    if (url === '/nodes') return ok([{ node: NODE, status: 'online' }]);
    if (url === `/nodes/${NODE}/storage/${STORAGE}/content?content=iso`) return ok(items);
    return ok(null);
  });
  return c;
}

describe('getIsos', () => {
  it('lists a real, shared-library install ISO', async () => {
    const c = fakeCluster([{ volid: `${STORAGE}:iso/ubuntu-24.04.iso`, size: 123 }]);
    expect(await getIsos(STORAGE, asClient(c))).toEqual([
      { volid: `${STORAGE}:iso/ubuntu-24.04.iso`, name: 'ubuntu-24.04.iso', size: 123 },
    ]);
  });

  it("excludes another guest's cloud-init seed volume (vmid-prefixed path)", async () => {
    const c = fakeCluster([
      { volid: `${STORAGE}:iso/ubuntu-24.04.iso` },
      { volid: `${STORAGE}:109/vm-109-cloudinit.qcow2` },
    ]);
    const names = (await getIsos(STORAGE, asClient(c))).map((i) => i.name);
    expect(names).toEqual(['ubuntu-24.04.iso']);
  });

  it('excludes a guest-owned volume regardless of its filename, not just by "cloudinit" in the name', async () => {
    // The guard is the volid SHAPE (vmid-prefixed vs. the iso/ shared-library path), not
    // a filename guess — a renamed or differently-sourced guest cdrom must be caught too.
    const c = fakeCluster([
      { volid: `${STORAGE}:iso/debian-12.iso` },
      { volid: `${STORAGE}:204/some-other-seed.iso` },
    ]);
    const names = (await getIsos(STORAGE, asClient(c))).map((i) => i.name);
    expect(names).toEqual(['debian-12.iso']);
  });

  it('is an empty list when the only content is guest-owned, not an error', async () => {
    const c = fakeCluster([{ volid: `${STORAGE}:109/vm-109-cloudinit.qcow2` }]);
    expect(await getIsos(STORAGE, asClient(c))).toEqual([]);
  });

  it('dedupes the same real ISO seen on multiple nodes (shared storage)', async () => {
    const c = fakeClient();
    c.get.mockImplementation((url: string) => {
      if (url === '/nodes') {
        return ok([
          { node: 'pve-1', status: 'online' },
          { node: 'pve-2', status: 'online' },
        ]);
      }
      if (url.startsWith('/nodes/') && url.endsWith(`/storage/${STORAGE}/content?content=iso`)) {
        return ok([{ volid: `${STORAGE}:iso/ubuntu-24.04.iso` }]);
      }
      return ok(null);
    });
    expect(await getIsos(STORAGE, asClient(c))).toHaveLength(1);
  });

  it('skips a node where the storage does not exist, without failing the whole call', async () => {
    const c = fakeClient();
    c.get.mockImplementation((url: string) => {
      if (url === '/nodes') {
        return ok([
          { node: 'pve-1', status: 'online' },
          { node: 'pve-2', status: 'online' },
        ]);
      }
      if (url === `/nodes/pve-1/storage/${STORAGE}/content?content=iso`) {
        return ok([{ volid: `${STORAGE}:iso/ubuntu-24.04.iso` }]);
      }
      if (url === `/nodes/pve-2/storage/${STORAGE}/content?content=iso`) {
        return Promise.reject(new Error('storage not found on this node'));
      }
      return ok(null);
    });
    expect(await getIsos(STORAGE, asClient(c))).toEqual([
      { volid: `${STORAGE}:iso/ubuntu-24.04.iso`, name: 'ubuntu-24.04.iso' },
    ]);
  });
});
