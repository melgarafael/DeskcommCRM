# Contributing — DeskcommCRM

[🇧🇷 Português](CONTRIBUTING.md) · 🇺🇸 English

## Before you start

0. Open the repository in your code assistant (Claude Code, Codex, Cursor, OpenCode or
   Antigravity): the `deskcomm-contribuir` guide (`.agents/skills/deskcomm-contribuir/SKILL.md`) measures,
   before the PR, what triage measures after — stale branch, migration triple, fork mark in the
   diff, release fragment — and arms the git hooks with `bash .agents/skills/deskcomm-contribuir/scripts/armar-hooks.sh`.
   To have the guides in any folder: `bash scripts/instalar-guias.sh`. Going to **edit** a guide?
   Run `bash scripts/instalar-guias.sh --fonte .` in your clone — in Claude Code the global skill
   beats the project one, and without it you would be testing the `main` version, not yours.
1. Read [`CLAUDE.md`](CLAUDE.md) — non-negotiable conventions.
2. Read [`ARCHITECTURE.md`](ARCHITECTURE.md) — the 1-page view.
3. Identify the source epic in [`docs/stories/epics/MASTER.md`](docs/stories/epics/MASTER.md).

## Flow

### Branches

```
feat/EPIC-XX-short-slug         # new feature
fix/EPIC-XX-short-slug          # bug fix
chore/short-slug                # chore (deps, configs)
docs/short-slug                 # docs only
```

### Commits

Conventional commits + `EPIC-XX` scope:

```
feat(EPIC-04): kanban drag-and-drop with fractional indexing
fix(EPIC-03): cron recover-stuck-messages marks sending stuck >5min as failed
docs(EPIC-12): mark complete + wave log
```

PT-BR messages are accepted. The subject must be imperative and ≤72 chars.

### epic-executor

Large changes follow [`docs/stories/epics/`](docs/stories/epics/). The `epic-executor` consumes the frontmatter (`epic_id`, `priority`, `depends_on`, `status`) and executes wave-by-wave with continuous E2E validation.

When finishing an epic:

1. Update frontmatter `status: pending → completed (partial: ...)` or `status: completed`.
2. Append "Wave Completion Log" at the end of the file.
3. Update the corresponding row in `docs/stories/epics/MASTER.md`.

### PR process

1. Branch from `main`.
2. Implement. Add tests (E2E for flows, unit for pure logic).
3. **Definition of Done.** The list is split in two for a reason: until today it mixed
   what a machine rejects with what only a person notices, and a contributor ticked the whole
   checklist in good faith only to be stopped by a gate nobody had told him about.

   **What CI rejects by itself** — run it before opening the PR and there will be no surprise:

   ```bash
   pnpm cercas    # ~30 s: the structural guards (baseline, MANIFEST, docs, workflows, Spanish i18n, .changes/ fragments) — what rejects the most PRs
   pnpm typecheck && pnpm lint && pnpm lint:channels && pnpm test:unit && pnpm test:shell && pnpm build
   pnpm test:db   # needs Docker; brings up a clean Postgres and applies the baseline
   ```

   **What CI does NOT see** — it stays with you and with review, and it is where the expensive defects live:

   - RLS enabled and policy `tenant_isolation_<tabela>_all` if you created a tenant-aware table
     (the isolation test covers a fixed list of tables; your new one does not get in by itself)
   - Audit log emitted if there is a relevant mutation
   - Rate limit applied if the route is public
   - Zod validating every external input
   - No forgotten `console.log` (use `lib/logger.ts`). **`pnpm lint` does not reject this** — the rule
     is a warning, so it passes green; the check is human
   - New env vars in `.env.example` **and** `lib/env.ts`, with a default that does not break a fresh install
   - Schema change shipped as a **triple**: file in `supabase/migrations/`, idempotent appendix
     in `supabase/baseline.sql` and a `-- manifest: <what and why>` line in the `.sql` header (not in `MANIFEST.md`, which is history). The self-host kit applies **only the baseline** —
     a migration that never gets there never reaches whoever installed on a VPS. No CI job checks this
   - **If you touched `Dockerfile*`, `docker-compose*.yml` or `hostgator-setup-kit/`:** the change
     reaches people who **already** installed. Law in [`docs/doctrine/packaging.md`](docs/doctrine/packaging.md).
     CI rejects `build:`-only service, install on a moving tag and broken image (`imagens-ok`);
     what stays with you is the rest: new variable with a default that does not break an old `.env`, and the
     update not asking for manual file editing. **No bump may require the VPS
     operator to edit anything by hand** — if it does, open an issue with a migration plan instead of a PR
   - Docs updated if the contract changed (PRD/spec)
   - `pnpm test:e2e` (relevant subset) — **optional if you contribute from outside**, see below
