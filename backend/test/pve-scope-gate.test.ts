import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Every route that puts a guest on the cluster must go through Proxmox scoping.
 *
 * The scope logic itself is unit-tested in pve-scope.test.ts. What no unit test can
 * catch is the NEXT creation path (or a refactor of an existing one) that never calls
 * it — the guest would then be placed with the server-default storage/bridge and no
 * pool, by an account that is supposed to be confined. So, as with the login gates,
 * this asserts at the source level that each creation route calls the gate.
 *
 * If you add a route that creates, clones, restores or re-provisions a guest, add it
 * to CREATION_ROUTES with the gate it uses — or, if it genuinely needs none, say why
 * in EXEMPT. A failing count below means the file gained a route: read the routes list
 * before adjusting anything.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** The text of one route handler: from its `router.<verb>('<path>'` line to the next route. */
function handlerOf(source: string, verb: string, path: string): string {
  const start = source.indexOf(`router.${verb}('${path}'`);
  if (start === -1) throw new Error(`route ${verb.toUpperCase()} ${path} not found`);
  const rest = source.slice(start + 1);
  const next = rest.search(/\nrouter\.(get|post|put|patch|delete)\(/);
  return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next);
}

const vmRoutes = read('../src/routes/vm.routes.ts');
const templateRoutes = read('../src/routes/template.routes.ts');

const CREATION_ROUTES: Array<{ file: string; source: string; verb: string; path: string; gate: string }> = [
  { file: 'vm.routes', source: vmRoutes, verb: 'post', path: '/', gate: 'resolvePlacement(' },
  { file: 'vm.routes', source: vmRoutes, verb: 'post', path: '/containers', gate: 'resolvePlacement(' },
  { file: 'template.routes', source: templateRoutes, verb: 'post', path: '/deploy', gate: 'resolvePlacement(' },
  { file: 'vm.routes', source: vmRoutes, verb: 'post', path: '/:id/duplicate', gate: 'assertMayDuplicate(' },
  { file: 'vm.routes', source: vmRoutes, verb: 'post', path: '/:id/rebuild', gate: 'assertNotScoped(' },
  { file: 'vm.routes', source: vmRoutes, verb: 'post', path: '/restore-upload', gate: 'assertNotScoped(' },
];

describe('every guest-creating route is behind Proxmox scoping', () => {
  it.each(CREATION_ROUTES)('$verb $path in $file calls $gate', ({ source, verb, path, gate }) => {
    expect(handlerOf(source, verb, path)).toContain(gate);
  });

  it('runs the gate BEFORE anything is created, not after', () => {
    const create = handlerOf(vmRoutes, 'post', '/');
    expect(create.indexOf('resolvePlacement(')).toBeGreaterThan(-1);
    expect(create.indexOf('resolvePlacement(')).toBeLessThan(create.indexOf('createVm('));

    const container = handlerOf(vmRoutes, 'post', '/containers');
    expect(container.indexOf('resolvePlacement(')).toBeLessThan(container.indexOf('createContainer('));

    const deploy = handlerOf(templateRoutes, 'post', '/deploy');
    expect(deploy.indexOf('resolvePlacement(')).toBeLessThan(deploy.indexOf('deployFromTemplate('));

    // Restore-upload must refuse before the (large) upload is even accepted.
    const restore = handlerOf(vmRoutes, 'post', '/restore-upload');
    expect(restore.indexOf('assertNotScoped(')).toBeLessThan(restore.indexOf('restoreUploadMulter.single'));
  });

  it('passes the ACTING user to the gate, not the guest owner', () => {
    // An admin deploying into a scoped user's account is exercising the ADMIN's rights;
    // gating on the owner would wrongly confine the admin, and gating on nothing would
    // let a scoped user launder a deploy through `forUserId`.
    for (const src of [handlerOf(vmRoutes, 'post', '/'), handlerOf(vmRoutes, 'post', '/containers'), handlerOf(templateRoutes, 'post', '/deploy')]) {
      expect(src).toMatch(/resolvePlacement\(\s*actor,/);
    }
  });

  it('is exhaustive: no other route in these files creates a guest', () => {
    // Every service call that provisions a guest, and where it may be called from.
    const creators = ['createVm(', 'createContainer(', 'deployFromTemplate(', 'duplicateVm(', 'rebuildVm(', 'restoreFromUpload('];
    const routes = [...vmRoutes.matchAll(/\nrouter\.(get|post|put|patch|delete)\('([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`);
    const offenders = routes.filter((r) => {
      const [verb, path] = r.split(' ') as [string, string];
      const body = handlerOf(vmRoutes, verb, path);
      const calls = creators.some((c) => body.includes(c));
      const gated = CREATION_ROUTES.some((g) => g.source === vmRoutes && g.verb === verb && g.path === path);
      return calls && !gated;
    });
    expect(offenders).toEqual([]);
  });
});
