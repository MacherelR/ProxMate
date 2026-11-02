import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * `POST /api/vms` is the ONLY route that creates a guest from an ISO (templates go
 * through `POST /api/templates/deploy`, containers through `POST /api/vms/containers`
 * — neither is restricted by `iso_admin_only`, since the whole point is to leave
 * templates/containers open while gating ISO installs specifically). The decision logic
 * itself is unit-tested in iso-admin-only.test.ts; what no unit test can catch is this
 * route losing the call to it in a future refactor, which would silently turn the
 * setting into a UI-only hide with no real enforcement. Source-scan, same pattern as
 * pve-scope-gate.test.ts.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

function handlerOf(source: string, verb: string, path: string): string {
  const start = source.indexOf(`router.${verb}('${path}'`);
  if (start === -1) throw new Error(`route ${verb.toUpperCase()} ${path} not found`);
  const rest = source.slice(start + 1);
  const next = rest.search(/\nrouter\.(get|post|put|patch|delete)\(/);
  return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next);
}

const vmRoutes = read('../src/routes/vm.routes.ts');
const templateRoutes = read('../src/routes/template.routes.ts');

describe('ISO installs are gated at the one route that actually creates one', () => {
  it('POST /api/vms calls assertMayInstallFromIso before creating anything', () => {
    const handler = handlerOf(vmRoutes, 'post', '/');
    expect(handler).toContain('assertMayInstallFromIso(');
    expect(handler.indexOf('assertMayInstallFromIso(')).toBeLessThan(handler.indexOf('createVm('));
  });

  it('is checked with the ACTING user, not the guest owner (an admin deploying for a tenant is an admin action)', () => {
    const handler = handlerOf(vmRoutes, 'post', '/');
    expect(handler).toMatch(/assertMayInstallFromIso\(actor\)/);
  });

  it('POST /api/vms/containers (LXC) is NOT gated — only raw ISO installs are restricted', () => {
    expect(handlerOf(vmRoutes, 'post', '/containers')).not.toContain('assertMayInstallFromIso(');
  });

  it('POST /api/templates/deploy is NOT gated — templates stay available to everyone', () => {
    expect(handlerOf(templateRoutes, 'post', '/deploy')).not.toContain('assertMayInstallFromIso(');
  });
});
