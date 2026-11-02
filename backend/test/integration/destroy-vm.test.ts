import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock only the seams: the DB and the Proxmox client factory. The REAL
// proxmox.service request-builders run against the fake axios below.
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: { virtualMachine: { delete: vi.fn(), update: vi.fn() } },
}));
vi.mock('../../src/services/proxmox.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/proxmox.service.js')>();
  return { ...actual, getClient: vi.fn() };
});

import { prisma } from '../../src/lib/prisma.js';
import * as pve from '../../src/services/proxmox.service.js';
import { destroyVm } from '../../src/services/vm.service.js';

const del = vi.mocked(prisma.virtualMachine.delete);
const update = vi.mocked(prisma.virtualMachine.update);
const getClientMock = vi.mocked(pve.getClient);

const VM = { id: 'db-1', proxmoxNode: 'pve-int', proxmoxVmId: 100, type: 'qemu' } as never;

beforeEach(() => {
  vi.clearAllMocks();
  del.mockResolvedValue({} as never);
});

describe('destroyVm (deleting a guest that never actually exists on Proxmox)', () => {
  it('treats a permission-denied delete as already-gone when the guest is invisible to this account', async () => {
    const client = {
      get: vi.fn((url: string) => {
        if (url === '/cluster/resources') return Promise.resolve({ data: { data: [] } });
        if (/\/status\/current$/.test(url)) return Promise.reject(new Error('Permission check failed (/vms/100, VM.Allocate)'));
        return Promise.resolve({ data: { data: null } });
      }),
      delete: vi.fn(() => Promise.reject(new Error('Permission check failed (/vms/100, VM.Allocate)'))),
      post: vi.fn(() => Promise.resolve({ data: { data: 'UPID:task' } })),
    };
    getClientMock.mockResolvedValue(client as never);

    await expect(destroyVm(VM)).resolves.toBeUndefined();

    expect(del).toHaveBeenCalledWith({ where: { id: 'db-1' } });
  });

  it('still surfaces the error when the guest genuinely exists and deletion is denied', async () => {
    const client = {
      get: vi.fn((url: string) => {
        if (url === '/cluster/resources') return Promise.resolve({ data: { data: [] } });
        if (/\/status\/current$/.test(url)) return Promise.resolve({ data: { data: { status: 'stopped' } } });
        return Promise.resolve({ data: { data: null } });
      }),
      delete: vi.fn(() => Promise.reject(new Error('Permission check failed (/vms/100, VM.Allocate)'))),
      post: vi.fn(() => Promise.resolve({ data: { data: 'UPID:task' } })),
    };
    getClientMock.mockResolvedValue(client as never);

    await expect(destroyVm(VM)).rejects.toThrow('Permission check failed');

    // A real, still-existing guest must never be silently dropped from the DB.
    expect(del).not.toHaveBeenCalled();
  });
});
