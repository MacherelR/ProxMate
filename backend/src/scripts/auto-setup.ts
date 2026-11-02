import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  isSetupComplete,
  findAdmin,
  createAdmin,
  saveProxmoxConfig,
  testProxmoxConnection,
  getProxmoxResources,
  saveDefaults,
  completeSetup,
  AdminSchema,
  ProxmoxConfigSchema,
  DefaultsSchema,
} from '../services/setup.service.js';
import { saveSsoConfig, SsoSchema } from '../services/sso.service.js';

/**
 * Walk the first-time setup wizard (admin account, Proxmox connection, VM defaults)
 * from environment variables instead of a human clicking through `/setup`. Opt-in via
 * `PROXMATE_AUTO_SETUP=true` — unset, this is a no-op and nothing changes for anyone
 * who still wants the interactive wizard.
 *
 * `runAutoSetup` is the whole thing, as a plain async function that THROWS on any
 * problem rather than calling `process.exit` itself — so it's unit-testable the same
 * way every other service in this project is (mock setup.service, assert on the
 * rejection). Only the bottom of this file, run when the script is actually invoked as
 * a CLI (not when a test imports it), maps that throw to a process exit code.
 *
 * Lives under `src/` so `tsc` compiles it to `dist/scripts/auto-setup.js`, which the
 * Dockerfile's existing `COPY --from=build /app/dist ./dist` already carries — same
 * pattern as `migrate-modules.ts`. Invoked from `docker-entrypoint.sh` after migrations,
 * before the server starts serving.
 *
 * SAFE TO RUN ON EVERY BOOT. `isSetupComplete()` is checked first and short-circuits
 * everything else — once setup finishes, this becomes a permanent no-op for that
 * database, exactly like the interactive routes return 403 once `setup_complete` is set.
 * It will never re-apply stale env vars over settings an admin later changed by hand.
 *
 * RESUMABLE — but only for ITS OWN admin. A crash (or a container killed) partway
 * through — admin created but Proxmox not yet connected — must not make the next boot
 * fail with "Admin account already exists": `findAdmin()` is checked separately from
 * `isSetupComplete()`, so a resumed run reuses the existing admin instead of trying to
 * recreate it. But an admin created some OTHER way (the interactive wizard, used once
 * before this was configured; a different ADMIN_EMAIL from an earlier attempt) is NOT
 * silently adopted — this refuses with a clear error instead of proceeding as though it
 * were the one it was about to create, which would otherwise leave `/setup` stuck
 * showing "step 2" forever: the admin from before means `adminExists: true`, but with
 * this script unable to finish setup. Delete that account or correct `ADMIN_EMAIL`.
 *
 * FAILS CLOSED on a bad input, by design, not just by omission: a misconfigured
 * `PROXMOX_HOST`/token makes this throw rather than complete setup against a connection
 * that doesn't work. Under a `restart: unless-stopped` policy that means the container
 * crash-loops until the input is fixed (or the cluster becomes reachable) —
 * self-healing for "Proxmox isn't up yet during orchestrated provisioning" and loud for
 * "the token is wrong", which is the trade this project makes everywhere else too (see
 * `testProxmoxConnection`'s own doc comment).
 *
 * SSO IS SEPARATELY OPTIONAL, on top of the above. `SSO_ISSUER` + `SSO_CLIENT_ID` (+
 * `SSO_CLIENT_SECRET` — required alongside them here, even though the general
 * `SsoSchema` allows it blank for an ONGOING update that keeps the existing one; a
 * FIRST-time configure with no secret stored yet would just leave SSO broken) opt into
 * configuring SSO as part of the same one-shot run, saved with `saveSsoConfig` — the
 * exact function the admin UI's "Save SSO settings" button calls, so there is no
 * separate, weaker path. Neither var set: SSO is left exactly as the interactive wizard
 * would leave it (off, unconfigured) — configure it later by hand if you want it.
 */

/** Trim, and turn "" into undefined so an accidentally-empty env var reads as unset. */
function env(name: string): string | undefined {
  const trimmed = process.env[name]?.trim();
  return trimmed ? trimmed : undefined;
}

function issuesOf(err: { issues: Array<{ path: (string | number)[]; message: string }> }): string {
  return err.issues.map((i) => `${i.path.join('.') || '(value)'}: ${i.message}`).join('; ');
}