4. Open a PR against `main`. The description must reference the epic and list evidence (logs/screenshots of the tests).
5. **Touched an authority document?** Fix the state claims **of that** document —
   the ones saying what is active, what is missing, what points where. Do not go hunting in the
   others: the debt decays by itself if nobody feeds it. Measured findings, with the command for each,
   in [`docs/audits/2026-08-14-afirmacoes-de-estado.md`](docs/audits/2026-08-14-afirmacoes-de-estado.md).

6. CI must pass before merge. Required: `verify`, `invariants` (RLS isolation),
   `build-and-size`, `e2e` and `imagens-ok`.

   `imagens-ok` (in `.github/workflows/publish-image.yml`) builds the three images that the
   self-hoster installs, runs on PRs and **blocks** since 2026-08-13.

   Green on `e2e` is **not** "journey proved": it prints, in its own summary, which specs it did not
   cover. Which ones, read from the workflow itself rather than from this line — it already said the
   one left out was `vps-fresh-onboarding`, the install from scratch, and since PR #983 that one runs in CI:

   ```bash
   git show origin/main:.github/workflows/e2e.yml | grep -A4 'FORA_DO_CI:'
   ```

   And even a journey that HAS a gate still owes the proof on screen when you change it
   (DoD 12): the gate proves it did not regress, not that the experience got good.

   > This list used to say "three required" and called `e2e` non-blocking. It was
   > out of date on both points, and whoever used it as a ruler would measure against the wrong ruler.
   > Check the source before trusting any written list:
   > `gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts'`

### Claiming an issue — the protocol

It exists because we already failed at this: on 2026-07-30 we opened an issue, a contributor
started solving it, and a maintainer shipped the same fix **21 seconds before**
without either of them being able to see the other. Their work went to the trash. The rules
below exist so that this does not repeat.

1. **Comment "pego esta" before coding.** One line is enough. A maintainer assigns the
   issue to you — from that point on it is yours and nobody else touches it.
2. **An issue with an assigned person is not duplicated.** If you still want to help,
   comment offering; do not open a competing PR.
3. **A maintainer does not implement an issue labeled `good first issue` or `help wanted`**
   without first assigning it to themselves publicly. If you see one without an owner, it is yours to
   take — that is the guarantee we give in exchange for step 1.
4. **No answer within 48h after "pego esta"?** Start anyway and say so in the PR. The
   delay is ours, the cost cannot be yours.

### If you are contributing from outside (fork) — read this

One thing will look like your mistake and it is not:

- **The workflows sit waiting for approval** on your first PR. It is GitHub policy
  for anyone who has never contributed before. A maintainer releases it; from the second PR on it runs
  by itself. If it takes long, comment on the PR.

