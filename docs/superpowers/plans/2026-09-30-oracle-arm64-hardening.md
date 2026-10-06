# Oracle ARM64 Distribution Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete safe native ARM64 installation/update around the multiarch release already merged upstream, without regressing AMD64.

**Architecture:** Keep the existing four-image publication pipeline and installer, adding one shared OCI-platform probe as the boundary between a tag's existence and its usability on this host. Run that probe before installation/update state changes, and add independent CI evidence for the published indexes and voice runtime. The Oracle VPS remains untouched until a versioned release and a separate deployment operation.

**Tech Stack:** Bash, Docker Buildx/Compose, jq, GitHub Actions, pnpm 9.15.9, Node 22, Vitest, shell tests.

**Spec:** `docs/superpowers/specs/2026-09-29-oracle-arm64-multiarch-design.md` (approved 2026-09-30; current-baseline addendum notes upstream PR #1938).

## Global Constraints

- Preserve both `linux/amd64` and `linux/arm64` for all four first-party images; no build or emulation on a new customer's VPS.
- Keep one immutable numeric version across app, worker, scheduler and voice-agent; preserve custom `WAHA_IMAGE`, especially Plus/licensed images.
- On ARM64 use `devlikeapro/waha:noweb-arm-2026.7.2` by default; on AMD64 retain `devlikeapro/waha:latest-2026.7.2`.
- Verify the pinned `self-hosted/v0.8.1` Supabase image set before single-server creates state; do not read, copy or print `.env` values.
- No manual file edits on a customer's VPS; preserve the legacy local-build recovery path for already installed unsupported hosts.
- Do not claim live SIP/WhatsApp calls, load capacity, or Oracle deployment without a real external acceptance run.

## Review Focus

1. A numeric tag exists but one image has no ARM64 manifest: Task 1's shell test must reject the exact image/platform before install.
2. Registry is unavailable, returns 403, or responds with invalid JSON: Task 1's shell test must fail closed without confusing it with “no ARM64”.
3. Operator chose a custom/Plus WAHA image: Task 3's shell test must preserve its value and reject an incompatible platform without replacing it.
4. An old `update.sh` runs before the new kit is checked out: Task 4's shell test and runbook must prevent database changes before the first safe upgrade.
5. Supabase ref adds an image, the voice image crashes, or SIP setup is half-written: Tasks 5, 2 and 6 must fail before the corresponding capability is declared supported.

---

### Task 1: Shared OCI manifest preflight

**Files:**
- Create: `hostgator-setup-kit/_manifestos.sh` (OCI probe only; safe to source without side effects)
- Modify: `hostgator-setup-kit/_common.sh` (`trio_publicado`, architecture normalization, actionable status)
- Test: `tests/shell/manifestos-plataforma.test.sh`
- Test: `tests/unit/listas-de-imagens-seguem-matriz.test.ts` (preserve four-image inventory contract)

**Interfaces:**
- Produces: `plataforma_oci_do_host <uname-value> -> linux/amd64|linux/arm64|nonzero`; `manifesto_tem_plataforma <image-ref> <linux/platform> -> 0|nonzero`; `preflight_imagens_crm <tag> <linux/platform> -> 0|nonzero` with failure reason, using `IMG_NS`.
- `trio_publicado <tag>` keeps its public signature but delegates platform checking; no mutation and no secret output.

- [ ] **Step 1: Write failing tests** for indexes with both platforms, AMD-only, ARM-only, a compatible single-platform manifest, malformed/empty registry response, unreachable/403 GHCR, and a tag where only three of four first-party images match. Use fake `docker buildx imagetools inspect` and fake `ghcr_status` rather than the live registry.
- [ ] **Step 2: Run** `bash tests/shell/manifestos-plataforma.test.sh`; expected failure shows the missing probe/incorrect platform acceptance.
- [ ] **Step 3: Implement the three functions** using `docker buildx imagetools inspect --raw` + `jq` over `.manifests[].platform` for indexes (ignore `unknown/unknown` attestations) and a verified platform query for a single manifest. Check GHCR HTTP status separately for missing/private/offline diagnoses. Do not weaken architecture detection for unsupported hosts.
- [ ] **Step 4: Run** the new shell test plus `pnpm vitest run tests/unit/listas-de-imagens-seguem-matriz.test.ts`; expected pass.
- [ ] **Step 5: Commit** the helper, integration and tests.

### Task 2: Publication and native voice runtime gate

**Files:**
- Modify: `.github/workflows/publish-image.yml` (checkout the probe, verify each assembled index and `stable` source; run voice boot in both native-runner matrix entries)
- Create: `scripts/sonda-voice-agent-na-imagem.sh` (bounded no-credential smoke with fake ARI/DB endpoints)
- Test: `tests/shell/sonda-voice-agent-na-imagem.test.sh`
- Test: `tests/unit/toda-imagem-publicada-constroi-em-pr.test.ts`, `tests/unit/imagens-ok-so-aceita-pulo-declarado.test.ts` (publication invariants)

**Interfaces:**
- Consumes: `manifesto_tem_plataforma` from Task 1 in the release job.
- Produces: a failure if any of the four versioned public indexes lacks either platform; a voice smoke that distinguishes expected external-service failure from import/startup failure.

- [ ] **Step 1: Write failing tests** that assert the workflow verifies four indexes *after* `juntar-manifestos` and *before* `promover-stable`, and that each native runner actually starts `deskcomm-voice-agent:pr` rather than only builds it. The shell test drives the smoke classifier with healthy-listener, missing-module and unexpected-exit fixtures.
- [ ] **Step 2: Run** targeted Vitest and `bash tests/shell/sonda-voice-agent-na-imagem.test.sh`; expected failure.
- [ ] **Step 3: Add verification and smoke** while preserving `imagens-ok` as the required aggregate and fork-PR read-only permissions. Re-check both architectures on every versioned tag and never promote on an unverified/skipped job. Do not treat lack of real ARI as proof of a live call.
- [ ] **Step 4: Run** targeted tests, `pnpm test:shell`, `pnpm gov:verify`; expected pass. Review the actual workflow graph and the next upstream Actions run before claiming publication success.
- [ ] **Step 5: Commit** the workflow, smoke and tests.

### Task 3: Fresh-install selection and WAHA validation

**Files:**
- Modify: `hostgator-setup-kit/install.sh` (select a published numeric release, preflight before schema/containers/.env image refs)
- Modify: `hostgator-setup-kit/_common.sh` (validate the resolved WAHA image, without overwriting a custom one)
- Test: `tests/shell/instalacao-plataforma-preflight.test.sh`
- Test: `tests/shell/arquitetura-kit.test.sh`, `tests/shell/guarda-arm-so-considera-instalacao-real.test.sh`

**Interfaces:**
- Consumes: Task 1's `preflight_imagens_crm` and `manifesto_tem_plataforma`.
- Produces: `preflight_instalacao <numeric-version> <linux/platform> <waha-ref> -> 0|nonzero`; a refused ARM64 install has no new `.env`, schema or containers.

- [ ] **Step 1: Write failing tests** for complete numeric version, newest tag not yet published, older AMD-only version, custom WAHA incompatible with host, custom Plus compatible with host, registry offline, and AMD64 regression. Assert no schema/container call on preflight failure.
- [ ] **Step 2: Run** the new shell test; expected failure on tag-only `trio_publicado`/fallback behavior.
- [ ] **Step 3: Use the existing release API helper** `ultima_release_estavel` to choose an actual published release number and validate all four images plus WAHA before writing refs or touching the DB. On ARM64, no fallback to mutable `stable`/`latest` or local build; on AMD64 retain existing explicit recovery semantics. Preserve volumes/sessions and custom WAHA selections.
- [ ] **Step 4: Run** targeted shell tests and `pnpm test:shell`; expected pass.
- [ ] **Step 5: Commit** the installer and tests.

### Task 4: Update preflight and legacy bootstrap

**Files:**
- Modify: `hostgator-setup-kit/update.sh` (target-version/platform preflight before backup, checkout, DB/service changes)
- Modify: `hostgator-setup-kit/_common.sh` (legacy ARM migration path for known default WAHA only)
- Create: `hostgator-setup-kit/preflight-upgrade.sh` (read-only check callable from a separately cloned new kit against an existing installation)
- Test: `tests/shell/atualizacao-plataforma-preflight.test.sh`
- Test: `tests/shell/update-guard.test.sh`, `tests/shell/guarda-arm-nao-mata-a-recuperacao.test.sh`
- Modify: `docs/runbooks/deploy.md` (one-time bootstrap from an old updater; no destructive reset)

**Interfaces:**
- Consumes: Task 1's first-party/WAHA platform probe.
- Produces: `preflight_plataforma_atualizacao <target-tag> <linux/platform> -> 0|nonzero`; `bash <new-kit>/hostgator-setup-kit/preflight-upgrade.sh --installation <existing-dir> --to vX.Y.Z` is the one-time read-only bootstrap before an old updater runs. Same-version no-op keeps existing SMTP/signup-mode/cron maintenance, while a rejected update leaves checkout, DB and app version unchanged.

- [ ] **Step 1: Write failing tests** for a target that lacks ARM64, four complete images, absent network, explicit custom WAHA, same-version no-op, and an old updater's first transition. Record that the script currently performs single-server sync and cron setup before deciding version, and test that a rejected *real update* performs neither.
- [ ] **Step 2: Run** the new test; expected failure before any code changes.
- [ ] **Step 3: Move the relevant preflight** after target/downgrade/no-op decisions but before side effects; refactor early maintenance only as necessary to preserve no-op behavior. Add the read-only bootstrap CLI using the new kit to check a legacy installation before its old updater can check out code; document the exact clone/preflight/update sequence. Keep the existing backup/restore mechanism, not an invented automatic DB rollback.
- [ ] **Step 4: Run** update/legacy shell tests and `pnpm test:shell`; expected pass.
- [ ] **Step 5: Commit** updater, runbook and tests.

### Task 5: Single-server Supabase preflight

**Files:**
- Modify: `hostgator-setup-kit/install-single-server.sh` (preflight before `.runtime`, Docker network and `setup.sh`)
- Create: `hostgator-setup-kit/_supabase-images.sh` (retrieve pinned official Compose, extract exact image references and validate platforms)
- Modify: `.github/workflows/publish-image.yml` (release-time online check of the pinned official Supabase ref)
- Test: `tests/shell/single-server-installer.test.sh`, `tests/shell/single-server-operacao.test.sh`
- Test: `tests/shell/supabase-imagens-plataforma.test.sh`

**Interfaces:**
- Consumes: Task 1's `manifesto_tem_plataforma` and `plataforma_oci_do_host`.
- Produces: `preflight_supabase_da_ref <self-hosted/ref> <linux/platform> -> 0|nonzero`, based on the official pinned Compose rather than a second handwritten image inventory. Invalid/changed Compose or any missing platform fails before local state is created.

- [ ] **Step 1: Write failing tests** using official-Compose fixtures with 11 images, an added twelfth, a malformed image, and an ARM-incompatible image; assert no `mkdir`, Docker network, credentials or Supabase `up` on failure.
- [ ] **Step 2: Run** the new and existing single-server tests; expected failure on the new cases.
- [ ] **Step 3: Implement the read-only pinned-Compose probe** with bounded download and parsing, then invoke it and the CRM/WAHA preflight before `mkdir -p "$RUNTIME_DIR"`. Reuse the pinned `SUPABASE_REF`; avoid printing env or secrets. Call the same probe in the release job, so a ref bump cannot publish without rechecking it.
- [ ] **Step 4: Run** single-server tests and `pnpm test:shell`; expected pass.
- [ ] **Step 5: Commit** the preflight and tests.

### Task 6: Optional SIP setup without manual VPS file edits

**Files:**
- Create: `hostgator-setup-kit/configurar-telefonia.sh` (interactive generic-trunk setup, no automatic activation)
- Modify: `asterisk/pjsip.conf.example`, `asterisk/ari.conf.example` (templates remain non-secret examples)
- Modify: `hostgator-setup-kit/_common.sh` (shared atomic write/validation only if needed)
- Test: `tests/shell/configurar-telefonia.test.sh`
- Modify: `docker-compose.prod.yml` (only if required to consume the generated files safely)

**Interfaces:**
- Produces: `bash hostgator-setup-kit/configurar-telefonia.sh` prompts for public IP, SIP host/user/secret and writes `asterisk/pjsip.conf` plus `asterisk/ari.conf` atomically with mode 0600; the ARI user/password matches `.env`, existing files are never overwritten without explicit confirmation, and `COMPOSE_PROFILES` stays unchanged.

- [ ] **Step 1: Write failing tests** for first setup, invalid IP/host/injected newline, interrupted write, rerun with existing custom configs, ARI credential agreement, and secret absence from stdout/logs. Use a temporary project tree; never connect to a trunk.
- [ ] **Step 2: Run** `bash tests/shell/configurar-telefonia.test.sh`; expected failure on missing CLI.
- [ ] **Step 3: Implement the bounded generic-trunk configurator** with atomic private files and explicit confirmation before replacing operator-owned config. Explain providers requiring nonstandard PJSIP settings as advanced custom configuration, not “automatic support”. Leave `telefonia` disabled until the operator opts in.
- [ ] **Step 4: Run** the new test and `pnpm test:shell`; expected pass.
- [ ] **Step 5: Commit** the CLI/templates/tests.

### Task 7: Release documentation and acceptance evidence

**Files:**
- Modify: `docs/doctrine/packaging.md`, `docs/runbooks/deploy.md`, `hostgator-setup-kit/README.md`
- Create: `docs/runbooks/oracle-arm64.md` (Oracle VCN/firewall, resource checks, install/update/restore, external acceptance matrix)
- Create: `.changes/oracle-arm64-preflight.md` (release fragment in the repo's format)
- Test: `tests/shell/oracle-arm64-runbook.test.sh` (paths/commands/ports/guardrails present)

**Interfaces:**
- Consumes: all previous tasks; no new runtime API.
- Produces: one repeatable operator path for Oracle Ampere Ubuntu, with optional `voz` and `telefonia` clearly separated from the default stack.

- [ ] **Step 1: Write failing runbook tests** for version pinning, preflight diagnostics, VCN + Ubuntu firewall ports (80/443, optional 7881/UDP, 5060/UDP and 10000–10200/UDP), backups and restore rehearsal, and refusal to claim live calls from image manifests alone.
- [ ] **Step 2: Run** the new test; expected failure.
- [ ] **Step 3: Write/update docs** reflecting actual CLI behavior, native ARM constraints and the 2-OCPU/12-GB capacity caveat. Include an acceptance log for UI+direct-tool AI agreement, Supabase/RLS, WhatsApp message/media/session restart, WaCalls call, SIP call, backup/restore and resource use; each starts “não executado” until evidence exists. Explicitly state GitHub commits do not auto-deploy without a separately configured workflow; no customer VPS changes in this implementation.
- [ ] **Step 4: Run** `pnpm gov:verify`, `pnpm test:shell`, relevant `pnpm test:db`/`pnpm test:e2e` only if schema/UI changed, and native AMD64/ARM64 artifact checks. Record the results and any external checks that cannot run without Oracle, number/WAHA/AI or SIP credentials.
- [ ] **Step 5: Commit** docs/tests, review the branch against `origin/main`, and prepare a PR only after the user-owned fork destination is verified.

## Safe previous version and rollout

The untouched upstream baseline is commit `79e0a6b13` (release 1.66.0), saved locally as branch `backup/pre-arm64-followup-2026-09-30`; the older pre-PR baseline `cd31a305c` is saved as `backup/pre-arm64-2026-09-30`. Neither backup branch is a database backup or a production rollback. No VPS deployment, tag movement or GHCR publication is part of this plan. At deployment time, make the kit's data backup and verify restore separately before updating the live installation.
