-- OS DESTINOS INTERNOS QUE O DONO DA INSTALAÇÃO AUTORIZA — decisão 22-d, #1004.
--
-- ── O que esta coluna resolve ───────────────────────────────────────────────
--
-- A saída da instalação para a rede de dentro é recusada por padrão
-- (`lib/automation/outbound-url.ts` + `outbound-ip.ts`, PR #964). A decisão
-- 22-d dá a válvula a quem PAGA a máquina: ele pode autorizar endereços
-- internos para os destinos que a PRÓPRIA INSTALAÇÃO configura (hoje, o
-- serviço de transcrição). A organização, sozinha, continua sem poder.
--
-- A primeira versão disto (PR #1055) guardava a lista só no `.env`. A decisão
-- diz, com as palavras do dono, que o lugar onde ele controla deve ser visível
-- e fácil de acessar — então a lista mora aqui, é editada em
-- `/admin/destinos-internos`, e o `.env` (`IA_DESTINOS_INTERNOS_PERMITIDOS`)
-- vira só o PISO, no mesmo desenho da política de cadastro (0253).
--
-- ── Por que `null` e não lista vazia como default ───────────────────────────
--
-- `null` = a tela nunca foi usada, e vale o `.env`. `'{}'` = o dono esvaziou a
-- lista pela tela, e aí nada passa mesmo que o `.env` declare algo. Os dois
-- estados são diferentes e precisam ser representáveis: sem essa distinção, o
-- dono não teria como revogar pela tela o que o `.env` autorizou.
--
-- ── O que ela guarda ────────────────────────────────────────────────────────
--
-- IPv4 exatos e faixas CIDR IPv4, já validados por quem grava
-- (`app/actions/settings/updateDestinosInternos.ts`). Não guarda NOME: a
-- decisão compara o endereço que o nome RESOLVE com a lista (item 4 da
-- #1004), então um nome na lista não autorizaria nada e só daria a impressão
-- de que autoriza.
--
-- Sem backfill, sem dado tocado, sem função nova. A tabela já é só do
-- servidor (RLS sem policies, `revoke all` de anon/authenticated na 0253);
-- coluna nova herda isso.

alter table public.platform_settings
  add column if not exists internal_destinations text[];

comment on column public.platform_settings.internal_destinations is
  'IPv4 e faixas CIDR IPv4 que a INSTALAÇÃO pode alcançar mesmo sendo rede interna — só para destinos configurados pela instalação, nunca por uma organização (decisão 22-d, #1004). null = nunca configurado pela tela: vale IA_DESTINOS_INTERNOS_PERMITIDOS do .env. Array vazio = nada autorizado. Ver lib/automation/destinos-internos-autorizados.ts.';

notify pgrst, 'reload schema';
