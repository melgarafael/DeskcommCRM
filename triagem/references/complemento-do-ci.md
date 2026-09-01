# O complemento do CI — o que os gates não provam

> Este reference é o **coração** da triagem: puxe no passe 4. Ele lista, com gatilho no diff e
> comando, tudo que a doutrina exige e que **nenhum job de CI reprova**. Repetir o que o CI já faz é
> teatro; o trabalho é aqui.
>
> **Toda linha desta tabela é uma tarefa pendente do CI.** Quando uma virar gate de verdade, apague-a
> daqui — a triagem fica mais leve. Se esta lista só cresce, o passe 11 não está sendo cumprido.

Medido em 2026-08-04 contra `origin/main` = d37da57. **Reconfira antes de confiar**: a Definition of
Done já foi de 13 para 14 itens, e o número de specs de e2e citado no `CLAUDE.md` já divergia do
workflow real.

---

## 1. Tripla de migration — a violação nº 1, e 100% invisível no CI

**Gatilho:** o diff adiciona `supabase/migrations/*.sql`.

**Checagem:** o mesmo commit precisa trazer as três coisas — o arquivo da migration, um apêndice
**idempotente** no `supabase/baseline.sql`, e uma linha no `supabase/migrations/MANIFEST.md`.

```bash
git diff --name-status origin/main...<pr> | grep -E 'supabase/(migrations|baseline)'
bash loop/hooks/check-migration-triple.sh    # se disponível na árvore
```

**Por que o CI não pega:** o guard é um hook de git ativado por `core.hooksPath=loop/hooks`, que é
**configuração local, não versionada**. Um fork nunca o executa e nenhum job do `ci.yml` o invoca.

**Por que importa mais do que parece:** o kit self-host aplica **só o `baseline.sql`**, tanto no
`install.sh` quanto no `update.sh`. Migration que não chega ao baseline **não chega em quem instalou
numa VPS** — que é o cliente que paga. Não é dívida técnica: é a mudança não existir para o cliente.

**Atenção na unicidade do `NNNN`:** o hook original compara contra as branches **locais**. Na triagem
de um fork isso é a sonda errada — compare contra o remoto.

**Se a migration cria constraint:** os dados existentes têm de ser corrigidos **antes**, no mesmo
apêndice. Senão o `update.sh` de um clone com dados sujos quebra.

---

## 2. RLS de tabela tenant-aware nova

**Gatilho:** o diff tem `create table` com coluna `organization_id`.

**Checagem:** `enable row level security` + policy `tenant_isolation_<tabela>_all` usando
`fn_user_org_ids()` + **a tabela nova acrescentada à constante `TABLES`** de
`tests/invariants/rls-isolation.test.ts`.

**Por que o CI não pega:** o teste de isolamento percorre uma **lista fixa de 10 tabelas**. Não existe
varredura genérica do tipo "toda tabela com `organization_id` tem `relrowsecurity=true`". Tabela nova
sem RLS passa verde.

---

## 3. ~~`security definer` exposto a `anon`~~ — VIROU GATE (issue #128, 2026-08-05)

**Saiu desta lista.** `tests/invariants/hardening-definer-varredura.test.ts` **varre** todas as
`security definer` de `public` no baseline aplicado e reprova qualquer uma executável por `anon`,
mais qualquer uma **volátil** executável por `authenticated` sem razão escrita. Roda no job
`invariants`, que é obrigatório.

Fica registrado o que a varredura achou quando entrou, porque é o tamanho do buraco que a lista fixa
de 6 não via: **8 das 25** funções estavam expostas a `anon` — entre elas
`fn_publish_ai_agent_version`, que escreve e recebe o org por argumento sem checar membership.

