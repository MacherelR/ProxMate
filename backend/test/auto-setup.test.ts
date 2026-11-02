import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock only the side-effecting functions; keep the real zod schemas (AdminSchema etc.)
// so this test is held to the exact same validation the HTTP routes use.
vi.mock('../src/services/setup.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/setup.service.js')>();
  return {
    ...actual,
    isSetupComplete: vi.fn(),
    findAdmin: vi.fn(),
    createAdmin: vi.fn(),
    saveProxmoxConfig: vi.fn(),
    testProxmoxConnection: vi.fn(),
    getProxmoxResources: vi.fn(),
    saveDefaults: vi.fn(),
    completeSetup: vi.fn(),
  };
});

// Same approach for sso.service.js: keep the real SsoSchema, mock only the write.
vi.mock('../src/services/sso.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/sso.service.js')>();
  return { ...actual, saveSsoConfig: vi.fn() };
});

import * as setup from '../src/services/setup.service.js';
import * as ssoService from '../src/services/sso.service.js';
import { runAutoSetup, type AutoSetupLogger } from '../src/scripts/auto-setup.js';

/**
 * `runAutoSetup` walks the OOBE wizard (admin → Proxmox → defaults → complete) from
 * environment variables instead of a human clicking through `/setup`. Importing the
 * module here must NOT execute it — that's the whole reason the CLI invocation at the
 * bottom of auto-setup.ts is guarded by an `isMain` check; these tests are also the
 * thing that would catch it regressing (a bad guard would hang vitest's own run,
 * since `main()` would call real services and try to exit the process).
 */

const isSetupComplete = vi.mocked(setup.isSetupComplete);
const findAdmin = vi.mocked(setup.findAdmin);
const createAdmin = vi.mocked(setup.createAdmin);
const saveProxmoxConfig = vi.mocked(setup.saveProxmoxConfig);
const testProxmoxConnection = vi.mocked(setup.testProxmoxConnection);
const getProxmoxResources = vi.mocked(setup.getProxmoxResources);
const saveDefaults = vi.mocked(setup.saveDefaults);
const completeSetup = vi.mocked(setup.completeSetup);
const saveSsoConfig = vi.mocked(ssoService.saveSsoConfig);

const silent: AutoSetupLogger = { info: () => undefined, warn: () => undefined };

const VALID_ENV = {
  PROXMATE_AUTO_SETUP: 'true',
  ADMIN_EMAIL: 'admin@example.com',
  ADMIN_PASSWORD: 'correct-horse-battery',
  PROXMOX_HOST: 'https://pve.example.com:8006',
  PROXMOX_TOKEN_ID: 'root@pam!proxmate',
  PROXMOX_TOKEN_SECRET: 'sekret',
  DEFAULT_STORAGE: 'local-zfs',
  DEFAULT_BRIDGE: 'vmbr0',
  DEFAULT_ISO_STORAGE: 'local',
};

const RESOURCES = {
  storages: [{ name: 'local-zfs', type: 'zfspool' }],
  bridges: [{ name: 'vmbr0', type: 'bridge' }],
  isoStorages: [{ name: 'local', type: 'dir' }],
  backupStorages: [{ name: 'backup-nfs', type: 'nfs' }],
};

const CONNECTION_OK = { connected: true, version: '8.2', nodeCount: 1, vmCount: 0, storageCount: 1, warnings: [] };

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  vi.clearAllMocks();
  savedEnv = { ...process.env };
  // Start from a clean slate: no leftover PROXMATE_AUTO_SETUP / ADMIN_* / PROXMOX_* /
  // DEFAULT_* from a previous test or the real shell this suite runs under.
  for (const key of Object.keys(process.env)) {
    if (
      key === 'PROXMATE_AUTO_SETUP' ||
      key.startsWith('ADMIN_') ||
      key.startsWith('PROXMOX_') ||
      key.startsWith('DEFAULT_') ||
      key.startsWith('SSO_')
    ) {
      delete process.env[key];
    }
  }
  isSetupComplete.mockResolvedValue(false);
  findAdmin.mockResolvedValue(null);
  getProxmoxResources.mockResolvedValue(RESOURCES as never);
  testProxmoxConnection.mockResolvedValue(CONNECTION_OK as never);
});

