# AI_BOOTSTRAP — leia isto primeiro

Porta de entrada de qualquer agente de código neste repositório (Claude Code, Codex, Cursor,
Copilot, Amp). Não é doutrina: é o roteador. **Dois minutos aqui evitam o dano típico.**

## 1. Ordem de leitura

| #   | Arquivo                                             | Quando                                                                                       |
| --- | --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | **este**                                            | Sempre, antes de qualquer coisa                                                              |
| 2   | [`CLAUDE.md`](../CLAUDE.md)                         | Antes de escrever a primeira linha de código. É a doutrina, e vence qualquer outro documento |
| 3   | [`AGENTS.md`](../AGENTS.md)                         | Se você não é o Claude Code: mesmo contrato, forma portável                                  |
| 4   | [`docs/index.md`](../docs/index.md)                 | Quando precisar de detalhe de um assunto — índice dos docs                                   |
| 5   | [`docs/current-state.md`](../docs/current-state.md) | Antes de estimar, prometer ou dizer que algo existe                                          |

## 2. A regra que governa todas as outras

**O repositório mede; a prosa descreve.** Código, `package.json`, workflows e `gh api` são a fonte
do estado — documento é sempre uma foto que pode ter envelhecido. Onde os dois discordarem, o
documento está errado: corrija-o no mesmo PR.

Por isso a documentação de autoridade deste repo evita número volátil e prefere comando. Quando
você for escrever uma afirmação de estado, escreva o comando que a prova.

## 3. O que este produto é (e por que isso muda seu trabalho)

CRM de vendas open source com agentes de IA e WhatsApp, **distribuído como código e instalado numa
VPS pelo próprio cliente**. Quem instala é o usuário final. Consequências diretas:

- Mudança que funciona na sua máquina e quebra no clone fresco é **bug de produto**.
- Schema só chega ao cliente se entrar em `supabase/baseline.sql` — migration solta não chega.
- O nome do produto é revendido: **nunca escreva "Deskcomm" em código que alcança o usuário**.
- A tela é o produto. `curl` diagnostica; ele não prova experiência de usuário.

## 4. As dez regras que evitam dano

1. **Toda tabela tenant-aware tem `organization_id` + RLS.** Service role bypassa RLS — quem usa o
   admin client filtra `organization_id` à mão, de fonte confiável, **nunca do body**.
2. **`getUser()` no backend, nunca `getSession()`.**
3. **Zod em todo input externo** (body, webhook, env).
4. **`ok()` / `fail()` de `lib/api/wrappers.ts`** — nunca monte `Response` na mão, nunca deixe
   `throw` cru na borda.
5. **Mudança de schema = migration versionada + apêndice idempotente no baseline + linha no
   MANIFEST.** Os três juntos, ou o self-hoster não recebe.
6. **Trigger Postgres nunca faz HTTP** — emite linha em `event_log`, o worker dispara o efeito.
7. **API key nunca em query string**; bearer no banco só como hash SHA256.
8. **`console.log` é proibido** em código merged — use `lib/logger.ts`.
9. **Tela nova precisa de porta** em `lib/navigation/registry.ts`: existir e ser alcançável são
   coisas diferentes.
10. **Nunca invente regra de negócio, SLA ou número.** Se não está escrito, diga que não está e
    pergunte.

## 5. Antes de começar

```bash
git fetch origin && git merge origin/main   # branch atrasada é a causa nº 1 de retrabalho
pnpm install
```

Nunca use `reset --hard` ou force push para "atualizar" uma branch, e nunca toque em worktree sujo
que não é seu.

## 6. Antes de dizer "pronto"

```bash
pnpm gov:verify   # typecheck + lint + lint:channels + test:unit
```

Verde aqui **não** é prova completa: `gov:verify` não roda `test:db` (schema/RLS), `test:e2e` (UI)
nem `test:shell` (kit de instalação). Rode o que sua mudança exige e cumpra a Definition of Done de
[`CLAUDE.md`](../CLAUDE.md) — ela é a régua de conclusão, item por item.
