/**
 * Environment placement — users choose WHERE a guest goes, from what ProxMate's own
 * Proxmox account is allowed to do.
 *
 * ProxMate is deployed once per environment (a gamenet such as delfino or stambecco, or
 * one exercise of it) and talks to Proxmox with ONE account whose ACLs are scoped to
 * that environment: a resource pool, an SDN zone, a template pool. That account is the
 * isolation boundary — Proxmox itself refuses anything outside it. Who may use this
 * ProxMate at all is decided at login, by a role claim (see sso.service.ts).
 *
 * What this module adds on top is the part Proxmox can't do for a UI: with the switch
 * on, a non-admin user must PICK a pool, a network (SDN VNet) and a storage for each
 * guest, and is offered only the ones the account can actually use. Every choice is
 * checked before anything is created, so a bad one gets a clear refusal here instead of
 * a half-built guest and an opaque Proxmox error.
 *
 * THE PRINCIPLE: Proxmox decides, ProxMate asks. Effective privileges come from
 * `GET /access/permissions?path=…` for ProxMate's own account (ACL inheritance,
 * `propagate` and pool expansion resolved by Proxmox); nothing here re-implements them.
 * Asking about oneself needs no special privilege.
 *
 * FAIL CLOSED, everywhere: a failed lookup, a malformed path or a missing privilege all
 * refuse the deploy. Nothing here ever falls back to server-default placement for a
 * confined user.
 *
 * WHO IS CONFINED: every non-admin account, while the admin has the switch on. Admins
 * are exempt (they own the instance, and one who mis-set the switch could not fix it);
 * they still cannot exceed the Proxmox account's own rights.
 */
import type { AxiosInstance } from 'axios';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { getConfig } from './config.service.js';
import { CreateOptionError } from './vm.service.js';
import * as pve from './proxmox.service.js';

// ─── Privileges each part of a placement needs ────────────────
// These are the privileges Proxmox itself checks when a guest is created / cloned, so
// "we said yes, Proxmox said no" cannot happen for a well-formed placement.

export const PRIV_POOL = 'VM.Allocate'; // create/clone into /pool/<pool>
export const PRIV_STORAGE = 'Datastore.AllocateSpace'; // allocate the disk on /storage/<id>
export const PRIV_NETWORK = 'SDN.Use'; // attach a NIC to /sdn/zones/<zone>/<vnet>
export const PRIV_TEMPLATE = 'VM.Clone'; // clone /vms/<template>
export const PRIV_MEDIA = 'Datastore.Audit'; // use an ISO / LXC template from /storage/<id>

/** A classic (non-SDN) bridge is governed under this pseudo-zone. */
const LOCAL_ZONE = 'localnetwork';

// ─── Errors ───────────────────────────────────────────────────

/** A refusal the routes surface directly (rides the existing CreateOptionError handlers). */
export class ScopeError extends CreateOptionError {
  constructor(message: string, status = 403) {
    super(message, status);
    this.name = 'ScopeError';
  }
}

// ─── Who is confined ──────────────────────────────────────────

/** The whole switch, read straight from config. */
export async function isPlacementEnabled(): Promise<boolean> {
  return (await getConfig('pve_user_placement')) === 'true';
}

/** True when this actor must choose a placement the Proxmox account can honour. */
export async function isScoped(actor: { role: string }): Promise<boolean> {
  if (actor.role === 'admin') return false;
  return isPlacementEnabled();
}

// ─── Path building (input → Proxmox ACL path) ─────────────────
// Every path below is assembled from user-supplied names, so each segment is checked
// against a strict pattern first: no `..`, no empty segments, no `/` smuggled into a
// storage or VNet name. A bad name is a 400, never a lookup.

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,31}$/;
const MAX_POOL_DEPTH = 4;

function bad(what: string): never {
  throw new ScopeError(`Invalid ${what}.`, 400);
}

