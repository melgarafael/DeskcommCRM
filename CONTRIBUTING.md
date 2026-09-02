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
3. **Definition of Done.** A lista está separada em duas por um motivo: até hoje ela misturava
   o que uma máquina reprova com o que só uma pessoa percebe, e contribuidor marcava o checklist
   inteiro de boa-fé para ser barrado por um gate que ninguém tinha contado a ele.

   **O que o CI reprova sozinho** — rode antes de abrir o PR e não terá surpresa:

   ```bash
   pnpm typecheck && pnpm lint && pnpm lint:channels && pnpm test:unit && pnpm test:shell && pnpm build
   pnpm test:db   # precisa de Docker; sobe um Postgres limpo e aplica o baseline
   ```

   **O que o CI NÃO vê** — fica com você e com a revisão, e é onde moram os defeitos caros:

   - RLS habilitada e policy `tenant_isolation_<tabela>_all` se você criou tabela tenant-aware
     (o teste de isolamento cobre uma lista fixa de tabelas; a sua nova não entra sozinha)
   - Audit log emitido se há mutação relevante
   - Rate limit aplicado se a rota é pública
   - Zod validando todo input externo
   - Sem `console.log` esquecido (use `lib/logger.ts`). **O `pnpm lint` não reprova isso** — a regra
     está como aviso, então ele passa verde; a conferência é humana
   - Env vars novas em `.env.example` **e** `lib/env.ts`, com default que não quebre instalação nova
   - Mudança de schema saiu como **tripla**: arquivo em `supabase/migrations/`, apêndice idempotente
     no `supabase/baseline.sql` e linha no `MANIFEST.md`. O kit self-host aplica **só o baseline** —
     migration que não chega lá não chega em quem instalou numa VPS. Nenhum job de CI confere isso
   - **Se você tocou `Dockerfile*`, `docker-compose*.yml` ou `hostgator-setup-kit/`:** a mudança
     alcança quem **já** instalou. Lei em [`docs/doctrine/packaging.md`](docs/doctrine/packaging.md).
     O CI reprova serviço `build:`-only, instalação em tag móvel e imagem quebrada (`imagens-ok`);
     o que fica com você é o resto: variável nova com default que não quebre `.env` antigo, e a
     atualização não pedindo edição manual de arquivo. **Nenhum bump pode exigir que o operador
     da VPS edite alguma coisa na mão** — se exigir, abra issue com plano de migração em vez de PR
   - Docs atualizadas se mudou contrato (PRD/spec)
   - `pnpm test:e2e` (subset relevante) — **opcional se você contribui de fora**, ver abaixo
4. Abrir PR contra `main`. Description deve referenciar o epic e listar evidências (logs/screenshots dos testes).
5. **Tocou um documento de autoridade?** Corrija as afirmações de estado **daquele** documento —
   as que dizem o que está ativo, o que falta, o que aponta para onde. Não saia caçando nos
   outros: a dívida decai sozinha se ninguém a alimentar. Achados medidos, com o comando de cada
   um, em [`docs/audits/2026-08-14-afirmacoes-de-estado.md`](docs/audits/2026-08-14-afirmacoes-de-estado.md).

6. CI deve passar antes de merge. Obrigatórios: `verify`, `invariants` (isolamento RLS),
   `build-and-size`, `e2e` e `imagens-ok`.

   O `imagens-ok` (em `.github/workflows/publish-image.yml`) constrói as três imagens que o
   self-hoster instala, roda em PR e **bloqueia** desde 2026-08-13.

   Verde no `e2e` **não** é "jornada provada": ele mesmo imprime, no resumo, quais specs não
   cobriu — e a que fica de fora é justamente `vps-fresh-onboarding`, a instalação do zero.

   > Esta lista dizia "três obrigatórios" e chamava o `e2e` de não-bloqueante. Estava
   > desatualizada nos dois pontos, e quem a usasse como régua mediria contra a régua errada.
   > Confira na fonte antes de confiar em qualquer lista escrita:
   > `gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts'`