afterEach(() => {
  process.env = savedEnv;
});

describe('runAutoSetup — the opt-in gate', () => {
  it('is a no-op when PROXMATE_AUTO_SETUP is unset — touches nothing', async () => {
    expect(await runAutoSetup(silent)).toBe(false);
    expect(isSetupComplete).not.toHaveBeenCalled();
  });

  it.each(['false', 'TRUE', '1', 'yes', ''])('is a no-op for PROXMATE_AUTO_SETUP=%j (only the exact string "true" opts in)', async (v) => {
    process.env['PROXMATE_AUTO_SETUP'] = v;
    expect(await runAutoSetup(silent)).toBe(false);
    expect(isSetupComplete).not.toHaveBeenCalled();
  });

  it('is a permanent no-op once setup is already complete, whatever the env says', async () => {
    Object.assign(process.env, VALID_ENV);
    isSetupComplete.mockResolvedValue(true);

    expect(await runAutoSetup(silent)).toBe(false);

    expect(findAdmin).not.toHaveBeenCalled();
    expect(createAdmin).not.toHaveBeenCalled();
    expect(saveProxmoxConfig).not.toHaveBeenCalled();
  });
});

describe('runAutoSetup — input validation (fails closed, before anything is written)', () => {
  it.each([
    ['ADMIN_EMAIL', 'not-an-email'],
    ['ADMIN_PASSWORD', 'short'],
  ])('rejects an invalid %s and writes nothing', async (key, bad) => {
    Object.assign(process.env, VALID_ENV, { [key]: bad });
    await expect(runAutoSetup(silent)).rejects.toThrow(/ADMIN_EMAIL|ADMIN_PASSWORD/);
    expect(createAdmin).not.toHaveBeenCalled();
    expect(saveProxmoxConfig).not.toHaveBeenCalled();
  });

  it('rejects a missing ADMIN_EMAIL', async () => {
    const env = { ...VALID_ENV } as Record<string, string>;
    delete env['ADMIN_EMAIL'];
    Object.assign(process.env, env);
    await expect(runAutoSetup(silent)).rejects.toThrow(/ADMIN_EMAIL/);
  });

  it('rejects a PROXMOX_HOST that is not a URL, before saving or testing anything', async () => {
    Object.assign(process.env, VALID_ENV, { PROXMOX_HOST: 'pve.example.com' }); // no scheme
    await expect(runAutoSetup(silent)).rejects.toThrow(/PROXMOX_HOST/);
    expect(saveProxmoxConfig).not.toHaveBeenCalled();
  });

  it('rejects a missing PROXMOX_TOKEN_SECRET', async () => {
    const env = { ...VALID_ENV } as Record<string, string>;
    delete env['PROXMOX_TOKEN_SECRET'];
    Object.assign(process.env, env);
    await expect(runAutoSetup(silent)).rejects.toThrow(/PROXMOX_TOKEN/);
  });

  it('rejects a missing DEFAULT_STORAGE/BRIDGE/ISO_STORAGE, before touching Proxmox', async () => {
    const env = { ...VALID_ENV } as Record<string, string>;
    delete env['DEFAULT_BRIDGE'];
    Object.assign(process.env, env);
    await expect(runAutoSetup(silent)).rejects.toThrow(/DEFAULT_STORAGE.*DEFAULT_BRIDGE.*DEFAULT_ISO_STORAGE/);
    // Validation runs before ANY service call in the happy path's order.
    expect(saveProxmoxConfig).not.toHaveBeenCalled();
    expect(createAdmin).not.toHaveBeenCalled();
  });

  it('validates every section before calling anything, even when only the LAST one is bad', async () => {
    const env = { ...VALID_ENV } as Record<string, string>;
    delete env['DEFAULT_STORAGE'];
    Object.assign(process.env, env);
    await expect(runAutoSetup(silent)).rejects.toThrow();
    expect(createAdmin).not.toHaveBeenCalled();
    expect(saveProxmoxConfig).not.toHaveBeenCalled();
  });
});

