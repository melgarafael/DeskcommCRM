-- manifest: **Fila Pessoal no Inbox (spec 33): o contato pessoal ganha DONO — `contacts.personal_owner_user_id`.** A spec 21 escondeu o pessoal da operação e, junto, o tornou inalcançável (sem envio, sem lista, 404 até por link direto). A doutrina revisada separa as duas coisas: esconder da operação continua valendo; tornar inalcançável, não — quem fecha o canal é o titular (`is_blocked`), nunca uma decisão interna. O dono da marca é o que permite a aba Pessoal existir sem publicar a conversa de família de um gerente para os outros: a aba lista o pessoal de quem marcou, e o papel `admin` enxerga todos para que nenhum contato fique sem ninguém que possa responder. Idempotente: `add column if not exists`, `create index if not exists`. Apêndice espelhado no fim do `baseline.sql`; `MANIFEST.md` é histórico e não recebe linha.

-- 9238 — contato pessoal com dono (spec 33, fatia 1).
--
-- `personal_owner_user_id` responde "de quem é este pessoal?". Sem ela, a aba
-- Pessoal só poderia listar TODO o pessoal da organização para qualquer gerente
-- — exatamente o vazamento que a spec 21 existia para impedir.
--
-- `on delete set null` de propósito: usuário removido não pode apagar contato
-- nem histórico. A linha fica órfã (`null`) e volta a aparecer para o `admin`,
-- que é a garantia de que nenhum contato fica sem ninguém que possa responder.
--
-- Preenchida SÓ pela rota de marcar (`POST /api/v1/contacts/[id]/personal`), com
-- o usuário autenticado que marcou; `DELETE` da mesma rota zera. Quem marcou e
-- quando continua em auditoria + timeline (spec 21 §3.6) — esta coluna é posse,
-- não trilha.
--
-- Medido no CI pelo invariante ao lado
-- (`tests/invariants/fila-pessoal-dono.test.ts`): coluna existe, índice parcial
-- existe, `null` continua aceito (legado) e o default é nulo.

alter table public.contacts
  add column if not exists personal_owner_user_id uuid
    references auth.users(id) on delete set null;

comment on column public.contacts.personal_owner_user_id is
  'Dono da marca pessoal (spec 33): quem marcou o contato. Escopa a aba Pessoal do Inbox — cada pessoa vê o próprio, e o papel admin vê todos para que nenhum contato fique inalcançável. Nulo = legado anterior à 9238 ou usuário removido. Zera no desmarcar; quem/quando fica em auditoria + timeline.';

create index if not exists idx_contacts_org_personal_dono
  on public.contacts (organization_id, personal_owner_user_id)
  where (is_personal = true);