### Pegando uma issue — o protocolo

Existe porque já falhamos nisto: em 2026-07-30 abrimos uma issue, um contribuidor
começou a resolvê-la, e um mantenedor entregou a mesma correção **21 segundos antes**
sem que nenhum dos dois pudesse ver o outro. O trabalho dele foi para o lixo. As regras
abaixo são para que isso não se repita.

1. **Comente "pego esta" antes de codar.** Uma linha basta. Um mantenedor te atribui a
   issue — a partir daí ela é sua e ninguém mais mexe.
2. **Issue com pessoa atribuída não se duplica.** Se você quer ajudar mesmo assim,
   comente oferecendo; não abra PR concorrente.
3. **Mantenedor não implementa issue marcada `good first issue` ou `help wanted`** sem
   antes se atribuir a ela publicamente. Se você vir uma dessas sem dono, ela é sua para
   pegar — essa é a garantia que damos em troca do passo 1.
4. **Sem resposta em 48h depois do "pego esta"?** Comece assim mesmo e diga no PR. A
   demora é nossa, o custo não pode ser seu.

### Se você está contribuindo de fora (fork) — leia isto

Duas coisas vão parecer erro seu e não são:

- **O check `Vercel` fica vermelho** com "Authorization required to deploy". A `main` deste
  repositório faz deploy de produção, e a Vercel se recusa a construir PR de fork por
  segurança — o que está certo. **Ignore esse check**; ele não entra no gate de merge.
- **Os workflows ficam parados esperando aprovação** no seu primeiro PR. É política do
  GitHub para quem nunca contribuiu antes. Um mantenedor libera; do segundo PR em diante
  roda sozinho. Se demorar, comente no PR.

**Abra o PR de um ramo com nome, nunca do `main` do seu fork.** Se o `main` do fork já tem
personalizações suas — e ele quase sempre tem, porque é dele que a sua VPS puxa —, o PR propõe
essas personalizações ao produto inteiro. Isso não gera conflito e não acende gate nenhum: elas
entram em silêncio para todas as instalações. Foi medido (PR #465): sete arquivos com a marca de um
cliente, seis deles mergeando sem um único conflito. O caminho é `git checkout -b fix/o-que-voce-conserta`
a partir da `main` **deste** repositório, com só o seu conserto dentro.

**A marca da sua instalação não se troca editando código.** Não altere `DEFAULT_APP_NAME` em
`lib/branding.ts`, nem os títulos em `app/`. O banco manda (`platform_branding`,
`organizations.settings.branding`), `APP_NAME` no `.env` é a semente que o `install.sh` pergunta, e
o resto é a tela **Configurações › Marca**. Receita inteira em [`docs/white-label.md`](docs/white-label.md).
Editar a constante troca o padrão do PRODUTO — e a sua marca some no próximo `git pull`, o que é a
razão prática de o caminho suportado ser melhor para você também.

E sobre o `pnpm test:e2e` do DoD: rodar a suíte completa exige Docker, banco semeado e WAHA
local. **Não travamos PR externo nisso** — mande o que conseguiu provar (unit + descrição do
que testou na mão), que a prova de tela fica com o mantenedor. Exigir prova sem entregar a
ferramenta de produzi-la seria pedágio, não rigor.

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

**[GitHub Discussions](https://github.com/melgarafael/DeskcommCRM/discussions)** — é o canal público,
funciona para qualquer pessoa e é onde a resposta fica registrada para quem vier depois. Para bug,
[abra uma issue](https://github.com/melgarafael/DeskcommCRM/issues/new/choose).

Se for algo que não cabe em público (segurança, por exemplo): `rafael@maudibrasil.com.br` — o mesmo
endereço do [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

> Esta seção apontava para um Discord interno cujo convite mora num Notion privado — inalcançável
> justamente para quem mais precisava dela, que é quem vem de fora. Ficou aqui como lembrete de que
> canal de suporte se testa pelo lado de fora.
