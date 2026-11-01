-- manifest: **Contato nasce com TIPO — `contacts.contact_type` com default `'cliente'`, CHECK `cliente|fornecedor` e índice parcial dos fornecedores (issue 3005, fatia 1).** A marca é coluna nova de propósito: reutilizar `is_personal` trancaria a conversa (aquela marca VETA todo envio, e a issue diz o oposto do fornecedor: "continua recebendo mensagem normalmente"), e `is_blocked` é descadastro (LGPD), não papel. Dois tipos não cabem num booleano. Nenhuma coluna de quem/quando: auditoria + timeline já carregam isso (mesma decisão da 0563). O painel próprio do fornecedor, o executivo de contas e o vínculo contato-contato NÃO entram aqui — são as fatias seguintes (#2791). Idempotente: `add column if not exists`, `drop constraint if exists` + `add`, `create index if not exists`. Apêndice espelhado no fim do `baseline.sql`; `MANIFEST.md` é histórico e não recebe linha.

-- 0763 — tipo de contato: cliente ou fornecedor (issue 3005, fatia 1).
--
-- `contact_type text DEFAULT 'cliente' NOT NULL`: o contato NASCE cliente sem
-- ninguém informar — o default é a decisão 1 da issue ("Cliente (padrão)") —, e
-- só vira fornecedor por gesto explícito na ficha (`EditContactDialog`) ou pela
-- API (`PATCH /api/v1/contacts/[id]`, `contactPatchSchema`).
--
-- POR QUE COLUNA NOVA, e não reusar o que já existe:
--
--   * `contacts.is_personal` (0563) esconde o contato da operação e VETA TODO
--     ENVIO — `readStopFlags` em `lib/agent-engine/guardrails/before-send.ts`
--     põe `is_personal` no predicado de stop. A issue 3005 pede o OPOSTO para
--     o fornecedor ("continua recebendo mensagem normalmente"): reusar a marca
--     trancaria exatamente a conversa que a equipe precisa ter.
--   * `contacts.is_blocked` é descadastro (LGPD): a semântica é saída, não papel.
--   * `ai_opt_out` é a marca permanente de atendimento humano (0624) — de novo
--     um veto, de novo sobre a IA, e nada a ver com o papel do contato.
--   * Dois papéis não cabem num booleano: o dia em que aparecer um terceiro
--     (transportadora, guia), o booleano não tem para onde crescer.
--
-- O CHECK é a régua dos DOIS lados: o produto só conhece estas duas palavras
-- (`contactTypeSchema` em `lib/schemas/contacts.ts`), e a coluna não pode
-- guardar uma terceira que nenhuma tela sabe desenhar.
--
-- O índice parcial de `fornecedor` responde à pergunta que o produto faz ("quem
-- são os fornecedores desta organização?"): cliente é o default e a maioria,
-- então indexá-lo seria um índice que a busca por fornecedor não usa — a mesma
-- régua de `idx_contacts_org_personal`/`idx_contacts_org_ai_opt_out`.
--
-- Medido no CI pelo invariante ao lado
-- (`tests/invariants/contato-tipo-coluna.test.ts`): coluna existe com default
-- 'cliente' NOT NULL, contato novo nasce cliente sem informar, índice parcial
-- existe, CHECK aceita `fornecedor` e recusa um terceiro valor, e contato
-- fornecedor NÃO entra no predicado de stop do envio.

alter table public.contacts
  add column if not exists contact_type text default 'cliente' not null;

comment on column public.contacts.contact_type is
  'Tipo do contato (issue 3005): cliente (padrão) ou fornecedor. Fornecedor conversa normalmente — ao contrário de is_personal, NÃO veta envio; o que muda é o painel/lista de campos (fatias seguintes). Quem mudou/quando fica em auditoria + timeline, nunca aqui.';

alter table public.contacts
  drop constraint if exists contacts_contact_type_check;

alter table public.contacts
  add constraint contacts_contact_type_check
    check (contact_type in ('cliente', 'fornecedor'));

create index if not exists idx_contacts_org_fornecedor
  on public.contacts (organization_id)
  where (contact_type = 'fornecedor');

notify pgrst, 'reload schema';
