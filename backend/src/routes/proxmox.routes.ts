import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { enforceMfaSetup } from '../middleware/mfa.js';
import { getNodes, getIsos, getStorages, pveMessage } from '../services/proxmox.service.js';
import { getProxmoxResources } from '../services/setup.service.js';
import { getScopeOptions, ScopeError } from '../services/pve-scope.service.js';
import type { AuthRequest } from '../types/index.js';

const router = Router();

router.use(requireAuth);
// Block cluster introspection until a required second factor is enrolled.
router.use(enforceMfaSetup);

// ─── GET /api/proxmox/resources ───────────────────────────────
// Storages, bridges, and ISO-capable storages (for VM create + settings).

router.get('/resources', async (_req: Request, res: Response) => {
  try {
    const resources = await getProxmoxResources();
    res.json(resources);
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

// ─── GET /api/proxmox/scope ───────────────────────────────────
// What THIS user may pick in the deploy wizard — the pools, storages, networks and
// templates Proxmox grants their identity. `{ scoped: false }` for everyone the
// feature doesn't apply to (admins, local accounts, scoping off): they keep the
// classic wizard. Advisory only — the deploy routes re-check every choice.

router.get('/scope', async (req: Request, res: Response) => {
  try {
    const options = await getScopeOptions((req as AuthRequest).user);
    res.json(options ?? { scoped: false });
  } catch (err) {
    if (err instanceof ScopeError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    res.status(502).json({ error: pveMessage(err) });
  }
});

// ─── GET /api/proxmox/nodes ───────────────────────────────────

router.get('/nodes', async (_req: Request, res: Response) => {
  try {
    const nodes = await getNodes();
    res.json(
      nodes.map((n) => ({
        node: n.node,
        status: n.status,
        maxcpu: n.maxcpu,
        maxmem: n.maxmem,
        cpu: n.cpu,
        mem: n.mem,
      })),
    );
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

// ─── GET /api/proxmox/isos ────────────────────────────────────

router.get('/isos', async (_req: Request, res: Response) => {
  try {
    const isos = await getIsos();
    res.json(isos);
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

// ─── GET /api/proxmox/storage ─────────────────────────────────

router.get('/storage', async (_req: Request, res: Response) => {
  try {
    const storages = await getStorages();
    res.json(storages.map((s) => ({ name: s.storage, type: s.type, content: s.content })));
  } catch (err) {
    res.status(502).json({ error: pveMessage(err) });
  }
});

export default router;