/** `{name}[]` list → throws naming the offending env var and what IS available, if `value` isn't in it. */
function requireIn(list: Array<{ name: string }>, value: string, envVar: string): void {
  if (!list.some((x) => x.name === value)) {
    const available = list.map((x) => x.name).join(', ') || '(none visible to this token)';
    throw new Error(`${envVar}="${value}" was not found on the cluster. Available: ${available}.`);
  }
}

export interface AutoSetupLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

const consoleLogger: AutoSetupLogger = {
  info: (msg) => console.log(`[auto-setup] ${msg}`),
  warn: (msg) => console.warn(`[auto-setup] warning: ${msg}`),
};

/** Returns `false` when auto-setup isn't opted into or has already run — never an error. */
export async function runAutoSetup(log: AutoSetupLogger = consoleLogger): Promise<boolean> {
  if (env('PROXMATE_AUTO_SETUP') !== 'true') return false; // the default, interactive-wizard path

  if (await isSetupComplete()) {
    log.info('setup is already complete — nothing to do.');
    return false;
  }

  const admin = AdminSchema.safeParse({
    email: env('ADMIN_EMAIL'),
    password: env('ADMIN_PASSWORD'),
    displayName: env('ADMIN_DISPLAY_NAME') ?? 'Administrator',
  });
  if (!admin.success) throw new Error(`ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_DISPLAY_NAME: ${issuesOf(admin.error)}`);

  const proxmox = ProxmoxConfigSchema.safeParse({
    host: env('PROXMOX_HOST'),
    tokenId: env('PROXMOX_TOKEN_ID'),
    tokenSecret: env('PROXMOX_TOKEN_SECRET'),
    // Deliberately asymmetric: only the exact string "false" turns verification off.
    // Unset, or any typo/garbage value, defaults to the STRICTER side (verify ON) —
    // the safe direction to fail toward, matching "ca cert file" verification elsewhere.
    verifySsl: env('PROXMOX_VERIFY_SSL') !== 'false',
  });
  if (!proxmox.success) throw new Error(`PROXMOX_HOST / PROXMOX_TOKEN_ID / PROXMOX_TOKEN_SECRET: ${issuesOf(proxmox.error)}`);

  // Optional backupStorage: the interactive `/api/setup/defaults` route doesn't expose
  // it (OOBE predates that setting), but the underlying service always has — no reason
  // this programmatic path should be more limited than the ongoing admin settings are.
  const defaults = DefaultsSchema.extend({ backupStorage: z.string().min(1).optional() }).safeParse({
    storage: env('DEFAULT_STORAGE'),
    bridge: env('DEFAULT_BRIDGE'),
    isoStorage: env('DEFAULT_ISO_STORAGE'),
    backupStorage: env('DEFAULT_BACKUP_STORAGE'),
  });
  if (!defaults.success) throw new Error(`DEFAULT_STORAGE / DEFAULT_BRIDGE / DEFAULT_ISO_STORAGE: ${issuesOf(defaults.error)}`);

  const existingAdmin = await findAdmin();
  if (existingAdmin) {
    if (existingAdmin.email !== admin.data.email) {
      throw new Error(
        `An admin account already exists (${existingAdmin.email}), which does not match ` +
          `ADMIN_EMAIL (${admin.data.email}). Refusing to proceed as though it were the ` +
          "account this run was about to create — that account's password is unknown here. " +
          'Either set ADMIN_EMAIL to match it, or delete that account first.',
      );
    }
    log.info(`admin account ${existingAdmin.email} already exists — a previous run got this far; reusing it.`);
  } else {
    log.info(`creating admin account ${admin.data.email}…`);
    await createAdmin(admin.data);
  }

  log.info(`saving the Proxmox connection (${proxmox.data.host})…`);
  await saveProxmoxConfig(proxmox.data);

  log.info('testing the Proxmox connection (same check as the OOBE "Test" button)…');
  const result = await testProxmoxConnection();
  for (const warning of result.warnings) log.warn(warning);
  log.info(
    `connected to Proxmox VE ${result.version} — ${result.nodeCount} node(s), ` +
      `${result.vmCount} guest(s) visible, ${result.storageCount} storage(s) visible.`,
  );

  log.info('checking the default storage, bridge and ISO storage exist on the cluster…');
  const resources = await getProxmoxResources();
  requireIn(resources.storages, defaults.data.storage, 'DEFAULT_STORAGE');
  requireIn(resources.bridges, defaults.data.bridge, 'DEFAULT_BRIDGE');
  requireIn(resources.isoStorages, defaults.data.isoStorage, 'DEFAULT_ISO_STORAGE');
  if (defaults.data.backupStorage) requireIn(resources.backupStorages, defaults.data.backupStorage, 'DEFAULT_BACKUP_STORAGE');

  log.info('saving the default VM settings…');
  await saveDefaults(defaults.data);

  await autoConfigureSso(log);

  log.info('finalizing setup…');
  await completeSetup();

  log.info('done — setup is complete.');
  return true;
}

