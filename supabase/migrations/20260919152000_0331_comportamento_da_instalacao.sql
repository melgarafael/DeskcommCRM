-- 0331 — o COMPORTAMENTO da instalação ganha coluna e tela (issue #1034).
--
-- ─── O que a issue pede ─────────────────────────────────────────────────────
-- Quatro decisões que valem para a INSTALAÇÃO inteira só se tomam hoje por SSH,
-- editando o arquivo de ambiente. Elas ganham tela em `/admin/sistema` e viram
-- colunas aqui: são chaves de quem opera o servidor, não de um tenant.
--
--   arquivo de ambiente                  ->  coluna
--   AI_BUDGET_ENFORCEMENT                ->  orcamento_de_ia
--   WAHA_WEBHOOK_REQUIRE_SIGNATURE       ->  exigir_assinatura_no_webhook
--   DISCLOSURE_MODE                      ->  divulgacao_de_pagamento
--   PROMISE_SEMANTIC_ENABLED             ->  promessa_semantica
--
-- ─── Por que as quatro NASCEM NULAS e sem default ───────────────────────────
-- `null` significa "esta instalação nunca opinou", e quem responde é o arquivo
-- de ambiente — o PISO. É isso que faz esta migration não mudar comportaMENTO
-- nenhum: quem não abrir a tela segue exatamente como estava, com o `.env`
-- valendo. Um `default` já nasceria vencendo o `.env`, e a instalação que hoje
-- declara `AI_BUDGET_ENFORCEMENT=off` passaria a bloquear gasto no primeiro
-- deploy — mudança de comportamento que ninguém pediu, num kill switch.
--
-- Mesmo desenho da 0253 (política de cadastro): linha única `id = 1`, RLS
-- ligada SEM policy, leitura e escrita só do servidor. A AUSÊNCIA da linha
-- também é resposta ("não opinou"), então esta migration não semeia linha
-- nenhuma: quem cria a linha é o primeiro salvamento, que é `upsert` (ver
-- `lib/instalacao/comportamento-servidor.ts`).
--
-- As CHECKs são escritas com `is null or ...`: recusam valor que ninguém
-- reconhece, e não obrigam a instalação a ter opinião.

alter table public.platform_settings
  add column if not exists orcamento_de_ia              text,
  add column if not exists exigir_assinatura_no_webhook boolean,
  add column if not exists divulgacao_de_pagamento      text,
  add column if not exists promessa_semantica           boolean;

alter table public.platform_settings
  drop constraint if exists platform_settings_orcamento_de_ia;
alter table public.platform_settings
  add constraint platform_settings_orcamento_de_ia
  check (orcamento_de_ia is null or orcamento_de_ia in ('on', 'avisar', 'off'));

alter table public.platform_settings
  drop constraint if exists platform_settings_divulgacao_de_pagamento;
alter table public.platform_settings
  add constraint platform_settings_divulgacao_de_pagamento
  check (divulgacao_de_pagamento is null or divulgacao_de_pagamento in ('inject', 'veto'));

comment on column public.platform_settings.orcamento_de_ia is
  'on = a IA respeita o teto de gasto que cada organização escolheu (default do produto, e o que o .env declara). avisar = a IA responde e apenas avisa quem opera. off = sem proteção de gasto. null = a instalação não opinou; vale AI_BUDGET_ENFORCEMENT do arquivo de ambiente. Só AFROUXA o que a organização escolheu: nunca liga proteção que a empresa não pediu.';

comment on column public.platform_settings.exigir_assinatura_no_webhook is
  'true = toda entrega de webhook do canal precisa vir assinada com o segredo da sessão; sem assinatura (ou com assinatura errada) a entrega é recusada. null = a instalação não opinou; vale WAHA_WEBHOOK_REQUIRE_SIGNATURE do arquivo de ambiente (default do produto: false).';

comment on column public.platform_settings.divulgacao_de_pagamento is
  'inject = o texto de divulgação de pagamento entra na primeira mensagem. veto = o envio sem esse texto é bloqueado e devolvido ao modelo com a razão, para ele reescrever. null = a instalação não opinou; vale DISCLOSURE_MODE do arquivo de ambiente (default do produto: inject).';

comment on column public.platform_settings.promessa_semantica is
  'true = cada envio passa por uma conferência de modelo antes de sair, para não prometer o que a empresa não cumpre (custa uma chamada de modelo por envio). null = a instalação não opinou; vale PROMISE_SEMANTIC_ENABLED do arquivo de ambiente (default do produto: true).';

comment on table public.platform_settings is
  'Configuração da INSTALAÇÃO (não do tenant) — linha única id=1. Hoje a política de cadastro e o COMPORTAMENTO (orçamento de IA, assinatura de webhook, divulgação de pagamento, conferência de promessa). Coluna nula = a instalação não opinou, e quem responde é o arquivo de ambiente. Lida/escrita apenas server-side (service_role); a ausência da linha significa o default. Ver lib/auth/politica-de-cadastro.ts e lib/instalacao/comportamento.ts.';

notify pgrst, 'reload schema';