**Open the PR from a named branch, never from your fork's `main`.** If the fork's
`main` already has your customizations — and it almost always does, because that is where your VPS pulls from —, the PR proposes
those customizations to the whole product. It causes no conflict and lights up no gate: they
enter silently into every installation. It was measured (PR #465): seven files with the mark of a
client, six of them merging without a single conflict. The path is `git checkout -b fix/o-que-voce-conserta`
from **this** repository's `main`, with only your fix inside.

**With "Allow edits by maintainers" on in your PR, the project can push a fix straight onto the
PR branch** — a mechanical adjustment, or `main` brought in when there is a conflict. Always as a
new commit: never `--force`, never rebase, and your commits stay as they are. We announce it in the PR before
pushing. When that happens, bring the branch in before continuing (`git pull --no-rebase`) and only
then push again; a `--force` on your side would erase what was pushed from our side. With the
option off, the fix goes to a branch of ours. In both paths, the work that is yours lands with
you as its author.

**Your installation's brand is not changed by editing code.** Do not change `DEFAULT_APP_NAME` in
`lib/branding.ts`, nor the titles in `app/`. The database rules (`platform_branding`,
`organizations.settings.branding`), `APP_NAME` in `.env` is the seed that `install.sh` asks for,
and the rest is the **Settings › Brand** screen. Full recipe in [`docs/white-label.md`](docs/white-label.md).
Editing the constant changes the PRODUCT's default — and your brand disappears on the next `git pull`, which is the
practical reason the supported path is better for you too.

And about the `pnpm test:e2e` in the DoD: running the full suite requires Docker, a seeded database and local
WAHA. **We do not hold external PRs on it** — send what you managed to prove (unit + description of
what you tested by hand), and the proof on screen stays with the maintainer. Requiring proof without delivering the
tool to produce it would be a toll, not rigor.

### `tests/invariants/` is frozen — and this covers BEHAVIOR, not just the file

The files in `tests/invariants/` hold laws of the product, and touching them asks for written
justification. Two things that are not obvious and have already cost contributors time:

1. **The guard is a local hook of the maintainer** (`core.hooksPath=loop/hooks`), not a CI check.
   You will not see it reject in your fork — what you see is the integration breaking later.
2. **A PR can reject an invariant without touching its file.** If your fix changes the
   behavior the law asserts, the red shows up there. This is **not your oversight** — it is the
   sign that two concurrent rules exist: the one written and the one you propose.

When it happens, **do not delete or loosen the assertion**: say in the PR what your reason is and leave the
choice explicit. Whoever triages writes the change to the invariant with the required justification, or adjusts the
fix to preserve the old law — and the decision is recorded in the PR, which is where it serves
the next person.

### On-screen text: every new sentence needs Spanish

The product speaks Portuguese and Spanish, and CI rejects **a new sentence without a translation**. The rule was not
written here until 09/16/2026, and a first-contribution PR was rejected because of it — the
failure was ours, not the contributor's.

If you added a sentence that appears on screen, it goes through `t("...")` **and** gets a line
in `lib/i18n/dicionario.ts`:

```ts
"Digite o identificador do modelo": { es: "Escribe el identificador del modelo" },
```

The key is the Portuguese text (not a code). Only Spanish needs a line; the rest degrades
to Portuguese on purpose.

To check before opening the PR, without running the whole suite:

```bash
pnpm test:unit tests/unit/i18n-espanhol-cobre-a-tela.test.ts
```

It rejects in both directions: a key used on screen without Spanish, and Portuguese prose that did not
go through `t()`. **If you don't speak Spanish, send it anyway** and say so in the PR — the translation is
ten seconds of work for whoever triages, and no reason to hold back a fix.

### Prohibited anti-patterns

Full list in `CLAUDE.md`. The most lethal:

- Postgres trigger doing HTTP
- Service role used in a handler without filtering `organization_id` manually
- `getSession()` on the backend (use `getUser()`)
- API key in query string
- Bearer plaintext in the DB
- `console.log` in merged code

## Local setup

See [`README.en.md`](README.en.md) §Development — how to run locally.

## Support

**[GitHub Discussions](https://github.com/melgarafael/DeskcommCRM/discussions)** — it is the public
channel, works for anyone and is where the answer stays recorded for whoever comes after. For bugs,
[open an issue](https://github.com/melgarafael/DeskcommCRM/issues/new/choose).

If it is something that does not fit in public (security, for example): `rafael@maudibrasil.com.br` — the same
address as in [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

> This section used to point to an internal Discord whose invite lives in a private Notion — unreachable
> precisely for whoever needed it most, who is the one coming from outside. It stays here as a reminder that
> a support channel is tested from the outside.