export function poolPath(pool: string): string {
  const parts = pool.split('/');
  if (parts.length > MAX_POOL_DEPTH || !parts.every((p) => SEGMENT.test(p) && p !== '..')) bad('pool');
  return `/pool/${parts.join('/')}`;
}

export function storagePath(storage: string): string {
  if (!NAME.test(storage)) bad('storage');
  return `/storage/${storage}`;
}

export function networkPath(zone: string, vnet: string): string {
  if (!NAME.test(zone)) bad('network zone');
  if (!NAME.test(vnet)) bad('network');
  return `/sdn/zones/${zone}/${vnet}`;
}

export function templatePath(vmid: number): string {
  if (!Number.isInteger(vmid) || vmid < 1) bad('template');
  return `/vms/${vmid}`;
}

// ─── Asking Proxmox (cached briefly) ──────────────────────────

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { at: number; privs: Record<string, number> }>();

/** Forget every cached answer — tests, and whenever the Proxmox account or settings change. */
export function resetScopeCache(): void {
  cache.clear();
}

/** Only a fresh-enough answer is reused; a changed ACL is felt within CACHE_TTL_MS. */
async function privilegesAt(path: string, client: AxiosInstance): Promise<Record<string, number>> {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.privs;

  let perms: pve.PvePermissions;
  try {
    perms = await pve.getEffectivePermissions(client, path);
  } catch (err) {
    throw new ScopeError(`Could not check what this environment may deploy: ${pve.pveMessage(err)}`, 502);
  }
  // EXACT key only. Merging every entry would turn a Proxmox that ignores `path` and
  // returns the whole tree into "the account holds every privilege anywhere".
  const privs = perms[path] ?? {};
  cache.set(path, { at: Date.now(), privs });
  return privs;
}

interface Need {
  path: string;
  priv: string;
  /** Human wording for the refusal, e.g. "deploy into pool delfino/delfino-02". */
  action: string;
}

/** Every need must hold; otherwise ONE error names everything that's missing. */
async function requireAll(needs: Need[], client: AxiosInstance): Promise<void> {
  const results = await Promise.all(needs.map((n) => privilegesAt(n.path, client)));
  const missing = needs.filter((n, i) => !results[i]![n.priv]);
  if (missing.length > 0) {
    throw new ScopeError(
      `This environment's Proxmox account isn't allowed to ${missing
        .map((m) => `${m.action} (${m.priv} on ${m.path})`)
        .join('; ')}.`,
    );
  }
}

// ─── Placement (the enforcement point) ────────────────────────

/**
 * The placement fields of a create/deploy request. Every field is optional HERE so a
 * missing one gets the friendly "choose a pool, a network and a storage" answer from
 * `resolvePlacement` instead of a schema error; the values themselves are only checked
 * for shape (the strict per-segment patterns run when the ACL paths are built).
 */
export const PlacementSchema = z.object({
  pool: z.string().min(1).max(200).optional(),
  bridge: z.string().min(1).max(64).optional(),
  storage: z.string().min(1).max(64).optional(),
});

export type PlacementRequest = z.infer<typeof PlacementSchema>;

export interface Placement {
  pool: string;
  bridge: string;
  storage: string;
}

/** What the guest is built from — each source needs read access to where it lives. */
export type PlacementSource =
  | { kind: 'template'; vmid: number }
  | { kind: 'iso'; isoStorage: string }
  | { kind: 'lxc'; templateVolid: string };

/** The VNet → zone map (a VNet is what a guest sees as a bridge). */
async function zoneOf(bridge: string, client: AxiosInstance): Promise<string> {
  const vnets = await pve.getSdnVnets(client).catch(() => []);
  return vnets.find((v) => v.vnet === bridge)?.zone ?? LOCAL_ZONE;
}