describe('runAutoSetup — the happy path', () => {
  it('creates the admin, saves the connection, verifies it, checks and saves the defaults, then completes', async () => {
    Object.assign(process.env, VALID_ENV);

    expect(await runAutoSetup(silent)).toBe(true);

    expect(createAdmin).toHaveBeenCalledWith({
      email: 'admin@example.com',
      password: 'correct-horse-battery',
      displayName: 'Administrator', // default when ADMIN_DISPLAY_NAME is unset
    });
    expect(saveProxmoxConfig).toHaveBeenCalledWith({
      host: 'https://pve.example.com:8006',
      tokenId: 'root@pam!proxmate',
      tokenSecret: 'sekret',
      verifySsl: true,
    });
    expect(testProxmoxConnection).toHaveBeenCalledTimes(1);
    expect(getProxmoxResources).toHaveBeenCalledTimes(1);
    expect(saveDefaults).toHaveBeenCalledWith({
      storage: 'local-zfs',
      bridge: 'vmbr0',
      isoStorage: 'local',
      backupStorage: undefined,
    });
    expect(completeSetup).toHaveBeenCalledTimes(1);

    // Order matters: Proxmox must be saved+verified before defaults are checked against it.
    const order = [saveProxmoxConfig, testProxmoxConnection, getProxmoxResources, saveDefaults, completeSetup].map(
      (fn) => fn.mock.invocationCallOrder[0],
    );
    expect(order).toEqual([...order].sort((a, b) => a! - b!));
  });

  it('honours a custom ADMIN_DISPLAY_NAME', async () => {
    Object.assign(process.env, VALID_ENV, { ADMIN_DISPLAY_NAME: 'Range Control' });
    await runAutoSetup(silent);
    expect(createAdmin).toHaveBeenCalledWith(expect.objectContaining({ displayName: 'Range Control' }));
  });

  it('passes through an optional DEFAULT_BACKUP_STORAGE that the interactive OOBE route never exposed', async () => {
    Object.assign(process.env, VALID_ENV, { DEFAULT_BACKUP_STORAGE: 'backup-nfs' });
    await runAutoSetup(silent);
    expect(saveDefaults).toHaveBeenCalledWith(expect.objectContaining({ backupStorage: 'backup-nfs' }));
  });

  it.each([
    ['false', false],
    ['true', true],
    [undefined, true], // unset
    ['False', true], // only the exact lowercase string turns it off — the safe/strict default otherwise
    ['no', true],
  ])('PROXMOX_VERIFY_SSL=%j resolves to verifySsl=%j', async (raw, expected) => {
    const env = { ...VALID_ENV } as Record<string, string>;
    if (raw === undefined) delete env['PROXMOX_VERIFY_SSL'];
    else env['PROXMOX_VERIFY_SSL'] = raw;
    Object.assign(process.env, env);

    await runAutoSetup(silent);

    expect(saveProxmoxConfig).toHaveBeenCalledWith(expect.objectContaining({ verifySsl: expected }));
  });
});

