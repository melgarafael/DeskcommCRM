-- manifest: usuário criado pelo admin com senha própria — `user_organizations.senha_provisoria` marca o vínculo que precisa trocar a senha no primeiro acesso; aditiva, toda linha anterior (convite inclusive) nasce `false`.
-- ═══════════════════════════════════════════════════════════════════════════
-- 9227 — Criar a pessoa sem convite: senha provisória no vínculo.
--
-- Até aqui o Deskcomm só sabia CONVIDAR: quem administra digita o e-mail, o
-- convite depende de SMTP e caixa postal real, e o convidado é que define a
-- senha. Para boa parte das instalações isso não fecha — e não havia caminho
-- nenhum para "cria a pessoa com esta senha".
--
-- O sinal mora no VÍNCULO, não em `auth.users.user_metadata`: metadata do auth
-- é escrita pelo próprio usuário (`supabase.auth.updateUser({ data })`), ou
-- seja, um gate apoiado nela seria desarmável por quem é obrigado a trocar a
-- senha. A coluna é lida pelo servidor com a identidade do próprio usuário
-- (RLS de `user_organizations` já é `user_id = auth.uid()`), e só quem tem
-- service-role a escreve.
--
-- `default false` é a regra inteira para o passado: quem entrou por convite —
-- o fluxo que continua valendo — NUNCA ganha troca obrigatória.
--
-- Reaplicação: `add column if not exists`, sem constraint nova, sem índice
-- (a coluna só é lida junto da linha do vínculo que a consulta do app já traz).
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.user_organizations
  add column if not exists senha_provisoria boolean not null default false;

comment on column public.user_organizations.senha_provisoria is
  'true = a senha foi definida por quem administra e precisa ser trocada no primeiro acesso; o gate do servidor recusa /api/v1 até a troca.';

-- Coluna nova só existe para o PostgREST depois do reload do cache de schema.
notify pgrst, 'reload schema';
