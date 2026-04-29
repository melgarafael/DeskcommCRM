# Contributing — DeskcommCRM

## Antes de começar

1. Leia [`CLAUDE.md`](CLAUDE.md) — convenções não-negociáveis.
2. Leia [`ARCHITECTURE.md`](ARCHITECTURE.md) — visão de 1 página.
3. Identifique o epic de origem em [`docs/stories/epics/MASTER.md`](docs/stories/epics/MASTER.md).

## Fluxo

### Branches

```
feat/EPIC-XX-short-slug         # nova feature
fix/EPIC-XX-short-slug          # bug fix
chore/short-slug                # chore (deps, configs)
docs/short-slug                 # apenas docs
```

### Commits

Conventional commits + escopo `EPIC-XX`:

```
feat(EPIC-04): kanban drag-and-drop com fractional indexing
fix(EPIC-03): cron recover-stuck-messages marcando sending stuck >5min como failed
docs(EPIC-12): mark complete + wave log
```

Mensagens em PT-BR são aceitas. O assunto deve ser imperativo e ≤72 chars.

### epic-executor

Mudanças grandes seguem [`docs/stories/epics/`](docs/stories/epics/). O `epic-executor` consome o frontmatter (`epic_id`, `priority`, `depends_on`, `status`) e executa wave-by-wave com validação E2E continuous.

Ao finalizar um epic:

1. Atualizar frontmatter `status: pending → completed (partial: ...)` ou `status: completed`.
2. Append "Wave Completion Log" no final do arquivo.
3. Atualizar a row correspondente em `docs/stories/epics/MASTER.md`.

### PR process

1. Branch a partir de `main`.
2. Implementar. Adicionar testes (E2E pra fluxos, unit pra lógica pura).
3. **Definition of Done** — todos verdes:
   - `pnpm typecheck`
   - `pnpm lint`
   - `pnpm test:unit`
   - `pnpm test:e2e` (subset relevante)
   - RLS testada se feature toca tabela tenant-aware
   - Audit log emitido se há mutação relevante
   - Rate limit aplicado se rota é pública
   - Zod valida todo input externo
   - Sem `console.log` esquecido (use `lib/logger.ts`)
   - Env vars novas em `.env.example` + `lib/env.ts`
   - Docs atualizadas se mudou contrato (PRD/spec)
4. Abrir PR contra `main`. Description deve referenciar o epic e listar evidências (logs/screenshots dos testes).
5. CI deve passar antes de merge. Teste de isolamento RLS é gate obrigatório.

### Anti-patterns proibidos

Lista completa em `CLAUDE.md`. Os mais letais:

- Trigger Postgres fazendo HTTP
- Service role usado em handler sem filtrar `organization_id` manualmente
- `getSession()` no backend (use `getUser()`)
- API key em query string
- Bearer plaintext no DB
- `console.log` em código merged

## Setup local

Veja [`README.md`](README.md) §Como rodar local.

## Suporte

Dúvidas: `rafael@maudibrasil.com.br`. Canal interno do BPO Discord (link no Notion).