describe('runAutoSetup — resumability after a partial/crashed run', () => {
  it('does not try to recreate an admin that already matches ADMIN_EMAIL', async () => {
    Object.assign(process.env, VALID_ENV);
    findAdmin.mockResolvedValue({ id: 'u1', email: 'admin@example.com' });

    expect(await runAutoSetup(silent)).toBe(true);

    expect(createAdmin).not.toHaveBeenCalled();
    expect(saveProxmoxConfig).toHaveBeenCalled(); // the rest of the flow still runs
    expect(completeSetup).toHaveBeenCalled();
  });

  it('refuses to adopt a pre-existing admin with a DIFFERENT email, rather than proceeding as though it were its own', async () => {
    Object.assign(process.env, VALID_ENV);
    findAdmin.mockResolvedValue({ id: 'u1', email: 'someone-else@example.com' });

    await expect(runAutoSetup(silent)).rejects.toThrow(/someone-else@example\.com.*admin@example\.com/);

    // This is the bug that left /setup stuck on "step 2": must not silently continue
    // past a mismatched admin into saving Proxmox / completing setup.
    expect(createAdmin).not.toHaveBeenCalled();
    expect(saveProxmoxConfig).not.toHaveBeenCalled();
    expect(completeSetup).not.toHaveBeenCalled();
  });
});

describe('runAutoSetup — fails closed on a Proxmox problem, writes nothing further', () => {
  it('propagates testProxmoxConnection\'s own error message verbatim', async () => {
    Object.assign(process.env, VALID_ENV);
    testProxmoxConnection.mockRejectedValue(new Error('VM.Audit is missing — …'));

    await expect(runAutoSetup(silent)).rejects.toThrow('VM.Audit is missing');

    expect(getProxmoxResources).not.toHaveBeenCalled();
    expect(saveDefaults).not.toHaveBeenCalled();
    expect(completeSetup).not.toHaveBeenCalled();
  });

  it.each([
    ['DEFAULT_STORAGE', 'nonexistent-pool', /DEFAULT_STORAGE="nonexistent-pool".*local-zfs/],
    ['DEFAULT_BRIDGE', 'vmbr9', /DEFAULT_BRIDGE="vmbr9".*vmbr0/],
    ['DEFAULT_ISO_STORAGE', 'isos', /DEFAULT_ISO_STORAGE="isos".*local/],
  ])('refuses a %s that the cluster does not actually have, naming what IS available', async (key, bad, expected) => {
    Object.assign(process.env, VALID_ENV, { [key]: bad });

    await expect(runAutoSetup(silent)).rejects.toThrow(expected);

    expect(saveDefaults).not.toHaveBeenCalled();
    expect(completeSetup).not.toHaveBeenCalled();
  });

  it('refuses a DEFAULT_BACKUP_STORAGE that is not a real backup-capable storage', async () => {
    Object.assign(process.env, VALID_ENV, { DEFAULT_BACKUP_STORAGE: 'not-a-backup-pool' });

    await expect(runAutoSetup(silent)).rejects.toThrow(/DEFAULT_BACKUP_STORAGE="not-a-backup-pool".*backup-nfs/);

    expect(saveDefaults).not.toHaveBeenCalled();
  });

  it('does not check backup storage at all when DEFAULT_BACKUP_STORAGE is unset', async () => {
    Object.assign(process.env, VALID_ENV);
    await runAutoSetup(silent);
    // Would have thrown above if it wrongly validated an absent value against RESOURCES.backupStorages.
    expect(completeSetup).toHaveBeenCalled();
  });
});

