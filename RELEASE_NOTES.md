## Security

- Cloud-init login passwords are no longer given to cloud-init. The crypt hash was written to the seed drive (`/dev/sr0`) and to the guest's `/var/lib/cloud` cache, both readable by the VM's own user for its lifetime. The password is now held encrypted until first boot, applied in-guest via the QEMU guest agent, then discarded. `cipassword` was removed from `setCloudInitConfig`'s signature.
- Axios client error objects are sanitized before logging. An axios error carries the request that produced it, including the `Authorization` header, so `config` and `request` are now replaced with sanitized copies at the client, on both the error and its response, keeping only method, url, baseURL, timeout and a redacted header.
- Guests can be placed on a per-tenant VLAN. The per-VM firewall operates at L3 and above and could not prevent ARP poisoning, rogue DHCP, or IPv6 router advertisement between tenants sharing a bridge. Verified on a live cluster: cross-VLAN blocked at ARP resolution, same-VLAN control passes.
- Outbound DHCP server replies (`udp dport 68`) and IPv6 router advertisements are dropped per guest. Clients still obtain leases.
- The compute-access window is enforced on passkey and SSO login, not only password. All three paths share one refusal; a source-scan test fails if a new login path skips it.
- `testProxmoxConnection` rejects a token that authenticates but holds no permissions. A `--privsep 1` token answers `/version` and returns every node, so the previous check reported success. It now reads `/access/permissions` and names the missing privilege and the command that grants it.

## Fixes

- The default network bridge and default storage are applied to guests deployed from a template. A template deploy is a clone, so both were inherited from the template and the configured defaults never applied. Storage additionally reverted the migratability fix from 0.9.0 — new guests kept landing on node-local storage. Applied on deploy, duplicate and restore, preserving MAC, firewall flag and VLAN tag.
- A linked-clone template that is not on the configured storage is now full-cloned. Proxmox cannot place a linked clone on a different storage; the link is dropped rather than the setting, and the reason is logged.
- Cloud-image templates built by ProxMate now include `qemu-guest-agent`. The importer converted the downloaded image to a template without booting it, so no package could be installed — and since login passwords are applied through the agent, those templates could not serve a password-only deploy. The build boots the image once, installs and verifies the agent, clears the cloud-init cache and build logs, then converts. A build without network access still produces a usable template, recorded as agentless and flagged in Template Store.
- `deploy.agent_missing` notification when a deploy's guest agent never responds. Previously the only signals were a log line and a tenant unable to log in.
- `GET /api/admin/storage-pinning` lists guests that cannot migrate, using Proxmox's own migration preflight.
- The `/setup` wizard no longer gets stuck on step 2 after a fresh install on a browser that previously completed setup on the same domain. The locally cached `user` (localStorage, for instant UI) was trusted for routing without confirming the session cookie still verifies — a reset backend (new database, new `jwt_secret`) left the wizard reading a stale "I'm logged in" from the browser and skipping straight past admin creation, with no admin actually in the new database. It now re-checks `/auth/me` before trusting that cache.
- The "Default bridge" picker (OOBE step 3 and `GET /api/setup/proxmox/resources`) now also lists SDN VNets, not only classic Linux bridges. A cluster whose guest networking is entirely SDN-based had nothing to pick at all — verified live against a real cluster: three real VNets visible to the token, "Available: (none visible to this token)" shown anyway, because the lookup only ever asked one node for `type=bridge` interfaces. A VNet is exactly as valid a `net0: bridge=<name>` value as a classic bridge, so the two lists are merged (deduped by name); a cluster with no SDN configured at all is unaffected.
- The install-ISO picker no longer shows other guests' own cdrom volumes alongside real install media. Proxmox's `content=iso` filter also returns guest-owned volumes on the ISO storage — most commonly another VM's cloud-init seed, which is itself genuinely an ISO9660 image. Verified live on a shared ISO storage: every other tenant's cloud-init seed appeared in the dropdown. Now filtered to the `<storage>:iso/<file>` shared-library path `createVm()` itself already relies on; anything under a guest's own vmid-prefixed path is excluded.

## Only admins may install from ISO

