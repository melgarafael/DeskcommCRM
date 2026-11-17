-- manifest: **A aba Pessoal ganha DONO (issue #4434): `contacts.personal_owner_user_id`.** A spec 21 escondeu o contato pessoal da operação e, no mesmo gesto, o tornou inalcançável para TODOS — inclusive para quem marcou. O recorte aprovado na #4434 separa as duas coisas: esconder da operação continua valendo (fora de IA, automação, campanha, prospecção, funil, RAG, métricas, webhooks, busca da equipe e MCP), mas o dono da marca lê e responde o SEU. Sem esta coluna não existe "o seu": a aba só poderia listar todo o pessoal da organização para qualquer um que abrisse. `on delete set null` de propósito — usuário removido não apaga contato nem histórico; a linha fica órfã (`null`) e segue invisível para todos, inclusive `admin`, que NÃO é exceção neste recorte: papel não dá direito ao pessoal de outra pessoa. Preenchida só pela rota de marcar (`POST /api/v1/contacts/[id]/personal`), com quem marcou; marcar contato legado sem dono ADOTA a conversa, e desmarcar zera a posse. índice parcial em `is_personal` para a consulta da aba. Aditiva e idempotente (`add column if not exists`, `create index if not exists`). Apêndice espelhado no `baseline.sql` antes da VARREDURA anon; `MANIFEST.md` é histórico e não recebe linha. Gate: `tests/unit/pessoal-com-dono.test.ts`.

-- 9360 — O CONTATO PESSOAL GANHA DONO (issue #4434).
--
-- ═══ O que faltava ═══
--
-- A 0563 criou `is_personal` e a especificação 21 fez o contato pessoal sumir de
-- TUDO: lista, busca, contagem, link direto e envio. O efeito colateral medido é
-- que quem marcou o contato como pessoal perde a conversa dentro do CRM e não
-- ganha caminho de volta — para falar com a família, precisa de outro aparelho.
--
-- A #4434 aprovou o recorte mínimo, e ele precisa de UMA pergunta que o banco
-- hoje não sabe responder: **de quem é este pessoal?** Sem a coluna, a aba só
-- teria duas saídas, e as duas erram: listar o pessoal de todo mundo (publica a
-- conversa de família de um gerente para os outros — o vazamento que a spec 21
-- existia para impedir) ou continuar sem lista nenhuma.
--
-- ═══ A régua ═══
--
--   dono da marca (`personal_owner_user_id`) → lê e responde o SEU;
--   qualquer outro, inclusive `admin` e `manager` → não lê, não abre por link
--     direto e não envia;
--   sem dono (marcado antes desta migration, ou dono removido) → invisível para
--     todos, até alguém marcar de novo e adotar a conversa.
--
-- `on delete set null`: usuário removido não pode apagar contato nem histórico —
-- a linha fica órfã e volta para o conjunto invisível, que é a leitura segura do
-- recorte (nunca "o admin assume", que é exatamente a exceção por papel que a
-- issue proíbe).
--
-- Quem marcou e quando continua em auditoria + timeline (spec 21 §3.6); esta
-- coluna é POSSE, não trilha. Não há backfill: contato pessoal anterior a esta
-- migration fica com dono nulo, e é o que o recorte pede.

alter table public.contacts
  add column if not exists personal_owner_user_id uuid
    references auth.users(id) on delete set null;

comment on column public.contacts.personal_owner_user_id is
  'Dono da marca pessoal (issue #4434): o usuário que marcou o contato. Escopa a aba Pessoal do Inbox — cada pessoa lê e responde o próprio, e papel nenhum (nem admin, nem manager) dá acesso ao pessoal de outra pessoa. Nulo = marcado antes desta migration, ou dono removido: invisível para todos até alguém marcar de novo e adotar. Zera no desmarcar; quem/quando fica em auditoria + timeline.';

-- O comentário da 0563 dizia "escondido da operação e inutilizado para envio", e
-- a segunda metade deixou de ser verdade: o dono responde. Atualizar aqui é o que
-- impede a ficha de continuar descrevendo uma regra que não existe mais.
comment on column public.contacts.is_personal is
  'Contato de vida pessoal (spec 21, com dono desde a #4434): escondido da operação (IA, automação, campanha, prospecção, funil, RAG, métricas, busca da equipe, MCP) e alcançável só pelo dono da marca (`personal_owner_user_id`), que lê e responde. Gerente e admin NÃO são exceção. Só gerente/dono marca e desmarca, pela rota personal; quem/quando fica em auditoria + timeline, nunca aqui.';

-- Índice PARCIAL: a aba Pessoal pergunta sempre por `is_personal = true` e por
-- dono. A esmagadora maioria dos contatos não é pessoal, então o índice só vale
-- a pena para as linhas que são — e é o mesmo desenho de `idx_contacts_org_personal`.
create index if not exists idx_contacts_org_personal_dono
  on public.contacts (organization_id, personal_owner_user_id)
  where (is_personal = true);
