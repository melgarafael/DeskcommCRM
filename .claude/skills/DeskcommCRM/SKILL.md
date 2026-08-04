---
name: DeskcommCRM
description: Doutrina de código do DeskcommCRM — multi-tenancy com RLS, tripla de migration, restrição de canal, eixo self-host. USE SEMPRE ao escrever ou revisar código neste repositório, e antes de responder pergunta sobre convenção, schema, tenancy, WhatsApp/WAHA, instalador ou Definition of Done. É o ponteiro para a doutrina viva do repo; não substitui ler o CLAUDE.md.
---

# DeskcommCRM — doutrina de código

> A fonte da verdade é o `CLAUDE.md` da raiz, lido do `origin/main` e não de um resumo. Esta skill
> existe para te fazer abri-lo na hora certa e para carregar as três regras que mais custam caro
> quando esquecidas.

## 1. Leia antes de escrever

| arquivo | quando |
|---|---|
| `CLAUDE.md` | **sempre**, antes de qualquer código — contém a Definition of Done, que muda |
| `VISION.md` | antes de decidir escopo, ou de dizer não a uma feature |
| `docs/doctrine/` | ao mexer em canal, agente, ou peça que se conecte a outra |
| `ARCHITECTURE.md` | para a visão de uma página |

**Não confie em resumo de doutrina — nem neste arquivo.** A Definition of Done já foi de 13 para 14
itens; cópia congelada ensina a regra de ontem. Abra o `CLAUDE.md`.

## 2. As três que mais custam

**Multi-tenancy.** Toda tabela tenant-aware leva `organization_id uuid not null` e RLS com policy
`tenant_isolation_<tabela>_all` via `fn_user_org_ids()`. Service role bypassa RLS — handler que o usa
filtra `organization_id` **manualmente**, resolvido de fonte confiável (cookie, JWT, segredo de
webhook, token de path), **nunca do body**. No backend é sempre `getUser()`, nunca `getSession()`.

**Schema sai em tripla.** Arquivo em `supabase/migrations/`, apêndice **idempotente** no
`supabase/baseline.sql`, e linha no `MANIFEST.md`. O kit self-host aplica **só o baseline** — o que
não chega lá não chega em quem instalou numa VPS, que é o cliente que paga. Constraint nova exige
corrigir os dados **antes**, senão o `update.sh` do clone quebra.

**Nenhuma feature nomeia um provider.** Provider vive em `lib/channels/`. `pnpm lint:channels` é
catraca com lista de dívida: arquivo novo sujo reprova — e arquivo que ficou limpo e não saiu da
lista **também** reprova.

## 3. O eixo que não é técnico

A monetização é **self-host em VPS**, não assinatura: quem instala é o cliente. Então uma mudança
pode ser tecnicamente impecável e ainda assim ser recusada — env var nova sem default quebra
instalação fresca, dependência de serviço pago obrigatório quebra o modelo, e a pior de todas é a
**falha-em-verde**: a sonda que declara sucesso medindo caminho diferente do que o usuário usa. Num
produto que a pessoa instala sozinha, ela não descobre que está quebrado.

## 4. Antes de dizer "pronto"

Verde de teste não é prova de comportamento. Sabote a linha que você corrigiu e confirme que a suíte
fica **vermelha** — teste que não reprova não guarda nada. E declare o que **não** mediu: é o campo
que separa medição de relato.

## Não-objetivos

Não lista comandos de fluxo — não existem `/fix-bug` nem `/add-module` neste repo. Não descreve
estrutura de pastas nem convenção de nome de arquivo: a versão anterior deste arquivo era gerada
automaticamente e ensinava `snake_case` com imports relativos, quando o repo usa kebab-case com
alias `@/`. Detalhe correto mora no `CLAUDE.md`, que está atualizado — o que este arquivo não pode
prometer.