New admin setting (Settings ▸ Proxmox, off by default): hides "Custom VM (install from ISO)" in the create wizard for non-admin users and refuses it on `POST /api/vms` too — a real restriction, not a hidden button. Templates and containers are unaffected, so an operator can steer tenants toward curated templates while keeping raw ISO installs (and the unattended-installer attack surface) admin-only. `GET /api/auth/me`'s new `isoInstallAllowed` drives the wizard; `assertMayInstallFromIso` is the one enforcement point, asserted by a source-scan test.

## One instance per environment

ProxMate can now be pinned to a single environment. Isolation comes from two layers: the Proxmox account the instance runs with (its ACLs are the boundary — Proxmox refuses anything outside them), and a role claim that decides who may sign in. See `DEPLOYMENT.md` §9.4.

- **Access roles** (Settings ▸ Access): a non-admin SSO user needs at least one of the listed roles in the groups/roles claim, or sign-in is refused before any account is linked or created. Admins are never locked out. Blank keeps the old behaviour.
- **Users choose pool, network and storage** (Settings ▸ Proxmox, off by default): non-admin users pick where each machine goes and are offered only what the Proxmox account can use. Every choice is checked again on the API against the account's effective privileges (`GET /access/permissions?path=…`) and refused, not guessed, when a check fails. A source-scan test fails if a guest-creating route stops calling the check.
- New guests record their pool and network; duplicates stay in the same pool and network. Rebuild and restore-from-upload are refused while placement is on, because both re-provision from server defaults.
- Placed machines skip ProxMate's own tenant firewall and VLAN tag; the granted SDN zone is the boundary.
- Auto-created SSO users can be given a default quota (previously always zero).

## Automatic first-time setup

`PROXMATE_AUTO_SETUP=true` (+ `ADMIN_EMAIL`/`ADMIN_PASSWORD`, `PROXMOX_HOST`/`PROXMOX_TOKEN_ID`/`PROXMOX_TOKEN_SECRET`, `DEFAULT_STORAGE`/`DEFAULT_BRIDGE`/`DEFAULT_ISO_STORAGE`) walks the `/setup` wizard from environment variables — for scripted deployments (Ansible, Terraform, CI) that shouldn't need a human to click through it. See `DEPLOYMENT.md` §7.1a.

- Same validation and the same `/access/permissions`-based connection check as the interactive wizard's "Test" button — nothing about this path is less strict.
- Idempotent and resumable: runs on every boot but is a permanent no-op once setup completes, and picks up correctly after a crash partway through (e.g. admin created, Proxmox not yet saved) instead of failing on "Admin account already exists".
- Fails closed: a bad token or a storage/bridge/ISO-storage name that doesn't exist on the live cluster exits non-zero instead of completing setup against a broken configuration.
- Optionally also configures SSO as part of the same run: `SSO_ISSUER` + `SSO_CLIENT_ID` (+ `SSO_CLIENT_SECRET`, required alongside them even though the admin UI allows it blank on a later update) opt in, saved with the exact function the admin UI's "Save SSO settings" button calls. `SsoSchema` moved into `sso.service.ts` (same refactor as `AdminSchema`/`ProxmoxConfigSchema`/`DefaultsSchema`) so the HTTP route and this script share one definition.

## Modules

Self-hosted installs can add API routes and database tables without patching `app.ts`. A module is a directory exporting an Express router, enabled by name in `PROXMATE_MODULES` and served under `/api/ext/<name>`.

Modules supply a router rather than the application, so they cannot reorder middleware or replace the error handler. All modules mount under one reserved path segment and cannot shadow a built-in route. `requireAuth` is applied by default; opting out is logged by name at boot. Modules may own a Prisma schema and migrations, applied after core migrations.

With no module configured no import is attempted and no route is added. See `backend/src/modules/README.md`.

## Upgrading

No configuration changes required. Run the database migration (`20260921120000_pve_scope`, adds three nullable columns).

- Rebuild cloud-image templates to pick up the guest agent. Password-only deploys from templates built before this release produce machines their owner cannot log into. Template Store flags them.
- Guests created before this release keep their existing storage. `GET /api/admin/storage-pinning` lists any that cannot migrate as a result.