**A armadilha, para quem for escrever função nova:** há DUAS origens de `EXECUTE` e cada uma pede um
`revoke` diferente. (A) o grant direto a `anon` do `ALTER DEFAULT PRIVILEGES` do baseline, que
`revoke from public` não remove; (B) o grant a `PUBLIC` que o Postgres dá a toda função ao criá-la,
que `revoke from anon` não remove. Trate as duas: `revoke execute on function ... from public, anon`
— e depois re-conceda explicitamente a quem precisa.

---

## 4. `console.log` — o DoD que parece automático e não é

**Gatilho:** qualquer `.ts`/`.tsx`.

```bash
git diff origin/main...<pr> -- '*.ts' '*.tsx' | grep -n '^+.*console\.log'
```

**Por que o CI não pega:** `no-console` está como **`warn`** no `eslint.config.mjs`, e o script é
`eslint .` sem `--max-warnings`. Sai com código 0. Aparece exigido em três lugares (CONTRIBUTING,
template de PR, e o DoD do CLAUDE.md) e nenhum gate o reprova.

**Classe geral:** vale para **qualquer** regra `warn` do eslint. Confira o `eslint.config.mjs` antes
de supor que uma regra reprova.

---

## 5. Env var nova

**Gatilho:** o diff toca `lib/env.ts` ou `.env.example`.

**Checagem:** a var está nos **dois** arquivos? É `required`? Se for, uma instalação nova quebra —
existe default, ou o schema a trata como opcional?

**Por que o CI não pega:** o build do CI e a máquina de quem desenvolve costumam já ter a var. Quem
descobre é o self-hoster, no primeiro deploy.

---

## 6. Kit self-host — nenhum job o testa

**Gatilho:** `self-host-kit/**`, `docker-compose*`, `Dockerfile`, `scripts/*.sh`.

**Checagem:**

1. `install.sh` em Postgres descartável (`pgvector/pgvector:pg17`), fresh, com `ON_ERROR_STOP=1`.
2. `update.sh` re-aplicando em banco existente, **sem** a flag — tem de ser idempotente.
3. **GET externo** na URL final, de fora do contêiner.

**Por que o CI não pega:** não existe job que instale o kit. E o passo 3 é o que separa "instalou" de
"funciona": ver *falha-em-verde*, abaixo.

---

## 7. Falha-em-verde — a classe mais cara num produto self-host

**Gatilho:** o PR toca qualquer coisa que **declare sucesso** — sonda de saúde, `healthcheck`,
mensagem final de script, status de conexão na tela.

**Pergunta obrigatória:** *qual é a sonda que declara sucesso, e ela mede o mesmo caminho que o
usuário usa?*

**Caso real:** um instalador terminava com `Instalação concluída! Acesse: https://$DOMAIN` num site
inalcançável de fora, porque a sonda rodava **dentro** do contêiner. A instalação "passava" quebrada.

Num produto que a pessoa instala sozinha, ninguém está olhando: o cliente não descobre que está
quebrado. Isto é bloqueador, não nota.

---

## 8. Catraca de canal — a armadilha da reconciliação

**Gatilho:** o PR mexe em arquivo que está no `KNOWN_DEBT` de `scripts/lint-channels.ts`.

**Checagem:** `pnpm lint:channels`. A catraca reprova em **três** direções, e a terceira é a que pega
quem conserta as coisas: arquivo novo sujo reprova; arquivo da lista que continua sujo reprova; e
**arquivo que ficou limpo e não foi removido da lista também reprova**.

Ou seja: se você limpar um arquivo durante a reconciliação, **tire-o da lista no mesmo commit**.

---

## 9. `.github/workflows/` vindo de fork

**Gatilho:** o diff toca `.github/workflows/`.

**Checagem:** leitura linha a linha.

**Contexto que acalma:** os gatilhos são `pull_request` (não `pull_request_target`), e o default do
repo é `permissions: read` com `can_approve_pull_request_reviews=false`. Código de fork **não roda com
segredo do repositório** — a arquitetura já é a segura. Ainda assim, mudança de workflow por
contribuidor externo é achado que merece olho, e se algum dia alguém propuser `pull_request_target`,
isso é bloqueador com explicação.

