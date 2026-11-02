import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));
vi.mock('../src/services/config.service.js', () => ({ getConfig: vi.fn() }));

import { getConfig } from '../src/services/config.service.js';
import { isIsoAdminOnly, assertMayInstallFromIso, CreateOptionError } from '../src/services/vm.service.js';

/**
 * ISO installs can be restricted to admins (an operator who wants tenants deploying
 * ONLY from curated templates, not Proxmox's generic ISO storage — which can otherwise
 * include other guests' own cdrom volumes, see get-isos.test.ts). Off by default
 * ("iso_admin_only" unset), so nothing changes until an admin opts in.
 *
 * `assertMayInstallFromIso` is the ONE enforcement point `POST /api/vms` calls before
 * doing anything else, and the exact fact `/auth/me`'s `isoInstallAllowed` mirrors for
 * the wizard — this file pins the decision logic itself, independent of either caller.
 */

const mockGetConfig = vi.mocked(getConfig);

beforeEach(() => vi.clearAllMocks());

describe('isIsoAdminOnly', () => {
  it('is false when unset (the default — classic behaviour)', async () => {
    mockGetConfig.mockResolvedValue(null);
    expect(await isIsoAdminOnly()).toBe(false);
  });

  it('is false for the literal string "false"', async () => {
    mockGetConfig.mockResolvedValue('false');
    expect(await isIsoAdminOnly()).toBe(false);
  });

  it('is true only for the exact string "true"', async () => {
    mockGetConfig.mockResolvedValue('true');
    expect(await isIsoAdminOnly()).toBe(true);
  });
});

describe('assertMayInstallFromIso', () => {
  it('never restricts an admin — and does not even read the setting', async () => {
    await expect(assertMayInstallFromIso({ role: 'admin' })).resolves.toBeUndefined();
    expect(mockGetConfig).not.toHaveBeenCalled();
  });

  it('admits a non-admin when the restriction is off', async () => {
    mockGetConfig.mockResolvedValue('false');
    await expect(assertMayInstallFromIso({ role: 'user' })).resolves.toBeUndefined();
  });

  it('admits a non-admin when the setting has never been configured', async () => {
    mockGetConfig.mockResolvedValue(null);
    await expect(assertMayInstallFromIso({ role: 'user' })).resolves.toBeUndefined();
  });

  it('refuses a non-admin when the restriction is on, with a CreateOptionError naming templates as the alternative', async () => {
    mockGetConfig.mockResolvedValue('true');
    const err = await assertMayInstallFromIso({ role: 'user' }).catch((e) => e as CreateOptionError);
    expect(err).toBeInstanceOf(CreateOptionError);
    expect(err.status).toBe(403);
    expect(err.message).toMatch(/admin-only/i);
    expect(err.message).toMatch(/template/i);
  });
});