/**
 * Decide where a deploy may go. Returns the vetted placement for a confined actor, or
 * `undefined` for an unconfined one — and refuses outright when a confined actor hasn't
 * chosen a placement or the Proxmox account can't honour any part of it.
 *
 * EVERY route that creates a guest must call this with the ACTING user: the routes
 * are asserted by `pve-scope-gate.test.ts`, the same guard-by-source-scan the login
 * gates use, so a new creation path can't quietly skip it.
 */
export async function resolvePlacement(
  actor: { id: string; role: string },
  req: PlacementRequest,
  source: PlacementSource,
  client?: AxiosInstance,
): Promise<Placement | undefined> {
  if (!(await isScoped(actor))) {
    if (req.pool || req.bridge || req.storage) {
      throw new ScopeError('Choosing a pool, network or storage is not enabled on this server.', 400);
    }
    return undefined;
  }
  if (!req.pool || !req.bridge || !req.storage) {
    throw new ScopeError('Choose a pool, a network and a storage for this machine.', 400);
  }

  const c = client ?? (await pve.getClient());
  const needs: Need[] = [
    { path: poolPath(req.pool), priv: PRIV_POOL, action: `deploy into pool ${req.pool}` },
    { path: storagePath(req.storage), priv: PRIV_STORAGE, action: `use storage ${req.storage}` },
    {
      path: networkPath(await zoneOf(req.bridge, c), req.bridge),
      priv: PRIV_NETWORK,
      action: `use network ${req.bridge}`,
    },
  ];
  if (source.kind === 'template') {
    needs.push({ path: templatePath(source.vmid), priv: PRIV_TEMPLATE, action: 'clone this template' });
  } else if (source.kind === 'iso') {
    needs.push({ path: storagePath(source.isoStorage), priv: PRIV_MEDIA, action: `install from ${source.isoStorage}` });
  } else {
    const store = source.templateVolid.split(':')[0] ?? '';
    needs.push({ path: storagePath(store), priv: PRIV_MEDIA, action: `use templates from ${store}` });
  }

  await requireAll(needs, c);
  return { pool: req.pool, bridge: req.bridge, storage: req.storage };
}

/**
 * A confined actor duplicating a guest: the copy lands in the SOURCE's pool and on its
 * bridge (the only places it can legitimately be), so that placement is re-vetted now.
 * Returns false for an unconfined actor (caller proceeds classically).
 */
export async function assertMayDuplicate(
  actor: { id: string; role: string },
  vm: { pool: string | null; bridge: string | null },
  client?: AxiosInstance,
): Promise<boolean> {
  if (!(await isScoped(actor))) return false;
  if (!vm.pool || !vm.bridge) {
    throw new ScopeError('This machine was not deployed into a pool, so it cannot be duplicated here.');
  }
  const c = client ?? (await pve.getClient());
  await requireAll(
    [
      { path: poolPath(vm.pool), priv: PRIV_POOL, action: `deploy into pool ${vm.pool}` },
      {
        path: networkPath(await zoneOf(vm.bridge, c), vm.bridge),
        priv: PRIV_NETWORK,
        action: `use network ${vm.bridge}`,
      },
    ],
    c,
  );
  return true;
}

/** For paths that build guests from server defaults (rebuild, restore-upload): closed to confined users. */
export async function assertNotScoped(actor: { id: string; role: string }, what: string): Promise<void> {
  if (await isScoped(actor)) {
    throw new ScopeError(`${what} isn't available while placement is enforced on this server yet.`);
  }
}

// ─── What the wizard may offer ────────────────────────────────