/**
 * Configure SSO from `SSO_*` env vars, or do nothing when neither of the two REQUIRED
 * ones is set — a human can still configure it later through the admin UI, exactly as
 * if auto-setup had never touched it. Validated with the SAME schema the admin UI's
 * save button uses, so a bad issuer URL or a too-large quota is rejected identically.
 */
async function autoConfigureSso(log: AutoSetupLogger): Promise<void> {
  const issuer = env('SSO_ISSUER');
  const clientId = env('SSO_CLIENT_ID');
  if (!issuer && !clientId) return; // not opted in — leave SSO exactly as the wizard would

  // Unlike an ONGOING update (where a blank secret means "keep the current one"), a
  // FIRST-time configure with none stored yet would just leave SSO broken the moment
  // someone tries to use it — so this path requires one, even though SsoSchema itself
  // allows it blank.
  const clientSecret = env('SSO_CLIENT_SECRET');
  if (!clientSecret) {
    throw new Error('SSO_ISSUER / SSO_CLIENT_ID were set but SSO_CLIENT_SECRET was not — required to configure SSO for the first time.');
  }

  const sso = SsoSchema.safeParse({
    // Configuring it at all is taken as wanting it ON — only the literal string
    // "false" keeps it saved-but-disabled (e.g. to stage it before flipping it on).
    enabled: env('SSO_ENABLED') !== 'false',
    issuer,
    clientId,
    clientSecret,
    scopes: env('SSO_SCOPES'),
    groupsClaim: env('SSO_GROUPS_CLAIM'),
    adminGroup: env('SSO_ADMIN_GROUP'),
    // Deliberately NOT defaulted to true: auto-provisioning brand-new accounts is a
    // real widening of who can reach this ProxMate, so it stays off (ProxMate's own
    // base default) unless explicitly asked for — same asymmetric-default reasoning as
    // PROXMOX_VERIFY_SSL, mirrored the other direction since here "off" is the safe side.
    allowSignup: env('SSO_ALLOW_SIGNUP') === 'true',
    buttonLabel: env('SSO_BUTTON_LABEL'),
    accessRoles: env('SSO_ACCESS_ROLES'),
    newUserCpu: envInt('SSO_NEW_USER_CPU'),
    newUserRam: envInt('SSO_NEW_USER_RAM'),
    newUserStorage: envInt('SSO_NEW_USER_STORAGE'),
  });
  if (!sso.success) throw new Error(`SSO_*: ${issuesOf(sso.error)}`);

  log.info(`configuring SSO (issuer ${sso.data.issuer}, client ${sso.data.clientId})…`);
  await saveSsoConfig(sso.data);
}

/**
 * `env()` plus a number parse. `undefined` only for an UNSET var — a var that is set
 * but not a number is passed through as `NaN` rather than silently dropped, so zod's
 * `z.number()` rejects it with a named error instead of the bad value disappearing.
 */
function envInt(name: string): number | undefined {
  const raw = env(name);
  return raw === undefined ? undefined : Number(raw);
}

// ─── CLI entrypoint ─────────────────────────────────────────────
// Only runs when this file is executed directly (`node dist/scripts/auto-setup.js`),
// not when a test imports `runAutoSetup` from it. Resolved through path.resolve/
// fileURLToPath (not a raw string/URL comparison) so it matches whether invoked with a
// relative or absolute path.
const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  runAutoSetup().catch((err: unknown) => {
    console.error(`[auto-setup] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  });
}
