-- manifest: **O nome de cada pessoa da equipe sai do banco numa consulta só (#4326, fatia 3).** `fn_nomes_dos_membros(p_org, p_ids)` devolve `(user_id, full_name, email)` juntando `user_organizations` com `auth.users` pela MESMA regra de `membrosDaOrganizacao` (lib/users/nome-do-atendente.ts) — inclusive quem saiu da equipe, porque o nome segue no histórico que a pessoa escreveu; id de outra organização volta vazio e id inexistente não inventa linha; id repetido na lista não duplica linha (a PK de `auth.users` fecha isso). O nome é lido de `auth.users.raw_user_meta_data ->> 'full_name'`, o mesmo campo que `fn_conversation_assign` já grava em `assigned_to_user_name` — sem trim e sem `nullif`, para o mapa sair idêntico ao que `auth.admin.getUserById` devolvia (inclusive o `full_name` vazio continuar vazio, e não virar nulo). `stable`, `security definer`, `set search_path = public`, EXECUTE revogado de `public`, `anon` e `authenticated` e concedido só a `service_role`: nenhuma sessão de usuário lê o cadastro de `auth.users` por esta porta, e as rotas continuam passando o admin client de fonte confiável.
--
-- 9314 — os nomes da equipe numa consulta só (issue #4326, fatia 3).
--
-- ═══ O DEFEITO MEDIDO ═══
--
-- `nomesDosAtendentesCom` (lib/users/nome-do-atendente.ts) já sabia QUEM é da
-- equipe numa consulta a `user_organizations`, mas buscava o NOME de cada pessoa
-- com uma chamada HTTP ao endpoint admin do GoTrue
-- (`auth.admin.getUserById`) — uma por id distinto. Uma página com 50 donos
-- distintos custava ~1,2s medidos contra o GoTrue local, e N idas de rede para
-- montar um mapa de N strings que o banco já tem.
--
-- ═══ POR QUE NO BANCO, E POR QUE DEFINER ═══
--
-- O nome mora em `auth.users.raw_user_meta_data ->> 'full_name'`, schema que
-- nenhum client do produto lê pela REST: é o mesmo campo que `fn_conversation_
-- assign` já copia para `assigned_to_user_name` (apêndice do baseline). Ler dali
-- exige privilégio de dono — daí `security definer` — e a função é chamável SÓ
-- por `service_role`. A regra de vínculo é a de `membrosDaOrganizacao`, copiada
-- aqui e não reinventada: `organization_id` E `user_id` na MESMA linha de
-- `user_organizations`, sem filtro de `revoked_at`. Quem saiu da equipe mantém o
-- nome no histórico; id que só tem vínculo com OUTRA organização não ganha nome
-- (a comparação é com `p_org`, nunca com o que o chamador disse que era).
--
-- ═══ O QUE A FUNÇÃO NÃO FAZ ═══
--
-- Não pagina, não ordena (o chamador monta mapa por id), não faz HTTP, não lê
-- `user_metadata` inteiro nem telefone. Devolve `email` porque o leitor de
-- métricas por atendente já pede e-mail hoje; `full_name` é o mínimo do resto.
-- Id inexistente em `auth.users`, ou sem vínculo com `p_org`, simplesmente não
-- tem linha — a ausência é a resposta, e quem chama já trata o buraco do mapa.

create or replace function public.fn_nomes_dos_membros(
  p_org uuid,
  p_ids uuid[]
) returns table (
  user_id uuid,
  full_name text,
  email text
)
language sql
stable
security definer
set search_path = public
as $$
  select u.id as user_id,
         u.raw_user_meta_data ->> 'full_name' as full_name,
         u.email::text as email
    from auth.users u
   where u.id = any (coalesce(p_ids, '{}'::uuid[]))
     and exists (
       select 1
         from public.user_organizations m
        where m.organization_id = p_org
          and m.user_id = u.id
     )
$$;

revoke all on function public.fn_nomes_dos_membros(uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.fn_nomes_dos_membros(uuid,uuid[]) to service_role;

comment on function public.fn_nomes_dos_membros(uuid,uuid[]) is
  'Nome e e-mail dos membros (inclusive desligados) de uma organização, por lista de ids: uma consulta em vez de N chamadas ao GoTrue. Só service_role (#4326, fatia 3).';