describe('runAutoSetup — optional SSO configuration', () => {
  it('leaves SSO untouched when neither SSO_ISSUER nor SSO_CLIENT_ID is set', async () => {
    Object.assign(process.env, VALID_ENV);
    await runAutoSetup(silent);
    expect(saveSsoConfig).not.toHaveBeenCalled();
    expect(completeSetup).toHaveBeenCalled(); // the rest of the flow is unaffected
  });

  it('requires SSO_CLIENT_SECRET once SSO_ISSUER/SSO_CLIENT_ID are set, even though SsoSchema itself allows it blank', async () => {
    Object.assign(process.env, VALID_ENV, {
      SSO_ISSUER: 'https://sso.c.cybx.ch/realms/cybx',
      SSO_CLIENT_ID: 'proxmate',
    });

    await expect(runAutoSetup(silent)).rejects.toThrow(/SSO_CLIENT_SECRET/);

    expect(saveSsoConfig).not.toHaveBeenCalled();
    expect(completeSetup).not.toHaveBeenCalled(); // fails before finishing the rest of setup too
  });

  it('configures SSO with the given values, enabled by default once opted in', async () => {
    Object.assign(process.env, VALID_ENV, {
      SSO_ISSUER: 'https://sso.c.cybx.ch/realms/cybx',
      SSO_CLIENT_ID: 'proxmate',
      SSO_CLIENT_SECRET: 'placeholder-secret',
      SSO_GROUPS_CLAIM: 'role',
      SSO_ADMIN_GROUP: 'ctr_admin',
    });

    await runAutoSetup(silent);

    expect(saveSsoConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        issuer: 'https://sso.c.cybx.ch/realms/cybx',
        clientId: 'proxmate',
        clientSecret: 'placeholder-secret',
        groupsClaim: 'role',
        adminGroup: 'ctr_admin',
        allowSignup: false, // not requested — stays off, ProxMate's own base default
      }),
    );
    expect(completeSetup).toHaveBeenCalled();
  });

  it('respects an explicit SSO_ENABLED=false (save but don\'t turn it on yet)', async () => {
    Object.assign(process.env, VALID_ENV, {
      SSO_ISSUER: 'https://sso.c.cybx.ch/realms/cybx',
      SSO_CLIENT_ID: 'proxmate',
      SSO_CLIENT_SECRET: 'placeholder-secret',
      SSO_ENABLED: 'false',
    });
    await runAutoSetup(silent);
    expect(saveSsoConfig).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it('turns on allowSignup only when explicitly asked (SSO_ALLOW_SIGNUP=true)', async () => {
    Object.assign(process.env, VALID_ENV, {
      SSO_ISSUER: 'https://sso.c.cybx.ch/realms/cybx',
      SSO_CLIENT_ID: 'proxmate',
      SSO_CLIENT_SECRET: 'placeholder-secret',
      SSO_ALLOW_SIGNUP: 'true',
    });
    await runAutoSetup(silent);
    expect(saveSsoConfig).toHaveBeenCalledWith(expect.objectContaining({ allowSignup: true }));
  });

  it('rejects a non-URL SSO_ISSUER with the same validation the admin UI uses, before saving anything', async () => {
    Object.assign(process.env, VALID_ENV, {
      SSO_ISSUER: 'not-a-url',
      SSO_CLIENT_ID: 'proxmate',
      SSO_CLIENT_SECRET: 'placeholder-secret',
    });

    await expect(runAutoSetup(silent)).rejects.toThrow(/SSO_.*valid URL/);

    expect(saveSsoConfig).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric SSO_NEW_USER_CPU rather than silently dropping it', async () => {
    Object.assign(process.env, VALID_ENV, {
      SSO_ISSUER: 'https://sso.c.cybx.ch/realms/cybx',
      SSO_CLIENT_ID: 'proxmate',
      SSO_CLIENT_SECRET: 'placeholder-secret',
      SSO_NEW_USER_CPU: 'not-a-number',
    });

    await expect(runAutoSetup(silent)).rejects.toThrow(/SSO_/);

    expect(saveSsoConfig).not.toHaveBeenCalled();
  });

  it('is configured AFTER the base setup checks, not before (fails fast on bad Proxmox input first)', async () => {
    Object.assign(process.env, VALID_ENV, {
      DEFAULT_BRIDGE: 'does-not-exist',
      SSO_ISSUER: 'https://sso.c.cybx.ch/realms/cybx',
      SSO_CLIENT_ID: 'proxmate',
      SSO_CLIENT_SECRET: 'placeholder-secret',
    });

    await expect(runAutoSetup(silent)).rejects.toThrow(/DEFAULT_BRIDGE/);

    expect(saveSsoConfig).not.toHaveBeenCalled();
  });
});