---

## 9-bis. ~~A imagem Docker não tinha gate nenhum~~ — VIROU GATE (PR #233, 2026-08-12)

**Saiu desta lista.** `publish-image.yml` roda agora em `pull_request` também: em PR ele CONSTRÓI a
imagem (que é o gate) e não publica (`push: false`, login no GHCR pulado — fork não tem escrita no
registry).

Fica registrado como o buraco se manifestou, porque a forma é instrutiva: o workflow rodava só em
push na `main`, em tag e em release. **Nenhum PR conseguia revelar que quebrava a imagem** — e o
artefato que o self-hoster instala era o único sem gate. Um bump de `next` (16.2.12 → 16.3.0) passou
por `verify`, `build-and-size`, `invariants` e `e2e` — que eram, na época, os quatro obrigatórios; hoje são cinco, com `imagens-ok` — e derrubou o build do
Dockerfile na `main`.

A causa era fina: `.dockerignore` deixa `tests/` fora da imagem, e a partir do next 16.3 o
`next build` typecheca os `*.test.ts` **colocados** (os que moram em `app/`, `components/`, `lib/`).
Sete deles importam `@/tests/helpers/*`. Dentro da imagem, os módulos não existem.

**Resolvido, por um caminho diferente do que esta linha previa** (2026-08-13). Em vez de
exigir `build-and-push` — cujo nome muda a cada imagem da matriz —, criou-se o job de fachada
`imagens-ok`, que depende dele, falha junto, e **é** required check da `main`. Ou seja: imagem
quebrada **barra** o merge.

Quem conferisse pelo nome literal `build-and-push` na branch protection não o acharia e
concluiria que a pendência continua — a afirmação sobre o NOME segue verdadeira e a afirmação
sobre a CONSEQUÊNCIA ("informa mas não barra") ficou falsa. É a consequência que decide se um
triador deixa passar um PR que quebra a imagem. Meça a consequência, não o nome:
`gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts'`.

---

## 10. O que TEM gate — não refaça

Para não gastar passe à toa:

| item | gate que já cobre |
|---|---|
| DoD 14, "tela nova tem porta" | `pnpm test:unit` → `navegacao-completude.test.ts` |
| provider nomeado fora de `lib/channels/` | `pnpm lint:channels` |
| baseline aplica fresh **e** idempotente | `pnpm test:db` (job `invariants`) |
| isolamento RLS nas 10 tabelas listadas | `pnpm test:db` |
| tipos, lint, unit, shell, build | job `verify` + `build-and-size` |
| a imagem Docker do self-host constrói | job `build-and-push` (PR #233) — **ainda não obrigatório** |
| link do e-mail de auth tem uma query só | `pnpm test:unit` → `link-de-email-tem-uma-query-so.test.ts` (PR #176) |
| `viewer` barrado na rota de upload de mídia | `pnpm test:unit` → `rbac-matrix.test.ts` (PR #232) |

---

## 11. O que o verde do `e2e` NÃO significa

O job `e2e` **passou a ser obrigatório** (medido em 2026-08-08:
`gh api .../branches/main/protection --jq '.required_status_checks.contexts'` → `verify,
build-and-size, invariants, e2e`). Este parágrafo dizia o contrário até então, e uma triagem que o
lesse mediria contra a régua errada — o modo de falha nº 1 do passe 0.

Mas ele ser obrigatório **não** o torna prova de jornada. Ele mesmo imprime, no resumo, o que não
cobriu: das 33 specs, a que **não roda** é a de instalação fresca em VPS, marcada `[P0]` — que é
exatamente o produto que se vende.

Ler `e2e` verde como "jornada de usuário provada" é falso verde **declarado pelo próprio arquivo**.
Para PR que toca instalação ou onboarding, a prova é o passe 5, não o job.