export interface ScopeOptions {
  scoped: true;
  pools: { id: string; comment?: string }[];
  storages: { name: string; type: string; content?: string }[];
  networks: { id: string; zone: string }[];
  /** ProxMate template ids the account may clone. */
  templateIds: string[];
  /** May guests be installed from ISOs on the configured ISO storage? */
  isoAllowed: boolean;
  /** May containers be created from the cluster's OS templates? */
  lxcAllowed: boolean;
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Cheap pre-filter for LARGE candidate sets (every pool, every VNet on the cluster):
 * does the account's permission tree hold `priv` on the path itself or any ancestor?
 * Only ever used to skip the per-path confirmation for candidates that cannot qualify —
 * a candidate that passes is still confirmed with an exact lookup, and enforcement
 * (`resolvePlacement`) never uses it.
 */
export function treeMayHold(tree: pve.PvePermissions, path: string, priv: string): boolean {
  return Object.entries(tree).some(
    ([key, privs]) => privs?.[priv] && (key === '/' || path === key || path.startsWith(`${key}/`)),
  );
}

/** What this actor may pick in the deploy wizard; null when placement isn't enforced for them. */
export async function getScopeOptions(
  actor: { id: string; role: string },
  client?: AxiosInstance,
): Promise<ScopeOptions | null> {
  if (!(await isScoped(actor))) return null;

  const c = client ?? (await pve.getClient());
  // One call for the whole tree, purely to prune the big candidate lists.
  const tree = await pve.getEffectivePermissions(c).catch((err) => {
    throw new ScopeError(`Could not check what this environment may deploy: ${pve.pveMessage(err)}`, 502);
  });

  const holds = async (path: string, priv: string) => !!(await privilegesAt(path, c))[priv];
  // A cluster object whose name Proxmox allows but our strict path check rejects is
  // simply not offered — it must not take the whole listing down with it.
  const pathOrNull = <T>(build: (t: T) => string, t: T): string | null => {
    try {
      return build(t);
    } catch {
      return null;
    }
  };
  const keep = async <T>(items: T[], path: (t: T) => string, priv: string, prune: boolean) => {
    const withPath = items
      .map((item) => ({ item, p: pathOrNull(path, item) }))
      .filter((c): c is { item: T; p: string } => c.p !== null)
      .filter((c) => !prune || treeMayHold(tree, c.p, priv));
    const ok = await mapLimit(withPath, 8, (c) => holds(c.p, priv));
    return withPath.filter((_, i) => ok[i]).map((c) => c.item);
  };

  const [pools, storages, vnets, templates, isoStorage] = await Promise.all([
    pve.getPools(c),
    pve.getStorages(c),
    pve.getSdnVnets(c).catch(() => [] as pve.PveVnet[]),
    prisma.template.findMany({ where: { published: true } }),
    getConfig('iso_storage'),
  ]);

  const [allowedPools, allowedStorages, allowedNets, allowedTemplates] = await Promise.all([
    keep(pools, (p) => poolPath(p.poolid), PRIV_POOL, true),
    keep(
      storages.filter((s) => /\b(images|rootdir)\b/.test(s.content ?? '')),
      (s) => storagePath(s.storage),
      PRIV_STORAGE,
      false,
    ),
    keep(
      vnets.filter((v) => v.zone),
      (v) => networkPath(v.zone!, v.vnet),
      PRIV_NETWORK,
      true,
    ),
    keep(templates, (t) => templatePath(t.proxmoxVmId), PRIV_TEMPLATE, false),
  ]);

  return {
    scoped: true,
    pools: allowedPools.map((p) => ({ id: p.poolid, ...(p.comment ? { comment: p.comment } : {}) })),
    storages: allowedStorages.map((s) => ({ name: s.storage, type: s.type, ...(s.content ? { content: s.content } : {}) })),
    networks: allowedNets.map((v) => ({ id: v.vnet, zone: v.zone! })),
    templateIds: allowedTemplates.map((t) => t.id),
    isoAllowed: isoStorage ? await holds(storagePath(isoStorage), PRIV_MEDIA).catch(() => false) : false,
    // The OS-template storage varies per cluster and is only known per volume, so LXC is
    // offered whenever a placement exists; the volume itself is vetted at deploy time.
    lxcAllowed: allowedPools.length > 0 && allowedStorages.length > 0 && allowedNets.length > 0,
  };
}
