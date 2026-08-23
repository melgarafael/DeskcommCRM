# DeskcommCRM — doutrina de código

> A fonte da verdade é o `CLAUDE.md` da raiz, lido do `origin/main` e não de um resumo. Este
> arquivo existe para te fazer abri-lo na hora certa e para carregar as três regras que mais
> custam caro quando esquecidas.

## 1. Leia antes de escrever

| arquivo | quando |
|---|---|
| `CLAUDE.md` | **sempre**, antes de qualquer código — contém a Definition of Done, que muda |
| `VISION.md` | antes de decidir escopo, ou de dizer não a uma feature |
| `docs/doctrine/` | ao mexer em canal, agente, ou peça que se conecte a outra |
| `ARCHITECTURE.md` | para a visão de uma página |

**Não confie em resumo de doutrina — nem neste arquivo.** Abra o `CLAUDE.md`.

## 2. As três que mais custam

**Multi-tenancy.** Toda tabela tenant-aware leva `organization_id uuid not null` e RLS com policy
`tenant_isolation_<tabela>_all` via `fn_user_org_ids()`. Service role bypassa RLS — handler que o
usa filtra `organization_id` **manualmente**, resolvido de fonte confiável (cookie, JWT, segredo de
webhook, token de path), **nunca do body**. No backend é sempre `getUser()`, nunca `getSession()`.

**Schema sai em tripla.** Arquivo em `supabase/migrations/`, apêndice **idempotente** no
`supabase/baseline.sql`, e linha no `MANIFEST.md`. O kit self-host aplica **só o baseline** — o que
não chega lá não chega em quem instalou numa VPS, que é o cliente que paga.

**Nenhuma feature nomeia um provider.** Provider vive em `lib/channels/`. `pnpm lint:channels` é
catraca com lista de dívida.

## 3. Convenção de arquivo — o oposto do que a versão anterior ensinava

A versão anterior deste arquivo era gerada automaticamente por análise de repositório e ensinava
`snake_case` para nome de arquivo e imports relativos. **O repo usa o oposto**: `kebab-case` para
nome de arquivo (`user-profile.ts`, não `user_profile.ts`) e o alias `@/` para import
(`import { getUser } from "@/lib/auth/get-user"`, não `./user_utils`). Nenhum comando de fluxo
(`/fix-bug`, `/add-module`) existe neste repo — não invente um.

## 4. Antes de dizer "pronto"

Verde de teste não é prova de comportamento. Sabote a linha que você corrigiu e confirme que a
suíte fica **vermelha**. Declare o que **não** mediu.
