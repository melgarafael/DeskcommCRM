# Cobrança do revendedor — especificação

- **Status:** aprovada pelo dono do produto em 29/09/2026 (desenho e as 14 decisões D-1…D-14, todas pela recomendação).
- **Base de leitura:** toda referência `arquivo:linha` foi medida na `main` em `76355d4b9`. Ao implementar cada PR, reconfira a linha no SHA do dia: o conteúdo citado é a autoridade, o número da linha envelhece.
- **Escopo:** a capacidade de o dono de uma instalação transformá-la num SaaS próprio e cobrar as empresas que atende (Stripe e Asaas na 1ª entrega), mais a suspensão de organização que de fato suspende, que é pré-requisito dela e conserta um defeito atual.
- **Entrega:** 7 PRs em ordem (§14). Cada PR recebe o seu próprio plano de implementação.
- **Material para os alunos (PRs 4 e 5):** guia Coolify, `docs/saas/`, skill `deskcomm-saas` e roteiros de aula — escritos **depois** do código, descrevendo o que existe.

## Decisões do dono (29/09/2026)

| # | Pergunta | Decisão | Por quê |
|---|---|---|---|
| D-1 | A cobrança entra como capacidade do NÚCLEO, com as duas tabelas (planos e assinaturas) vazias no banco de toda instalação, inclusive de quem nunca liga a cobrança? Isso revisa, só para este caso, a condição 2 da ADR-0002 ('quem não usa o módulo não carrega as tabelas dele'). | **Sim, núcleo, registrado na ADR-0004 como exceção explícita à condição 2.** | As travas de pessoas e de números, e o teste grátis automático, precisam morar nas tabelas centrais (membros, canais, empresas). A regra da ADR-0002 proíbe que o módulo instalável mexa nessas tabelas. O custo são duas tabelas vazias; a alternativa põe código dinâmico no caminho de todo convite e toda conexão de número. |
| D-2 | O rótulo de plano antigo (standard/pro/enterprise), que hoje aparece no painel de cada empresa, deve ser apagado de todas as instalações? | **Não apagar. Com a cobrança desligada, nada muda; com ela ligada, o rótulo vira só leitura, como 'Rótulo antigo'.** | Apagar some com um dado que o operador via, e pela regra de versões isso exige uma versão 'major' com aviso de ação. Mantê-lo custa nada e cumpre a promessa de que quem não usa a cobrança não vê diferença. |
| D-3 | Quando o cliente troca de plano, o plano novo vale na hora ou só na próxima cobrança paga? | **Só na próxima cobrança paga, nesta primeira entrega, tanto para subir quanto para descer. Upgrade imediato cobrando a diferença fica para depois, se os revendedores pedirem.** | Se vale na hora e o preço só muda no ciclo seguinte, o cliente sobe no dia 1, usa o plano caro (inclusive a IA paga pelo revendedor) e desce no dia 28, pagando sempre o barato. Cobrar a diferença na hora é mais código em cada provedor. |
| D-4 | Mudar para um plano menor do que o uso atual (ex.: tem 5 pessoas e o plano novo permite 3): bloquear ou deixar e só impedir de crescer? | **Bloquear na nossa tela, com a lista do que remover. Se o uso crescer entre o pedido e a virada do ciclo, o plano novo entra e só impede crescer.** | Permitir cria o estado 'tenho 5 de 3 e não consigo convidar' sem o cliente entender. Bloquear é uma mensagem clara. |
| D-5 | Quanto tempo entre o vencimento e a suspensão? | **7 dias por padrão, ajustável de 5 a 30 em /admin/cobranca. Ninguém é suspenso sem um aviso final da dívida atual enviado pelo menos 48 horas antes.** | Boleto e Pix levam até 1 dia útil para compensar, e um fim de semana entra no meio. Abaixo de 5 dias, quem pagou no vencimento seria suspenso. |
| D-6 | O dono pode reativar à mão uma empresa suspensa por falta de pagamento, com a dívida ainda aberta? | **Só por 'Dar prazo até DD/MM' (máximo 60 dias, reativa na hora) ou 'Tornar isenta'. O botão genérico 'Reativar' fica só para a suspensão administrativa.** | Sem prazo, a régua suspenderia de novo na hora seguinte e o dono acharia que o botão não funciona. Proibir tiraria dele a negociação com o cliente. |
| D-7 | Ao publicar (trocar a chave de teste pela de produção), o que acontece com as empresas que assinaram em modo de teste? | **Voltam para teste grátis com os dias do plano, com aviso na tela antes de confirmar.** | As assinaturas de teste não existem na conta de produção. Suspender puniria quem testou; manter como paga daria acesso grátis a quem pagou com cartão de teste. |
| D-8 | A instalação pode aceitar Stripe e Asaas ao mesmo tempo para novas assinaturas? | **Não. Um provedor escolhido para assinaturas novas; as antigas seguem no provedor em que nasceram, e a chave de um provedor com assinaturas vivas não pode ser apagada.** | É uma escolha a menos para o revendedor leigo e para o cliente final. Trocar de provedor não quebra quem já assinou. |
| D-9 | O teto de IA do plano conta o gasto do mês inteiro (inclusive o de empresas que usam chave de IA própria) e o interruptor de emergência de orçamento de IA também o desliga? | **Conta o mês inteiro, mas só bloqueia chamadas feitas com a chave de IA da instalação. O interruptor de emergência desliga também o teto do plano.** | Separar o gasto por chave exige mudar a medição única de gasto de IA. O erro do atalho só aparece em empresa que usa as duas chaves, e é a favor do revendedor. O teto protege o bolso do dono, então o interruptor único dele deve valer para os dois. |
| D-10 | Convites ainda não aceitos contam como pessoa no limite do plano? | **Não. Só membros ativos contam. Ao convidar com o limite já cheio, a tela avisa antes de mandar o e-mail; a trava de verdade é no aceite.** | O convite pendente fica guardado com prazo (`team_invites.expires_at`, `baseline.sql:23688-23700`, migration 0238), mas contá-lo prenderia vagas por convites esquecidos até expirarem ou serem revogados. |
| D-11 | As páginas públicas de anúncio e o link de rastreio continuam funcionando com a empresa suspensa? | **Sim.** | São entrada, sem custo para o revendedor: a mensagem chega e fica gravada, mas nada responde. Cortá-las desperdiça a verba de anúncio do cliente final durante uma compensação de boleto. |
| D-12 | Membros de uma empresa suspensa podem continuar gravando dados de negócio (contatos, notas) por acesso técnico direto ao banco, fora das telas? | **Sim, nesta entrega. Telas, API, token e MCP ficam barrados, e nada que custe dinheiro ou saia para fora funciona. O estado da empresa e os limites já estão travados no banco.** | Fechar esse acesso exige mexer na regra que protege todas as tabelas, e ela também sustenta a LGPD e a entrada de mensagens. É o maior raio de mudança do desenho, para um caminho que o cliente leigo não usa e que não custa nada ao revendedor. |
| D-13 | Durante o teste grátis, o cliente pode escolher qualquer plano (e já usar o limite de IA do plano maior) ou fica no plano padrão até pagar? | **Pode escolher qualquer plano, com a troca valendo na hora durante o teste. O dono controla o risco pela duração do teste e pelo cadastro com aprovação.** | Testar o plano que vai comprar é o que o cliente espera. Travar no padrão exige uma regra a mais e uma explicação a mais na tela. O custo máximo é a IA de um teste, que o dono limita pelos dias. |
| D-14 | Quem cancela mantém o acesso até o fim do período já pago, sem reembolso proporcional? | **Sim. Acesso até o fim do período pago e nenhum reembolso automático. Estorno, se houver, é feito pelo dono no painel do provedor.** | É o padrão de mercado e o que os dois provedores fazem sem configuração. Reembolso proporcional exigiria cálculo e estorno por provedor. |

Decisão anterior, da mesma sessão: caminho **B** — a capacidade entra no núcleo, desligada por padrão, para que quem instala receba atualizações pelo `update.sh` (fork ou prompts que editam o código perderiam a cobrança na primeira atualização, porque a VPS baixa imagem pronta). Provedores da 1ª entrega: **Stripe e Asaas** (Stripe BR não faz Pix recorrente nem emite nota; o Asaas faz os dois).

---

## 1. Visão e fronteiras

### 1.1 O que é
É o **terceiro eixo** de dinheiro do produto:

- **Eixo 1:** o mantenedor não vende assinatura (`VISION.md:61-62`).
- **Eixo 2:** o operador de agentes cobra retainer por cliente operado (`docs/doctrine/operacao-de-agentes.md:24-33`).
- **Eixo 3 (novo):** o **dono de uma instalação** (platform admin) cobra as **empresas da própria instalação**, o que `docs/white-label.md:5-7` já autoriza. Ele cria planos; cada empresa nova ganha teste grátis, paga por checkout hospedado (Stripe ou Asaas), é avisada quando atrasa, é suspensa depois de uma tolerância e volta sozinha quando paga.

### 1.2 Fronteiras duras

**Capacidade do NÚCLEO com chave da instalação, desligada por padrão.** Não é "módulo de tabela" da ADR-0002 (ver §14, PR 0, e decisão D-1).
- Mecanismo: a flag `MODULO_COBRANCA` em `platform_config`, lida por `lib/instalacao/modulos.ts` (só `ligado` liga; falha fechada: `modulos.ts:1-27, 101, 164`), no mesmo trilho de `MODULOS_OPCIONAIS_POR_FLAG` (`modulos.ts:70`). O interruptor fica em `/admin/sistema`.
- As duas tabelas (`cobranca_planos`, `cobranca_assinaturas`) vão para o baseline de toda instalação, vazias. Motivo: os gatilhos de limite e de trial moram em tabelas do núcleo (`user_organizations`, `channel_sessions`, `organizations`) e consultam as tabelas da cobrança; a D4 da ADR-0002 (`docs/adr/0002-tabelas-de-modulo-num-banco-so.md:93-120`) reprova provisionadora cujo corpo toque tabela de fora do módulo, e o precedente de "núcleo pela tripla de sempre" é o caixa (`0002…:179`).
- Não é extensão de pacote: a lista fechada de capacidades exclui cobrança (`docs/doctrine/extensoes.md:56-62`; a régua núcleo × extensão está em `:21-38`).
- Com a chave desligada:
  - rotas de cobrança e webhook respondem 404;
  - `/admin/cobranca` some do menu admin;
  - gatilhos de limite devolvem "sem limite"; o cron sai sem auditar;
  - **nada do que já existe muda**: o campo "Plano" do novo tenant, o badge `settings.plan`, a tela `/app/settings/billing` e o menu seguem idênticos; a capacidade **não** aparece na tela "Recursos opcionais" da empresa (§9).
- O self-hoster de empresa única vê só um interruptor a mais em `/admin/sistema`.

**Empresa sem linha em `cobranca_assinaturas` é isenta** de cobrança, limite e régua. Cobre de uma vez: a org do dono (o `install.sh` a cria com a chave desligada, `hostgator-setup-kit/install.sh:2099`), toda org que existia antes de ligar, e quem o dono isentar. Não há estado `isenta` nem `fn_org_do_dono`.

**A PR 1 (suspensão que suspende) não depende da chave.** Conserta a suspensão administrativa que já existe e hoje só tira a pessoa da tela.

**O provedor é insumo, não fonte de regra.** Trial, régua e limites moram no nosso banco. O provedor responde: "há assinatura viva e paga?", "está devendo?", "foi cancelada?".

**Sem SDK.** `fetch` + `node:crypto`. A imagem do worker copia o repositório inteiro (`Dockerfile.worker:16-20`).

**Fora de escopo:** nota fiscal; cupom; proração e upgrade imediato cobrando diferença (decisão D-3); Pix Automático; dois provedores ativos ao mesmo tempo para checkout novo; limite de agentes, funis, contatos, mensagens, armazenamento e campanhas (ponto pronto quando pedirem: `fn_publish_ai_agent_version`, `lib/ai/agents/publish.ts:51`); moeda diferente de BRL; Mercado Pago (PR própria, mesmo contrato).

### 1.3 Semântica de "suspensa" (única, para os dois motivos)

| O quê | Com a org suspensa |
|---|---|
| Mensagem que CHEGA (WAHA, Meta, canal, captação, Nuvemshop) | Continua gravada. Nenhum webhook de entrada muda. |
| IA (texto, voz, sentimento, RAG de conversa), automações, follow-up, campanha, prospecção, webhook de saída, conversão de anúncio, lembrete | **Nada roda e nada sai.** Evento consumido como `skipped`, job vira `failed`, mensagem `queued` vira `failed`. |
| Sessão (tela, server action, API de sessão) | Redireciona para `/account-suspended` ou 403 `org_suspended`. Exceções: rotas de LGPD e de cobrança. |
| Bearer `dsk_` | 403. |
| MCP | Só a consulta de pedidos de LGPD (`crm_list_privacy_requests`) responde; as demais ferramentas voltam `org_suspended` (decisão do dono, 30/09/2026: LGPD nunca é bloqueada). |
| LGPD | Nunca bloqueada. |
| Reativação | Zero rajada; um item na Central lista as conversas que receberam mensagem, para revisão humana. |
| Landings `/api/v1/anuncios/*/[org]` e `/api/v1/rastreio/[id]` | Continuam (decisão D-11). |

---

## 2. Modelo de dados

### 2.1 `public.organizations` (existente, `supabase/baseline.sql:1747-1772`)

**Nova coluna `suspended_kind`** (PR 1):
- `add column if not exists suspended_kind text` com `check (suspended_kind in ('administrativa','cobranca'))`.
- Backfill antes do CHECK: `update organizations set suspended_kind='administrativa' where status='suspended' and suspended_kind is null`.
- **Sem CHECK de coerência** com `status`: `workers/lgpd-redact-worker.ts:376-379` troca para `redacted` sem limpar o motivo. Regra de leitura no cabeçalho de `lib/organizacao/operante.ts`: `suspended_kind` só significa algo com `status='suspended'`.

**Novo gatilho `trg_organizacao_estado_so_pelo_servidor` (PR 1)** — `BEFORE INSERT OR UPDATE ON public.organizations`, função `fn_organizacao_estado_so_pelo_servidor()` (`security invoker`, `set search_path=''`):
- se `current_user in ('authenticated','anon')`:
  - `TG_OP='INSERT'` → `raise ... using errcode='42501'`;
  - `UPDATE` que muda `status`, `suspended_kind`, `suspended_at`, `suspended_reason`, `suspended_by` ou `created_by` (`is distinct from`) → 42501.
- Por quê: `orgs_write_platform_admin` (`baseline.sql:4195`) aceita qualquer `fn_is_platform_admin()`, que ignora o scope (`baseline.sql:325-333`), e `authenticated` tem `GRANT ALL` (`baseline.sql:4686-4687`). Sem o gatilho, um `support_readonly` faria pelo PostgREST: `PATCH status='active'` numa suspensa por cobrança; troca de `suspended_kind` de `administrativa` para `cobranca` (e o próximo pagamento desfaria uma suspensão por fraude); `INSERT` de org isenta de trial.
- Não quebra nenhum escritor legítimo: todo INSERT de org usa o admin client (`lib/auth/provision.ts:107-109, 287-289`) ou definer (`fn_create_tenant_with_owner`); `updateTenant` usa o admin client (`app/actions/settings/updateTenant.ts:52`) e não toca nenhuma das colunas guardadas (`:68-81`); suspend/reactivate passam a ser funções definer (§3.1); o `lgpd-redact-worker` usa service_role.

**`settings.plan` NÃO é apagado.** Com a chave desligada, tudo segue igual: o formulário grava `settings.plan` e o badge (`components/admin/tenants/TenantOverview.tsx:98-99,118-119`) o mostra. Com a chave ligada, o formulário passa a oferecer os planos de cobrança e deixa de gravar `settings.plan`; o card de cobrança aparece e o valor antigo, se houver, vira a linha "Rótulo antigo: X" (só leitura). Apagar exigiria major (`docs/doctrine/versionamento.md:36-39`, "algo que existia sumiu") — decisão D-2.

**Colunas mortas (PR 2):** `drop column if exists ai_budget_cents, drop column if exists rate_limit_rps`. Zero leitores em app, lib, workers, components, hooks e scripts (só `lib/database.types.ts`); nada visível ao operador; o rollback de imagem pelo `agent.sh` não quebra (a imagem anterior não as lê). Atualizar `docs/specs/01-spec-platform-base.md:101-102` (DoD 16).

A RLS de `organizations` não muda.

### 2.2 `public.cobranca_planos` (da instalação, sem `organization_id`)

```sql
create table if not exists public.cobranca_planos (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (char_length(nome) between 1 and 60),
  preco_cents bigint not null check (preco_cents >= 500),          -- R$5: mínimo de boleto nos dois provedores
  moeda text not null default 'BRL' check (moeda = 'BRL'),         -- Asaas não tem moeda; boleto Stripe só BRL
  intervalo text not null check (intervalo in ('mes','ano')),
  trial_dias integer not null default 14 check (trial_dias between 0 and 90),
  max_assentos integer check (max_assentos >= 1),                   -- null = sem limite
  max_canais integer check (max_canais >= 1),
  teto_ia_usd_cents integer check (teto_ia_usd_cents >= 100),       -- moeda de fn_gasto_de_ia_do_mes (baseline.sql:13111)
  padrao_no_cadastro boolean not null default false,
  arquivado_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid
);
create unique index if not exists cobranca_planos_um_padrao
  on public.cobranca_planos ((true)) where padrao_no_cadastro and arquivado_em is null;
alter table public.cobranca_planos enable row level security;   -- zero policies: molde de platform_config (baseline.sql:43458-43470)
revoke all on public.cobranca_planos from anon, authenticated;
grant select, insert, update, delete on public.cobranca_planos to service_role;
```

- Limites em colunas, não jsonb (anti-pattern 6). Nome distinto de `account_plans` (`baseline.sql:33414`).
- Preço e intervalo imutáveis enquanto houver assinatura apontando para o plano (nem como `plano_agendado_id`): 409 "arquive e crie outro".
- Alargar a moeda depois é alargamento de CHECK puro.

### 2.3 `public.cobranca_assinaturas` (tenant-aware, uma linha por org)

```sql
create table if not exists public.cobranca_assinaturas (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  plano_id uuid not null references public.cobranca_planos(id) on delete restrict,
  plano_agendado_id uuid references public.cobranca_planos(id) on delete restrict,  -- vale na virada do ciclo (§7e)
  estado text not null default 'trial' check (estado in ('trial','ativa','em_atraso','cancelada')),
  trial_ate timestamptz,
  provedor text check (provedor in ('stripe','asaas')),
  modo text check (modo in ('teste','producao')),
  provedor_cliente_id text,
  provedor_assinatura_id text,
  vencida_desde timestamptz,        -- MONOTÔNICO: só recua (least) ou zera quando volta a ativa/trial
  proximo_vencimento timestamptz,   -- fim do período pago; só sobrescrito por valor lido não nulo
  cancela_no_fim boolean not null default false,
  prazo_extra_ate timestamptz,
  ultimo_aviso text check (ultimo_aviso in ('trial_acabando','venceu','suspende_em_breve','suspensa')),
  ultimo_aviso_em timestamptz,
  checkout_url text, checkout_expira_em timestamptz,  -- reuso e reserva anti-clique-duplo (§7b)
  relida_em timestamptz,            -- instante da última leitura APLICADA do provedor
  assinaturas_vivas integer not null default 0,       -- >1 = cobrança dupla, mostrado ao dono (§9)
  ultimo_erro text check (ultimo_erro in ('credencial_invalida','provedor_fora','pagamento_de_assinatura_cancelada','leitura_invalida')),
  ultimo_erro_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((provedor is null) = (provedor_cliente_id is null))
);
create unique index if not exists cobranca_assinaturas_cliente
  on public.cobranca_assinaturas (provedor, provedor_cliente_id) where provedor is not null;
alter table public.cobranca_assinaturas enable row level security;
create policy tenant_isolation_cobranca_assinaturas_select on public.cobranca_assinaturas
  for select to authenticated using (public.fn_role_at_least(organization_id, 'admin'));  -- spec 13 §4
revoke all on public.cobranca_assinaturas from anon, authenticated;
grant select on public.cobranca_assinaturas to authenticated;
grant select, insert, update, delete on public.cobranca_assinaturas to service_role;
```

- Sem índice parcial por estado: a tabela tem uma linha por org (dezenas a centenas); a varredura da reconciliação é barata e o predicado dela muda (§8). Índice só depois de medir.
- Grants explícitos: o default ACL do baseline daria ALL a `authenticated`; com o revoke, só `service_role` escreve.
- Convivência com as varreduras: RLS nasce ligada, então `fn_proteger_tabelas_de_organizacao` (`baseline.sql:6946`) não planta a policy ampla; sem escrita de `authenticated`, `fn_aplicar_travas_de_suporte` (`baseline.sql:28192`) não planta `support_write_*`.
- LGPD: CPF/CNPJ vai direto ao provedor e **não** é guardado aqui. A linha guarda só ponteiros.

### 2.4 `public.webhook_events_log` (existente, `baseline.sql:1890-1912`)

- O **bloco único** do CHECK de provider (`baseline.sql:14432-14437`) ganha `'stripe','asaas'` (alargamento puro, regra da issue #159).
- `create unique index if not exists uniq_webhook_events_log_cobranca on public.webhook_events_log (provider, external_id) where provider in ('stripe','asaas')`. Hoje não há linha desses provedores.
- **Forma da linha de cobrança** (a policy de leitura vale para qualquer membro, sem papel: `baseline.sql:4346`, comentário do buraco em `:15092-15095`; `GRANT SELECT` em `:4722`):
  - `organization_id = NULL` sempre (a org viaja só no `emit_event`); linha com org nula é invisível ao tenant pela própria policy.
  - `raw_body = {"id": <evento>, "type": <tipo>}` — nunca o corpo do provedor. `raw_body` nasceu `NOT NULL` (`baseline.sql:1898`), mas o apêndice o afrouxou (`baseline.sql:14816-14817`; NULL = corpo descartado pela retenção), então o ponteiro mínimo é escolha nossa, não exigência do schema; o corpo é só ponteiro: toda decisão vem da releitura.
  - `headers = NULL`; `signature_header` = `Stripe-Signature` (é assinatura, não credencial); nunca o `asaas-access-token`. Cinto: `'asaas-access-token'` entra em `PROIBIDOS` de `lib/channels/arquivo-de-webhook.ts:37`.
  - `status`: `received` → `processed` (com `processed_at`) depois do `emit_event`; `error` com `error_message='cliente_desconhecido'` quando não há org.
- `webhook-replay` filtra `provider='waha'` (`lib/channels/reprocessar-arquivo-de-webhook.ts:123`): não toca estas linhas.
- Retenção (`lib/channels/retencao-do-arquivo.ts:157,175-184`): esvazia o corpo em D+7 e **apaga a linha em D+90** (`baseline.sql:15132`). Nada da cobrança depende da linha depois do processamento (§9 explica o checklist).

### 2.5 `public.agent_inbox_items` (existente)

O **bloco único** do CHECK de kind (`baseline.sql:~9996-10000`) ganha:
- **PR 1:** `'org_reativada'` — revisão pós-reativação, qualquer motivo (administrativa inclusive).
- **PR 3a:** `'cobranca'` — avisos da régua ao cliente e aviso de 80% do teto de IA.

A última migration que reconstrói a constraint também muda (`tests/unit/kind-check-migration-x-baseline.test.ts`); par `InboxKind` em `tests/invariants/vocabulario-banco-x-typescript.test.ts:124`. O bloqueio pelo teto de IA reusa `budget_exceeded` com `ref_kind='plano'`.

A Central é da **org**, nunca canal para o dono da instalação. O que é do dono (cobrança dupla, credencial inválida, pagamento de assinatura cancelada) é **estado** em `cobranca_assinaturas` mostrado em `/admin/cobranca` (§9).

### 2.6 Funções SQL novas

Todas com `revoke execute ... from public, anon;` + `grant` só a quem precisa (doutrina 9, `tests/invariants/hardening-definer-varredura.test.ts`), no apêndice **antes** da VARREDURA anon (`baseline.sql:42990`, `tests/unit/varredura-anon-e-o-ultimo-bloco.test.ts`). Gatilhos com `set search_path = ''` e nomes qualificados, molde `fn_teto_de_tokens_ativos` (`baseline.sql:38711-38747`).

| Função | PR | Tipo | O que faz | Grant |
|---|---|---|---|---|
| `fn_org_operante(p_org uuid) → boolean` | 1 | sql stable invoker | `coalesce((select status='active' from public.organizations where id=p_org), false)` | service_role |
| `fn_organizacao_estado_so_pelo_servidor()` | 1 | trigger invoker | §2.1 | revoke de todos |
| `fn_suspender_organizacao(p_org, p_kind, p_motivo, p_ator) → jsonb` | 1 | plpgsql definer | §3.1 | service_role |
| `fn_reativar_organizacao(p_org, p_kind_exigido, p_ator) → jsonb` | 1 | plpgsql definer | §3.1 | service_role |
| `fn_cobranca_ligada() → boolean` | 2 | sql stable definer | `exists(select 1 from public.platform_config where chave='MODULO_COBRANCA' and valor='ligado')` | service_role |
| `fn_limite_do_plano(p_org uuid, p_recurso text) → integer` | 2 | plpgsql stable definer | null se chave desligada, sem linha ou plano sem teto; senão `'assentos'` → `max_assentos`, `'canais'` → `max_canais`, `'ia_usd_cents'` → `teto_ia_usd_cents`; outro valor → `raise ... using errcode='22023'`. Os três literais viram constante `RECURSOS_DO_PLANO` em `lib/cobranca/vocabulario.ts` | service_role |
| `fn_cobranca_liberar_suspensoes(p_ator) → integer` | 2 | plpgsql definer | reativa toda org `suspended{cobranca}` via `fn_reativar_organizacao` | service_role |
| `fn_trava_assentos_do_plano()` | 2 | trigger definer | §5 | revoke de todos |
| `fn_trava_canais_do_plano()` | 2 | trigger definer | §5 | revoke de todos |
| `fn_trial_na_criacao_da_org()` | 2 | trigger definer AFTER INSERT ON organizations | ver abaixo | revoke de todos |

**`fn_trial_na_criacao_da_org`:** insere `(org, plano padrão, 'trial', now()+trial_dias)` quando: `fn_cobranca_ligada()`; existe plano `padrao_no_cadastro` não arquivado; `new.created_by is not null`; `new.created_by` não é platform admin ativo. Como o INSERT de org por sessão agora é recusado (§2.1), `created_by` só vem de caminho de servidor: `ensureTenantForUser` (`lib/auth/provision.ts:86-160`), as 4 portas do cadastro e `provisionExternalTenant` (`provision.ts:288-317`). O tenant criado pelo admin recebe o plano explícito do formulário.

**Redefinida:** `fn_create_tenant_with_owner` (`baseline.sql:19215-19262`) — continua gravando `settings.plan` quando `p_request->>'plan'` vier (chave desligada, comportamento atual); aceita `p_request->>'plano_id'` e, com a chave ligada, cria a assinatura `trial` na mesma transação; com a chave desligada, recusa `plano_id`.

**Não redefinidas, de propósito:**
- `fn_support_write_allowed` (`baseline.sql:18642-18647`): é chamada por `emit_event` para todo chamador (`:28451`); pôr o status nela derrubaria LGPD, a entrada de mensagens e o próprio `cobranca.sinal`.
- `emit_event`: ver §16, achado 1.5.

### 2.7 Vocabulário
Constantes em `lib/cobranca/vocabulario.ts` (`ESTADOS_DA_ASSINATURA`, `PROVEDORES_DE_COBRANCA`, `MODOS`, `INTERVALOS`, `AVISOS_DA_REGUA`, `ERROS_DE_LEITURA`) e `TIPOS_DE_SUSPENSAO` em `lib/organizacao/operante.ts`. Toda coluna nova com CHECK entra em `tests/invariants/vocabulario-banco-x-typescript.test.ts`.

### 2.8 Contagens
- Assentos: `count` em `user_organizations` por org (dezenas de linhas). Sem índice antes de medir.
- Canais: `channel_sessions` não arquivadas da org.

---

## 3. Máquinas de estado

### 3.1 Organização: a verdade de "pode operar"

```
active ──fn_suspender_organizacao(kind)──▶ suspended{administrativa|cobranca}
suspended ──fn_reativar_organizacao(kind_exigido)──▶ active
redacted / archived: inalterados, não operantes
```

| Transição | Quem dispara | Guarda |
|---|---|---|
| active → suspended{administrativa} | platform admin por `requirePlatformAdminEscrita()` em `POST /api/v1/admin/tenants/[id]/suspend` | motivo de 10 a 500 caracteres |
| suspended{cobranca} → suspended{administrativa} | idem | a administrativa prevalece (troca o kind) |
| active → suspended{cobranca} | régua (§3.2) | só org com assinatura; sem linha → `{changed:false, motivo:'org_isenta'}` |
| suspended{administrativa} + pedido de cobrança | régua | no-op |
| suspended{cobranca} → active | sincronizar/régua que leem pagamento; dono em "Dar prazo" ou "Tornar isenta"; `fn_cobranca_liberar_suspensoes` | `p_kind_exigido='cobranca'` recusa kind administrativo |
| suspended{administrativa} → active | platform admin em `/reactivate` | `/reactivate` sobre kind `cobranca` → 409 `suspensao_de_cobranca` ("use Dar prazo ou Tornar isenta") |

A escrita **só** acontece por essas duas funções definer; o gatilho de §2.1 garante isso contra o PostgREST.

**`fn_suspender_organizacao`** (uma transação, `select ... for update` na org; conserta a não atomicidade de `suspend/route.ts:55-115` (leitura em 55-59, UPDATE em 71-80, `event_log` solto e sem await em 105-115)):
1. Já suspensa: mesmo kind → `{changed:false}`; cobrança → administrativa troca o kind; administrativa → cobrança é no-op.
2. `update organizations set status='suspended', suspended_kind, suspended_reason, suspended_at=now(), suspended_by`.
3. Anti-backlog: `update job_queue set status='failed', last_error='org_nao_operante' where organization_id=p_org and status='pending'` (`'failed'` é o terminal de veto, `lib/agent-engine/queue/queue.ts:28, 338-353`; não `'dead'`, que alerta `job_dead`).
4. Fecha o redrive: `update messages set status='failed', error_code='org_suspensa' where organization_id=p_org and status='queued'`.
5. `insert into event_log` de `tenant.suspended` na mesma transação (continua em `fn_event_log_e_registro`, `baseline.sql:24523-24524`: nasce `done`, sem consumidor).

**`fn_reativar_organizacao`:**
1. Guarda de kind. 2. Lê `suspended_at` antes de zerar. 3. `status='active'`, `suspended_*=null`. 4. Cinto: jobs `pending` antigos da org → `failed`. 5. Se N conversas têm `last_inbound_at >= suspended_at`, **um** item na Central com `kind='org_reativada'`, `severity='warn'`: "N conversas receberam mensagem enquanto a conta estava suspensa. A IA não respondeu nem vai responder sozinha a elas. Revise na Fila." Sem `force_human`. 6. `event_log tenant.reactivated`. 7. Na assinatura (se houver): `ultimo_aviso=null, ultimo_aviso_em=null`.

### 3.2 Assinatura: a verdade do provedor, traduzida

```
(sem linha) = isenta
(nasce) ──gatilho/atribuição──▶ trial
trial ──1º pagamento confirmado──▶ ativa
trial ──trial_ate passou sem pagamento confirmado──▶ em_atraso (vencida_desde = trial_ate)
ativa ──provedor diz que deve──▶ em_atraso
em_atraso ──provedor diz que está em dia──▶ ativa
ativa|em_atraso ──cancelada / sem assinatura viva paga──▶ cancelada   (cancela_no_fim mantém 'ativa' até proximo_vencimento)
cancelada ──nova assinatura com 1º pagamento confirmado──▶ ativa
```

`suspensa` **não** é estado da assinatura (fonte única: `organizations.status/suspended_kind`).

**Quem grava `estado`:** só `sincronizar(org)` (a partir do objeto relido na API) e a régua nas transições de tempo. Nunca o corpo do webhook; nunca as rotas de plano (§7e, §7g).

**Tradução pura** (`lib/cobranca/estado.ts`), a partir de `Situacao` (§6):

| Situação lida (em ordem) | Estado |
|---|---|
| `cancelada && !cancelaNoFim` | `cancelada` |
| `existe && emAtraso` | `em_atraso` |
| `existe` | `ativa` |
| `!existe && jaPagou` (cancelou, ou reassinou e o 1º pagamento da nova ainda não confirmou) | `cancelada` |
| `!existe && emTesteNoProvedorAte > agora` (checkout concluído durante o teste; a 1ª cobrança é do provedor) | `trial`, mesmo com `trial_ate` local vencido |
| `!existe && !jaPagou`, dentro do trial | `trial` |
| `!existe && !jaPagou`, trial vencido | `em_atraso`, `vencida_desde = trial_ate` |

**Regras de gravação** (em `sincronizar`, na fase curta de §7c):
- `vencida_desde`: se o estado é `em_atraso`, `least(coalesce(vencida_desde_local, x), x)` com `x = situacao.vencidaDesde ?? now()` (trial: `trial_ate`). Só vira `null` quando o estado passa a `ativa` ou `trial`. Resultado: cancelar e reassinar **não** reinicia o relógio da dívida.
- `proximo_vencimento`: só sobrescrito por valor lido **não nulo** (cancelamento no Asaas não apaga o período pago).
- Toda transição **para** `ativa` ou `trial` zera `ultimo_aviso` e `ultimo_aviso_em`.
- `plano_agendado_id`: aplicado (vira `plano_id`) quando `proximo_vencimento` avança e o estado é `ativa` (o período novo foi pago). Durante o teste grátis (`trial_ate > now()`, com ou sem provedor), a troca é imediata (decisão D-13, §7e).
- `assinaturas_vivas`, `relida_em = lido_em`, `ultimo_erro = null` (ou `pagamento_de_assinatura_cancelada` se `situacao.pagamentoSemAssinaturaViva`).

**Régua pura** (`lib/cobranca/regua.ts`, sem banco). Entradas: assinatura, org, plano, `agora` injetável, `toleranciaDias = max(5, configurada)` (piso no código: boleto Stripe ~1 dia útil, `CONFIRMED→RECEIVED` e compensação Asaas, mais um fim de semana).

**Filtro por org** (antes de tudo):
- org `active` ou `suspended{cobranca}` → avalia.
- org `suspended{administrativa}` → nenhuma ação, nenhum aviso.
- org `redacted`/`archived` com provedor e estado ≠ `cancelada` → `cancelarNoFim` uma vez + audit `cobranca.assinatura_cancelada` com `motivo:'org_redigida'`; nenhum aviso.

**Dívida corrente:** `debito_desde = vencida_desde` (`em_atraso`) ou `proximo_vencimento` já passado (`cancelada`; se `proximo_vencimento` é nulo, a primeira avaliação grava `vencida_desde = agora` e daí em diante `debito_desde = vencida_desde` — sem valor persistido, `agora` muda a cada rodada e nenhum aviso chega a "pertencer" à dívida). Um aviso "pertence à dívida" só se `ultimo_aviso_em >= debito_desde`.

`limite = max(debito_desde + (em_atraso ? tolerância : 0), prazo_extra_ate)`

| Situação | Ação |
|---|---|
| estado `ativa` ou `trial` vigente, org em suspended{cobranca} | **reativar** |
| em dívida, org ativa, `agora ≥ limite`, `ultimo_aviso='suspende_em_breve'` da dívida corrente, escrito há ≥ 48h, e (com provedor) `relida_em ≥ agora − 1h` | **suspender{cobranca}** |
| em dívida e `agora ≥ limite − 2 dias`, aviso final da dívida corrente não dado | aviso `suspende_em_breve` (critical) |
| `em_atraso`, nenhum aviso da dívida corrente | aviso `venceu` (warn) |
| `trial` e `trial_ate − 3 dias ≤ agora`, aviso não dado | aviso `trial_acabando` |

**Garantias** (cada uma tem caso em `regua.test.ts`):
- Ninguém é suspenso sem aviso final **desta dívida** gravado há ≥ 48h junto com o item `kind='cobranca'` na Central, na mesma transação do `ultimo_aviso` (é o que D-5 chama de "enviado"; o e-mail é melhor esforço, §7d) — inclusive quem pagou depois do aviso no mês anterior e a régua acordou tarde (VPS fora do ar, webhook perdido).
- Nunca se suspende com estado velho (releitura de < 1h com provedor). Leitura falha nunca suspende.
- Trial sem checkout é suspenso pela régua; não vira acesso eterno.
- Clicar em "Assinar" e não pagar não reativa (Asaas e Stripe: sem 1º pagamento confirmado, `existe=false`).
- Boleto emitido e ainda válido nunca conta como atraso (Stripe: só `past_due`/`unpaid`; Asaas: só `OVERDUE`).

---

## 4. Predicado "org operante": definição única e choke points

**Definição:** `operante ⇔ organizations.status = 'active'` — mesma régua dos porteiros SQL existentes (`baseline.sql:19164, 22134, 34925`). `redacted`, `archived` e status futuro ficam não operantes (falha fechada).

- SQL: `public.fn_org_operante(uuid)`.
- TS: `lib/organizacao/operante.ts` exporta `STATUS_OPERANTE`, `ehOperante(status)`, `idsDeOrgsParadas(admin)` (`select id from organizations where status <> 'active'`), `assertOrgOperante(db, orgId)`, `class OrgNaoOperanteError` (`org_suspended`, terminal).
- **Cerca `tests/unit/org-operante-uma-regua.test.ts`** — por AST, no molde de `cron-audita-so-quando-ha-efeito`: mira só **decisões** (argumento de `redirect`, `fail`, `return` de gate, filtro de seleção em `app/api/v1/cron/**`, `lib/**/worker*`, `workers/**`) que comparem `status` de org com literal fora de `operante.ts`. Exibição (`app/admin/(protected)/tenants/[id]/_client.tsx:43`, TenantActions) usa `ehOperante`/`suspended_kind` e não é decisão. SQL em string (ex.: `lib/agent-engine/agent/org-memory.ts:33`, outra tabela) fica fora. Allowlist que só encolhe: `app/actions/shell/setActiveOrg.ts:21` ("troca de org só para ativa; molde anterior ao predicado"). Controles positivo e negativo no próprio teste.

| # | Onde (arquivo:linha) | Caminho coberto | Comportamento com org não operante |
|---|---|---|---|
| 1 | `lib/auth/server.ts:190`, embed de `loadAuthUser` | toda sessão | Embed traz `status, suspended_kind`. `UserOrgMembership` ganha `org_status`, `suspended_kind`. **E** o select de `platform_admins` (`server.ts:174-176`) passa a `user_id, scope, revoked_at`; `AuthUser` ganha `platform_admin_scope` |
| 2 | `lib/auth/server.ts:74`, `escolherMembroAtivo` | org ativa sem cookie | Sem cookie, prefere membership operante; com cookie na suspensa, mantém (para poder pagar) |
| 3 | `lib/auth/server.ts:284-303`, `resolveActiveOrg` | 110 arquivos de páginas, layouts e actions (83 `page.tsx`, 3 `layout.tsx`, 24 actions; `grep -rl resolveActiveOrg app | grep -v '\.test\.'`); `app/onboarding/layout.tsx:15-16`; 22 rotas | Corpo atual vira `orgAtivaSemPortao(user)`; `resolveActiveOrg` = esse corpo + `redirect("/account-suspended")` se não operante (precedente: `redirect("/support-ended")`). Fecha actions (ex.: `unpauseAgentAction`, `app/app/ai/agents/_actions.ts:31-40,108-112`), o escape para `/onboarding` e as páginas |
| 4 | `lib/auth/require-role.ts:62-79` e `:88` | rotas `/api/v1` de sessão | (a) Não operante: `fail("org_suspended", ..., 403)`, salvo `opts.permiteOrgSuspensa === true`. (b) **Bypass de platform admin (`:88`) deixa de ser incondicional:** `allowPlatformAdmin?: boolean \| "leitura"`. `true` libera só `scope==='full'` **e** `!mfaEmDivida()`; `"leitura"` libera qualquer scope. Os handlers `GET` hoje com `true` (ex.: `app/api/v1/audit/route.ts`, `lgpd/requests/route.ts`) passam a `"leitura"` para não tirar leitura do `support_readonly`. Fecha: `support_readonly` anonimizando contato (`app/api/v1/lgpd/anonymize/route.ts:93-98`), aprovando LGPD, criando canal ou pareando voz fora de sessão de acompanhamento |
| 5 | `app/app/layout.tsx:92-116` | render de `/app/*` | Suspensão ANTES de onboarding; erro de leitura de `organizations` passa a **lançar** (hoje falha aberta com `orgRow` nulo) |
| 6 | `lib/mcp/auth.ts:131-135`, `resolveApiToken` | Bearer `dsk_` (`lib/api/auth-dual.ts:96-138`), `/api/mcp` | Select ganha `organizations!inner(status)`; não operante → `ApiTokenError("org_suspended")` → 403; não debita o balde de falhas |
| 7 | `lib/ai/elegibilidade/gate.ts:112`, `decidirElegibilidade` | toda a IA que consulta o gate (`edge/crm/drain.ts`, `agent/inbound-turn.ts`, `workers/ai-response-worker.ts`, `ai-sentiment-worker.ts`, `lib/ai/handoff/orchestrator.ts`, `lib/ai/runtime/agent.ts:416`, `lib/followup/enviar-texto-fixo.ts`, `lib/followup/silence-sweep.ts`, `lib/agenda/meet-delivery.ts`). Não consultam o gate: `send-ai-message.ts` (saída pela linha 12) e `prospecting/worker.ts` (linha 13) só autorizam o contato e leem o pré-go-live; `wacalls/events-bridge.ts` só grava `bot_silenced_until`; `resolve-turn-agent.ts` só o cita em comentário | Primeiro veto `org_nao_operante`. `orgStatus` campo **obrigatório** de `EstadoDeElegibilidade` (`gate.ts:57`); o typecheck obriga os 4 montadores: `consulta-pg.ts:35-54`, `consulta-supabase.ts:53-67`, `silence-sweep.ts:378`, `meet-delivery.ts:36` |
| 8 | `lib/event-log/dispatcher.ts:51-56` e `:81`; `lib/event-log/drain.ts:257-284` | barramento nos 3 drivers (loop do worker `workers/agent-worker/main.ts:368`, cron `event-log-drain`, `lib/relogio/executar.ts:102`) | `EventHandler` ganha `naOrgParada: "roda" \| "pula"` obrigatório. O drain lê o status das orgs do lote numa query `in (...)`. `pula` em org parada → `{status:"skipped", detail:"org_nao_operante"}` (`dispatcher.ts:45`), vai para `consumed_by`: evento `done`, **não volta** na reativação. Classificação abaixo |
| 9 | `lib/agent-engine/edge/crm/drain.ts:219-226` | mensagem → job | Query traz também `status`; não operante → `'processado'` sem job |
| 10 | `lib/agent-engine/cron/scheduler.ts:207-212`, `fireOneDue` | follow-up por lead | Select traz `public.fn_org_operante(organization_id) as operante`; não operante: avança `next_run_at` sem enfileirar; one-shot vira `enabled=false` |
| 11 | `lib/agent-engine/edge/crm/session-reconciler.ts:373-379` | redrive direto ao WAHA (`:390`) | Select ganha `fn_org_operante`; falso → `messages` `failed`/`org_suspensa`, molde `pre_go_live` (`:381-388`) |
| 12 | `app/api/v1/messages/_handler.ts:367-373` | saída de ~20 chamadores | `assertOrgOperante` no topo → 403 `org_suspended`; terminal no settle de `lib/followup/enviar-texto-fixo.ts:~152-156`; um teste por chamador com settle próprio |
| 13 | `lib/prospecting/worker.ts:338-341` | busca paga + LLM | Exclui `idsDeOrgsParadas` |
| 14 | `lib/campanhas/rodada.ts:99-116, 163-172` | campanhas | Passa a `idsDeOrgsParadas`; **corrige o comentário falso** de `:99-101` |
| 15 | `workers/voice-agent/index.ts:243` | voz em tempo real | `select status from organizations`; não operante → `socket.end()`, log `voz_org_suspensa` |
| 16 | `app/api/v1/cron/kb-conversations-batch/route.ts` | embedding de conversas | Exclui `idsDeOrgsParadas` |
| 17 | cerca `tests/unit/cron-respeita-org-operante.test.ts` sobre as 38 rotas de `app/api/v1/cron/` | crons | Importa o predicado **ou** consta de allowlist com justificativa ≥ 20 caracteres que só encolhe (ex.: `webhook-replay`, `data-retention`, `lgpd-sla-watcher`, `storage-redaction`, `event-log-drain`, `followup-flow-worker`, `agenda-reminder`, `lead-time-triggers`, `lead-date-field-due`). A rota `cobranca` (PR 3a) importa `lib/organizacao/operante.ts` para o filtro de §3.2 e por isso não entra na allowlist |
| 18 | `fn_suspender_organizacao` | jobs `pending` e mensagens `queued` | §3.1; dispensa filtro no `CLAIM_SQL` (`queue.ts:126-148`) |
| 19 | `app/api/v1/admin/tenants/[id]/suspend/route.ts:30-115` e `reactivate/route.ts:65-120` | escrita manual de status | `requirePlatformAdminEscrita()`; body segue `{reason}` (10–500), **sem** `tipo`: `suspend` chama `fn_suspender_organizacao(id,'administrativa',reason,ator)`; `reactivate` chama `fn_reativar_organizacao(id,'administrativa',ator)`, com o `reason` só no audit, e kind `cobranca` → 409 `suspensao_de_cobranca`; as duas devolvem `ok(<jsonb da função>)`, isto é, `{changed, motivo?}` |
| 20 | `app/account-suspended/page.tsx:22-59` (fora de `app/app/`; `lib/auth/public-paths.ts:138`) | tela do suspenso | Vira o hub (§9). **Não depende de `x-pathname`** (gravado depois de `NextResponse.next`, `proxy.ts:16` vs `:38-39`; `app/onboarding/_components/Stepper.tsx:29-31`) |
| 21 | `app/api/v1/lgpd/**` e `app/api/v1/cobranca/**` | o que o suspenso ainda faz | `requireRole(..., { permiteOrgSuspensa: true })`; cerca AST `tests/unit/org-suspensa-so-nas-rotas-permitidas.test.ts` |
| 22 | `trg_organizacao_estado_so_pelo_servidor` (§2.1) | PostgREST com JWT | recusa escrita de status/suspensão/`created_by` e INSERT de org |

**Classificação dos handlers** (lista literal num teste):
- **`roda`:** `followupReactivityHandler`, `campanhaRespostaHandler`, `avisoDeEtapaHandler`, `casoNaCentralHandler`, `mediaPersistHandler`, `lgpdExportHandler`, `lgpdRedactHandler`, `cobrancaSinalHandler`.
- **`pula`:** `aiResponseHandler`, `aiSentimentHandler`, `aiHandoffFromSentimentHandler`, `ragIndexerHandler`, `mediaDeriveHandler`, `automationRulesHandler`, `followupGatilho{Retorno,Etapa,Lead,Caso,Presenca}Handler`, `webPushInboundHandler`, `avisoDeCasoAoSuporteHandler`, `avisoDePropostaNoWhatsAppHandler`, `conversaoDeVendaHandler`, `conversaoDeQualificacaoHandler`.

**Já respeitam:** `setActiveOrg.ts:17-22`; `fn_accept_team_invite` (`baseline.sql:19164`); `fn_start_support`/`fn_support_context` (`:18627`, `:18677`); `fn_reply_delivery_policy` (`:22134`); `fn_meet_delivery_current` (`:34925`).

**Deliberadamente NÃO gatilhados** (lista no cabeçalho de `operante.ts`): webhooks de entrada (`waha`, `waha/[token]`, `meta/[token]`, `channel/[token]`, `in/[token]`, `channels/official/webhook`, `nuvemshop/[event]`, `lib/channels/inbound.ts`); landings `anuncios/{google,meta}/[org]` e `rastreio/[id]`; `recover-stuck-messages`; sync/push do Google Agenda e `contact-avatars`; leitura via RLS, Realtime e Storage; escrita de dados de negócio via PostgREST por membro de org suspensa (decisão D-12).

**Scope `support_readonly` (critério da PR 1).** `requirePlatformAdmin` (`lib/auth/requirePlatformAdmin.ts:34-67`) devolve o scope mas não o impõe; conferem `full` só `app/api/v1/admin/tenants/route.ts:166-171` e o helper próprio das extensões, `requireExtensionPlatformFor` (`lib/extensions/http.ts:70`, usado pelas rotas `app/api/v1/extensions/**`).
- **Helper** `requirePlatformAdminEscrita()` no mesmo arquivo: `requirePlatformAdmin()` + `scope==='full'` (403 `forbidden_scope`) + `mfaEmDivida()` (`lib/auth/server.ts:414`, 403 `mfa_required`).
- `app/api/v1/system/update/route.ts:30` (hoje só `user.is_platform_admin`) passa a usar o helper.
- **Cerca `tests/unit/admin-escrita-exige-scope-full.test.ts`, pelo mecanismo, em `app/**` inteiro:**
  - todo handler exportado `POST|PATCH|PUT|DELETE` que chama `requirePlatformAdmin(` ou lê `.is_platform_admin` precisa chamar `requirePlatformAdminEscrita(`;
  - todo arquivo `"use server"` que importa `requirePlatformAdmin` precisa usar a versão de escrita;
  - `allowPlatformAdmin: "leitura"` só aparece em handler `GET`;
  - allowlist que só encolhe, com justificativa.

---

## 5. Limites do plano

Valem só quando `fn_limite_do_plano(org, recurso)` não é nulo.

**Troca de plano só na virada do ciclo** (§7e), salvo durante o teste grátis, em que vale na hora (decisão D-13). Downgrade abaixo do uso é recusado na nossa tela, com a lista do que remover; se o uso crescer entre o agendamento e a virada, o plano novo entra assim mesmo e só bloqueia crescer. O portal da Stripe é configurado **sem** troca de plano.

| Limite | Onde é imposto | Mensagem |
|---|---|---|
| **Assentos** | **Contagem:** `revoked_at is null and not provisional_until_handover and user_id <> new.user_id`.<br><br>**Gatilho** `trg_trava_assentos_do_plano BEFORE INSERT OR UPDATE OF revoked_at, provisional_until_handover, organization_id ON public.user_organizations`:<br>1. **Linha provisória só pelo servidor:** se `new.provisional_until_handover` e `current_user in ('authenticated','anon')` → 42501. O único escritor legítimo é `fn_create_tenant_with_owner` (`baseline.sql:19253`); sem isso, um admin de tenant inseriria membros provisórios pelo PostgREST (`user_orgs_insert` `:4308`, `GRANT ALL` `:4709-4711`, coluna sem revoke `:43073`), cada um invisível à contagem e com acesso pleno (`fn_user_org_ids` só olha `revoked_at`, `:18651-18654`).<br>2. **Conta quando:** INSERT ativo; `revoked_at` volta a nulo; `provisional_until_handover` vira `false` num ativo; `organization_id` muda num ativo.<br>3. `pg_advisory_xact_lock(hashtextextended(new.organization_id::text, 2282))`; acima do teto `raise ... using errcode='PT402'` (precedente `PT409`, `baseline.sql:38711-38747`).<br><br>Caminhos alcançados: `fn_accept_team_invite` (`:19174-19182`), `app/api/v1/team/[user_id]/reactivate/route.ts:79-84`, `lib/auth/provision.ts:126,308,405`, `fn_create_tenant_with_owner`, PostgREST | **Aceite de convite** (`lib/auth/aplicar-convite.ts:78-86`: `PT402` → motivo `limite_do_plano`): "A empresa que te convidou atingiu o limite de pessoas do plano. Avise quem te convidou."<br>**Reativar membro:** 409 `plan_limit_reached`, "Seu plano permite N pessoas e todas as vagas estão ocupadas. Remova alguém em Equipe ou troque de plano em Configurações › Plano e cobrança."<br>**Emitir convite** (`app/api/v1/team/invite/route.ts:91-133`): mesma mensagem antes do e-mail (aviso, não autoridade) |
| **Canais de mensagem** | **Contagem:** `archived_at is null and provider <> 'wacalls'` (um teste compara com `PROVIDERS_DE_MENSAGEM`, `lib/channels/capabilities.ts:155-161`).<br><br>**Gatilho** `trg_trava_canais_do_plano BEFORE INSERT OR UPDATE OF archived_at, provider, organization_id ON public.channel_sessions`, com a mesma chave de lock de `fn_reserve_channel_connection` (`hashtextextended(p_org::text,2281)`, `baseline.sql:23627`). Estourado → `PT402`.<br><br>Caminhos: `lib/channels/connect-waha.ts:38`, `app/api/v1/channels/official/route.ts:308`, `lib/channels/connect.ts:230`, `lib/channels/social/store.ts:147`, `lib/channels/graph-parceiro/session.ts:132`, ressurreições (`connect.ts:224-231`, `lib/channels/reactivate.ts:82`) | `lib/cobranca/limites.ts: traduzirLimiteDoPlano(err)` nas rotas `channel-sessions`, `onboarding/whatsapp/session`, `channels/{official,partner,social,graph-partner}`: 409 `plan_limit_reached`, "Seu plano permite N números conectados. Arquive um número em Conexões ou troque de plano." |
| **Teto de IA do plano** (US$ centavos/mês) | Separado de `ai_budgets` (orçamento que a org escolhe, `app/api/v1/ai/budget/route.ts:104, 195-227`). **Só vincula com `origemDaChave === 'chave_da_instalacao'`** (`lib/agent-engine/edge/llm/credentials.ts:370-387`).<br><br>**`SQL_CONFIG_COM_ORCAMENTO` (`credentials.ts:231-240`) NÃO muda.** O catch dele (`:311-313`) troca para a query legada em qualquer erro e desliga o orçamento de toda org (`:325-327`); pendurar a função nova ali amarraria o orçamento existente a ela.<br><br>**Consulta própria** `lerTetoDoPlano(db, org)` em `lib/agent-engine/edge/llm/orcamento.ts`: `select public.fn_limite_do_plano($1,'ia_usd_cents') as teto, public.fn_gasto_de_ia_do_mes($1) as gasto`, feita **só** quando a origem é a chave da instalação, com try/catch próprio: erro → teto indisponível (log com SQLSTATE), chamada segue, orçamento da org intacto.<br><br>**Decisão pura** `decidirTetoDoPlano({tetoUsdCents, gastoUsdCents, origemDaChave, purpose})`: `PURPOSES_ISENTOS` isentos; `gasto ≥ teto` → bloquear.<br><br>**Engine:** em `aplicarOrcamento` (`run-model-call.ts:~307-318`), a ordem vira: `chave==='off'` (alavanca de emergência `AI_BUDGET_ENFORCEMENT`) → retorna; teto do plano; `orcamentoIndisponivelPorque` → retorna; `modo==='off'` → retorna; orçamento da org. Instalação sem a chave de cobrança: `fn_limite_do_plano` devolve nulo e não há consulta de gasto.<br><br>**Worker legado:** `workers/ai-response-worker.ts`, dentro de `vetoPorTetoDeGasto` (`:403-454`), antes de `enforcement_mode === "off"` (`:426`). A origem é `resolverModeloDoPonto(...).origem === "padrao"` (`lib/ai/gateway-binding.ts:42, 105, 121, 132`), que hoje só é resolvida em `:228`, depois do veto (`:198`). O teto do plano precisa rodar depois dessa resolução, ou a resolução sobe para antes do veto. (`lib/ai/runtime/agent.ts:339-358` é o runtime `runAgent`, outro caminho, acionado pelo dispatcher que hoje é no-op.) | `LlmBudgetExceededError` existente (`run-model-call.ts:59`) → handoff humano (`HANDOFF_REASON_ORCAMENTO`, `orcamento.ts:87`). Item `budget_exceeded` `ref_kind='plano'`, `ref_id=<org>`. Exige três ajustes: (1) `"plano"` entra em `InboxRefKind` e nos `refs` de `budget_exceeded` em `lib/ai/inbox-destino.ts:37,60`, porque hoje ref fora da lista vira "Este contexto não está disponível para você" (`:211-212`); (2) o dedup de `run-model-call.ts:381-384` (e o do worker legado) passa a filtrar `ref_kind`, senão o item do plano cala o do orçamento da org e vice-versa; (3) `retratarAvisos` (`app/api/v1/ai/budget/route.ts:324-330`) passa a filtrar `ref_kind='ai_budget'`, senão afrouxar o orçamento da org fecha o aviso do plano. Texto: "O uso de IA incluído no plano acabou neste mês. As conversas foram para a equipe. Troque de plano, cadastre uma chave de IA própria ou aguarde o próximo mês."<br>**80%:** cron da cobrança (§8), item `kind='cobranca'` `ref_kind='teto_ia'`, um por mês |

Régua de gasto única: `fn_gasto_de_ia_do_mes` (vigiada por `tests/unit/orcamento-uma-regua-de-gasto.test.ts`); soma o mês inteiro, inclusive BYOK (decisão D-9).

---

## 6. Contrato de provedor e adaptadores

`lib/cobranca/provedores/contrato.ts`:

```ts
export const PROVEDORES_DE_COBRANCA = ["stripe", "asaas"] as const;
export type ProvedorDeCobranca = (typeof PROVEDORES_DE_COBRANCA)[number];
export type Modo = "teste" | "producao";

export interface PlanoParaProvedor {
  id: string; nome: string; precoCents: number; intervalo: "mes" | "ano";   // moeda sempre BRL (§2.2)
}

/** O que o webhook AUTORIZA: acordar a leitura. Nunca é fonte de estado. */
export interface SinalDoWebhook { eventoId: string; tipo: string; clienteRef: string | null }

/** A única verdade que o provedor nos dá — relida na API. */
export interface Situacao {
  assinaturaRef: string | null;       // principal: a mais recente NÃO terminal; senão a mais recente
  existe: boolean;                    // principal não terminal E com o 1º pagamento confirmado
  assinaturasVivas: number;           // não terminais, inclusive as à espera do 1º pagamento
  cancelada: boolean;                 // nenhuma não terminal e a mais recente é terminal
  cancelaNoFim: boolean;
  emAtraso: boolean;                  // o provedor diz que a principal está devendo
  vencidaDesde: Date | null;          // só quando o provedor sabe a data (Asaas); Stripe: null
  proximoVencimento: Date | null;
  jaPagou: boolean;                   // houve pagamento confirmado (> 0) em qualquer assinatura do cliente
  emTesteNoProvedorAte: Date | null;  // principal em teste no provedor (Stripe `trialing`): fim do teste lá; Asaas: sempre null
  pagamentoSemAssinaturaViva: boolean;// pagou fatura de assinatura já terminal
  linkDePagamento: string | null;     // só de cobrança da principal NÃO terminal
  statusBruto: string;                // diagnóstico, vai para o audit
}

/** Só status HTTP e código do provedor. Nunca URL, header ou corpo (vão para log/Sentry). */
export class ErroDoProvedor extends Error {
  constructor(readonly status: number | null, readonly codigo: string,
              readonly transitorio: boolean, readonly credencialInvalida = false) {
    super(`provedor ${status ?? "sem_resposta"} ${codigo}`);
  }
}

export interface AdaptadorDeCobranca {
  readonly id: ProvedorDeCobranca;
  testarChave(): Promise<{ ok: true; modo: Modo } | { ok: false; motivo: "chave_invalida" | "sem_permissao" | "provedor_fora" }>;
  prepararWebhook(url: string, emailDoDono: string): Promise<{ segredo: string } | { manual: { url: string; segredo: string; eventos: string[] } }>;
  /** null = inválido. Corpo CRU. Tempo constante. Nunca lança. */
  verificarWebhook(corpoCru: string, headers: Headers, segredo: string, agora: Date): SinalDoWebhook | null;
  garantirCliente(org: { id: string; nome: string; email: string; documento: string | null }): Promise<string>;
  iniciarAssinatura(p: { clienteRef: string; orgId: string; plano: PlanoParaProvedor; trialAte: Date | null;
    urlDeVolta: string; chaveIdempotencia: string }): Promise<{ url: string; expiraEm: Date | null; assinaturaRef: string | null }>;
  lerSituacao(p: { clienteRef: string }): Promise<Situacao>;
  /** "Vale a partir da próxima cobrança gerada." Pode recusar com ErroDoProvedor não transitório. */
  trocarPlano(p: { assinaturaRef: string; plano: PlanoParaProvedor }): Promise<void>;
  cancelarNoFim(assinaturaRef: string): Promise<void>;
  urlDeGerenciar(p: { clienteRef: string; urlDeVolta: string }): Promise<string | null>;
}
```

- `fetch` injetado; chave lida por `valorDaInstalacao()` (`lib/instalacao/config.ts:152`) a cada uso; toda resposta por Zod lendo só os campos usados.
- Base de URL com override `COBRANCA_API_BASE_URL_TESTE` (§10), válido só para loopback.
- Leitura **por cliente** (mapa `(provedor, provedor_cliente_id) → org` é nosso). A org nunca sai do corpo.
- **Sentry:** `scrubMessage` (`lib/sentry/scrub.ts:76-88`) ganha `/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}/`, `/whsec_[A-Za-z0-9]{8,}/`, `/\$aact_[A-Za-z0-9_]{8,}/` → `[CHAVE]`, com um vetor por formato.

### 6.1 Stripe (`lib/cobranca/provedores/stripe.ts`)

**Base e cabeçalhos.** `https://api.stripe.com/v1`, form-encoded, `Authorization: Bearer sk_|rk_…`, `Stripe-Version` fixado numa constante; todo POST com `Idempotency-Key`.

**`testarChave`.** `GET /v1/balance`; `livemode` define o modo.

**`prepararWebhook`.**
1. `GET /v1/webhook_endpoints`, remove os da mesma URL.
2. `POST /v1/webhook_endpoints` com `checkout.session.completed`, `customer.subscription.created|updated|deleted|paused|resumed`, `invoice.paid`, `invoice.payment_failed`. **Nunca** `invoice.created` (não-2xx atrasa em até 72h a finalização).
3. `POST /v1/billing_portal/configurations` com `payment_method_update`, `invoice_history`, `subscription_cancel{mode:at_period_end}`, **sem** `subscription_update`; id em `STRIPE_PORTAL_CONFIG_ID` (diagnóstico, §10).

**`verificarWebhook`.** `Stripe-Signature: t=..,v1=..[,v1=..]`; HMAC-SHA256(`whsec`, `${t}.${corpoCru}`) contra **cada** `v1` com `timingSafeEqual` (rotação de 24h); ignora `v0`; tolerância 300 s. `eventoId = evt.id`, `clienteRef = data.object.customer`.

**`garantirCliente`.** `POST /v1/customers` com `email`, `name`, `metadata[organization_id]`.

**`iniciarAssinatura`.** Produto `POST /v1/products` `id=dc_plano_<uuid>` (`resource_already_exists` = ok); `POST /v1/checkout/sessions` com `mode=subscription`, `customer`, `client_reference_id=<org>`, `line_items[0][price_data]{currency=brl, unit_amount, recurring[interval], product}`, `quantity=1`, `subscription_data[metadata][organization_id|plano_id]`, `subscription_data[trial_end]` só com ≥ 48h de trial local, `success_url`/`cancel_url`. Formas de pagamento: as da conta (BR: cartão e boleto; sem Pix recorrente).

**`lerSituacao`** — o estado vem do **status da assinatura**:
1. `GET /v1/subscriptions?customer=&status=all&limit=10`. Terminal: `canceled`, `incomplete_expired`. Principal = mais recente não terminal.
2. `existe` = principal ∈ {`active`, `past_due`, `unpaid`, `paused`}. `trialing` (checkout concluído com `subscription_data[trial_end]`, nenhuma cobrança ainda) e `incomplete` (1º pagamento pendente, 23h) → `existe=false`, mas contam em `assinaturasVivas`. Com `trialing`, a tradução mantém `trial` até a 1ª fatura paga, como exige o contrato de `existe`. `emTesteNoProvedorAte` = `trial_end` da principal quando ela está `trialing`; senão `null`.
3. `emAtraso` = principal ∈ {`past_due`, `unpaid`, `paused`}. Cobre os três destinos que o painel oferece depois das tentativas (cancelar → terminal; `unpaid`; manter `past_due`). `vencidaDesde = null`: `due_date` é sempre nulo em `charge_automatically` e `created` é o dia da emissão, não do vencimento; `sincronizar` usa o instante em que viu o atraso pela primeira vez (≤ 6h de erro pela reconciliação, a favor do cliente).
4. `cancelaNoFim` = `cancel_at_period_end`; `proximoVencimento` = `current_period_end` do **item** da principal (a PR 3a confere contra a versão fixada em `Stripe-Version`, lendo uma assinatura criada na conta de teste, e o caso entra em `stripe.test.ts`).
5. `jaPagou`: `GET /v1/invoices?customer=&status=paid&limit=10`, alguma com `amount_paid > 0` (a fatura de trial de R$0 não conta).
6. `linkDePagamento`: `GET /v1/invoices?subscription=<principal>&status=open` → `hosted_invoice_url` da mais antiga; principal terminal ou ausente → `null` (a tela oferece "Assinar de novo").
7. `pagamentoSemAssinaturaViva`: a fatura paga mais recente (`amount_paid > 0`) é de assinatura terminal e foi paga depois de `ended_at` dela.

**`trocarPlano`.** Chamado no **agendamento**: `POST /v1/subscriptions/{id}` com `items[0][id]`, `items[0][price_data]{…product=dc_plano_<novo>}`, `proration_behavior=none`. A renovação seguinte já sai com o preço novo, e o plano local vira na mesma virada (§3.2).

**`cancelarNoFim`.** `cancel_at_period_end=true`. **`urlDeGerenciar`.** `POST /v1/billing_portal/sessions` com `customer`, `return_url`, `configuration`.

### 6.2 Asaas (`lib/cobranca/provedores/asaas.ts`)

**Base e cabeçalhos.** `https://api.asaas.com/v3` / `https://api-sandbox.asaas.com/v3` (a PR 3b confere as duas bases com `testarChave` no sandbox antes do merge), header `access_token`, `User-Agent` exigido.

**Datas.** `dueDate`/`nextDueDate` são data civil: convertidas para **23:59:59 America/Sao_Paulo** (`'2026-10-05'` → `2026-10-06T02:59:59Z`), porque o cliente paga até o fim do dia.

**`testarChave`.** `GET /customers?limit=1` nas duas bases; modo = base que autenticou.

**`prepararWebhook`.** `authToken` aleatório de 32 bytes (`ASAAS_WEBHOOK_TOKEN`); `POST /webhooks` com `{name, url, email, enabled:true, interrupted:false, sendType:"SEQUENTIALLY", authToken}` e eventos `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED`, `PAYMENT_OVERDUE`, `PAYMENT_DELETED`, `PAYMENT_RESTORED`, `PAYMENT_REFUNDED`, `PAYMENT_CHARGEBACK_REQUESTED`, `SUBSCRIPTION_CREATED`, `SUBSCRIPTION_UPDATED`, `SUBSCRIPTION_INACTIVATED`, `SUBSCRIPTION_DELETED`. Criação por API confirmada no sandbox antes da PR 3b; se falhar, devolve `manual`.

**`verificarWebhook`.** `asaas-access-token` em tempo constante; sem HMAC nem timestamp: corpo vale só como ponteiro. `eventoId = body.id`; `clienteRef = body.payment?.customer ?? body.subscription?.customer`.

**`garantirCliente`.** Exige CPF/CNPJ validado por dígito verificador, pré-preenchido de `organizations.cnpj`, **não gravado**; `GET /customers?externalReference=<org>` ou `POST /customers`.

**`iniciarAssinatura`.** Antes, `GET /subscriptions?customer=&status=ACTIVE`: se houver, reaproveita. `POST /subscriptions` com `{customer, billingType:"UNDEFINED", value, cycle, nextDueDate:max(hoje, trialAte), description, externalReference:<org>}`; `GET /subscriptions/{id}/payments` → `invoiceUrl` da primeira.

**`lerSituacao`:**
1. `GET /subscriptions?customer=&includeDeleted=true` (sem o parâmetro, a removida some da lista e o cancelamento viraria "trial vencido"). Terminal: `deleted:true`, `INACTIVE`, `EXPIRED`. Principal = mais recente não terminal.
2. `GET /payments?subscription=<principal>`: `existe` = principal não terminal **e** alguma cobrança `CONFIRMED`/`RECEIVED`/`RECEIVED_IN_CASH`. A assinatura nasce `ACTIVE` antes de qualquer pagamento; assinatura só com `PENDING` é o "incomplete" do Asaas (`existe=false`, conta em `assinaturasVivas`). Fecha o "clicar em Pagar agora reativa sem pagar".
3. `emAtraso` = alguma `OVERDUE` da principal, ou `REFUNDED`/`CHARGEBACK_REQUESTED` da cobrança do período corrente. `vencidaDesde` = menor `dueDate` dessas (fim do dia SP).
4. `CONFIRMED` (cartão pago, saldo não disponível) já conta como pago.
5. `proximoVencimento` = maior `dueDate` entre as cobranças confirmadas (`CONFIRMED`/`RECEIVED`/`RECEIVED_IN_CASH`) de qualquer assinatura do cliente, mais um `cycle`: é o fim do período pago. **Não** usar `nextDueDate`: na resposta ele é o vencimento da próxima cobrança ainda não gerada, e o Asaas gera cada cobrança 40 dias antes do vencimento (padrão; 14 ou 7 configuráveis). Ele fica um ciclo além do período pago e avança quando a cobrança é gerada, não quando é paga. Isso anteciparia a virada de `plano_agendado_id` (§3.2) e daria acesso além do pago no cancelamento (§7f). `sincronizar` só sobrescreve com não nulo.
6. `jaPagou`: `GET /payments?customer=&status=<s>&limit=1` para cada `s` em `RECEIVED`, `CONFIRMED` e `RECEIVED_IN_CASH` (o mesmo conjunto de pago do passo 2).
7. `linkDePagamento` = `invoiceUrl` da `OVERDUE` mais antiga ou da `PENDING`, só da principal não terminal.
8. `pagamentoSemAssinaturaViva`: cobrança confirmada de assinatura removida depois da remoção.

**`trocarPlano`.** Chamado no agendamento. **Guarda:** se a principal tem cobrança `OVERDUE`, ou `PENDING` com `dueDate` ≤ hoje (o período em uso ainda não pago), recusa com `ErroDoProvedor(null,'pagamento_do_periodo_pendente',false)` → tela: "Aguarde a confirmação do pagamento atual para trocar de plano." Passada a guarda, `PUT /subscriptions/{id}` com `{value, description, updatePendingPayments:true}`. As pendentes que sobram são todas de períodos futuros (com a geração 40 dias antes, um plano mensal pode ter duas ao mesmo tempo), e todas devem levar o valor novo. Não usar `dueDate < nextDueDate` como guarda: `nextDueDate` é o vencimento da próxima cobrança ainda não gerada, então toda cobrança existente passa na condição e a troca seria recusada sempre que houvesse qualquer pendente.

**`cancelarNoFim`.** `DELETE /subscriptions/{id}`; o `proximo_vencimento` gravado segura o acesso. **`urlDeGerenciar`.** `linkDePagamento`.

### 6.3 Mercado Pago (depois, mesmo encaixe)
`x-signature` é HMAC do manifest (`id:;request-id:;ts:`), não do corpo — reler é o desenho. `preapproval.status`: `cancelled` → terminal; auto-cancelamento após 3 recusas cai em `cancelada`. `existe` exige pagamento autorizado.

### 6.4 Registro
`lib/cobranca/provedores/index.ts: adaptador(id)` — um mapa.

---

## 7. Fluxos ponta a ponta

**Regra comum: nenhuma chamada HTTP ao provedor dentro de transação ou com lock de banco aberto** (anti-pattern 9, estendido). Leitura/escrita externa primeiro; depois transação curta com compare-and-set; e-mails depois do commit.

### (a) Revendedor liga, conecta, testa e publica
1. **Ligar** em `/admin/sistema › Cobrança dos seus clientes` → `gravarModulo` (`lib/instalacao/modulos.ts:210`). Aviso: "Empresas que já existem ficam isentas; você escolhe quem passa a pagar."
2. **Conectar** em `/admin/cobranca › Conexão` (rota `POST /api/v1/admin/cobranca/conexao`, `requirePlatformAdminEscrita()`):
   - `urlPublicaUsavel(env.NEXT_PUBLIC_APP_URL)` **e** protocolo `https:`. `urlPublicaUsavel` (`lib/escalacao/url-publica.ts:53`) aceita `http:` (`ESQUEMAS`, `:30, 61`), e a Stripe só registra endpoint HTTPS em produção. O valor é lido de `lib/env` em runtime, nunca `process.env.NEXT_PUBLIC_*`, cujo valor inlinado no build é `https://placeholder.invalid`, `Dockerfile:27`). Recusa: "Seu sistema precisa estar num endereço https público para receber avisos de pagamento." **Exceção única:** com `COBRANCA_API_BASE_URL_TESTE` válida (loopback, o provedor é o stub), aceita URL de loopback — teste nos dois sentidos.
   - `testarChave` + `prepararWebhook`; grava cifrado por `gravarPelaTela` (`lib/instalacao/config.ts:193`), que falha fechada sem chave de cifra.
   - **Guarda de servidor:** não troca de provedor nem apaga a chave de um provedor que tenha linha em `cobranca_assinaturas` com `provedor` = ele e `modo='producao'` → 409 `provedor_com_assinaturas`. Trocar a chave do **mesmo** provedor de `teste` para `producao` é a Publicação (passo 5), feita por esta mesma rota: havendo linhas `modo='teste'` e sem `confirmar_publicacao:true` no corpo → 409 `publicacao_requer_confirmacao` com `details.assinaturas_de_teste` (contagem) para a tela listar; com a confirmação, grava a chave nova e aplica o passo 5 às linhas `modo='teste'` depois de `testarChave`/`prepararWebhook`. Corpo: `{ provedor: 'stripe'|'asaas', chave: string, confirmar_publicacao?: boolean }`; resposta `ok({ modo, webhook: 'automatico' | { manual: { url, segredo, eventos } } })`.
   - Mostra o selo **MODO DE TESTE** ou **PRODUÇÃO** pelo que o provedor respondeu.
   - Audita `cobranca.provedor_conectado` (last4 antigo e novo) e manda e-mail a todo platform admin `scope='full'`: "A chave de cobrança da instalação foi trocada (…1234 → …5678)."
   - Esta rota é o **único** escritor das chaves de credencial e de provedor da cobrança (`STRIPE_*`, `ASAAS_*`, `COBRANCA_PROVEDOR`); `COBRANCA_TOLERANCIA_DIAS` é escrita só pela aba Régua de `/admin/cobranca`, com `requirePlatformAdminEscrita()`. Fora delas, `salvarConfiguracaoDaInstalacao`/`voltarConfiguracaoAoPadrao` (`app/actions/admin/salvarConfiguracaoDaInstalacao.ts:59-76, 116-122`) recusam chave com `telaDona === "cobranca"`.
3. **Planos:** cria um e marca "plano do cadastro (teste grátis de N dias)".
4. **Checklist** em `/admin/cobranca`:
   - [x] chave conectada;
   - [x] aviso de pagamento recebido — `max(received_at)` em `webhook_events_log` do provedor **ou** existe assinatura `ativa` com provedor (prova que o caminho funcionou; sobrevive à poda de D+90);
   - [ ] compra de teste concluída ("crie uma empresa de teste e pague com o cartão 4242…" / "pague o boleto no sandbox");
   - [ ] e-mail configurado (aponta para `/admin/email`).
5. **Publicar** (trocar a chave de teste pela de produção): a tela lista as assinaturas `modo='teste'` e avisa que voltam a `trial`; ao confirmar, zera `provedor`, `modo`, `provedor_cliente_id`, `provedor_assinatura_id`, `checkout_url`, `checkout_expira_em`, `vencida_desde`, `ultimo_aviso` e `ultimo_aviso_em` (o CHECK de §2.3 exige zerar provedor e cliente juntos), `estado='trial'`, `trial_ate=now()+trial_dias`, audita `cobranca.modo_publicado`.

### (b) Cadastro → trial → checkout → ativa
1. Cadastro em modo `aberto` (`lib/auth/politica-de-cadastro.ts:176`) → `ensureTenantForUser` → `fn_trial_na_criacao_da_org` cria o `trial`.
2. `/app` mostra aos admins a faixa "Teste grátis: faltam N dias · Assinar" (só com `cobranca` em `modulosLigados`).
3. "Assinar" → `POST /api/v1/cobranca/assinatura/checkout` (`requireRole('admin', {permiteOrgSuspensa:true})`, org da sessão, `comIdempotencia`, `lib/api/idempotency.ts`), corpo `{ documento?: string }` (só dígitos, 11 ou 14, DV validado → senão 422 `documento_invalido`; obrigatório quando `COBRANCA_PROVEDOR='asaas'` → 422 `documento_obrigatorio`; a tela pré-preenche de `organizations.cnpj`; nunca gravado). `garantirCliente` recebe `nome = organizations.legal_name` e `email` = e-mail do usuário da sessão (a org não tem coluna de e-mail):
   - **Fase 1 (transação curta, `for update`):** `checkout_url` válido → devolve o mesmo; `checkout_expira_em > now()` com `checkout_url` nulo → 409 `checkout_em_preparo` ("já estamos gerando seu link"); senão grava `checkout_url=null, checkout_expira_em=now()+2min` (reserva) e comita.
   - **Fase 2 (fora de transação):** `lerSituacao`; se `assinaturasVivas > 0` (inclui `incomplete` e Asaas com `PENDING`) → limpa a reserva e 409 `pagamento_em_andamento` ("você já tem um pagamento em andamento") com `details.link_de_pagamento`; senão `garantirCliente`, `iniciarAssinatura`. Falha do provedor → 503 `provedor_indisponivel` (transitório) ou 502 `provedor_recusou`. Os códigos novos entram em `lib/api/errors.ts`.
   - **Fase 3 (update condicional):** grava `provedor`, `modo`, `provedor_cliente_id`, `checkout_url`, `checkout_expira_em`; audita `cobranca.checkout_iniciado`; devolve `{url}`. Falha na fase 2 limpa a reserva.
4. Volta (`?voltou=1`) → `POST /api/v1/cobranca/assinatura/sincronizar` (1 por 30 s por org, `checkRateLimit`): "Confirmando seu pagamento…". Cartão → `ativa`; boleto/Pix pendente → "Aguardando o pagamento. O boleto leva até 1 dia útil." `checkout_url` é limpo quando a sessão aparece concluída.

### (c) Webhook → sinal → estado
`POST /api/v1/webhooks/cobranca/[provedor]` (prefixo público, `lib/auth/public-paths.ts:35`; Caddy/Traefik só bloqueiam `/api/v1/webhooks/waha`, `docker-compose.traefik.yml:99-105`):
1. 404 se provedor fora da lista, chave desligada ou sem segredo (molde `app/api/v1/tenants/provision/route.ts:43-110`).
2. `checkRateLimit` por IP, 120/min.
3. `await req.text()` (≤ 1 MB) → `verificarWebhook`; inválido → 401 + `logger.warn` + contador.
4. `insert webhook_events_log` na forma de §2.4 (org nula, sem cabeçalhos, corpo `{id,type}`). `23505`: se a linha existente está `processed` → 200 (duplicado); se está `received` → segue para o passo 5 (o emit anterior falhou; reemitir é inofensivo porque o consumidor relê).
5. Org por `cobranca_assinaturas(provedor, provedor_cliente_id)`. Sem org → `status='error'`, `cliente_desconhecido`, 200 (a reconciliação cura). Com org → `emit_event('cobranca.sinal', org, {provedor, evento_id})` → `update ... status='processed', processed_at=now()` → 200. Falha no emit → 503 (o provedor reentrega e cai no ramo `received`).

**Consumidor `cobrancaSinalHandler`** (`naOrgParada:"roda"`):
- **Coalescer:** `relida_em > now() − 30s` → `{status:"retry", retry_at: relida_em + 30s}` (`dispatcher.ts:45-48`; o drain reagenda sem contar tentativa). Um `cobranca.sinal` forjado por membro via `emit_event` custa, no máximo, o mesmo que o botão "Já paguei".
- Chama `sincronizar(org)` (`lib/cobranca/sincronizar.ts`):
  1. **Fora de transação:** `lido_em = now()`; `lerSituacao`. Falha → `ultimo_erro`/`ultimo_erro_em` (`credencial_invalida` / `provedor_fora` / `leitura_invalida`) numa escrita curta, estado intacto, `retry` do drain.
  2. **Transação curta** com `pg_advisory_xact_lock(hashtextextended(org::text, 2283))` e `select ... for update`: se `relida_em >= lido_em`, descarta (uma leitura mais nova já foi aplicada). Senão: tradução + regras de gravação (§3.2), audit `cobranca.estado_mudou` com `statusBruto` **só se mudou**, régua e ação por funções SQL idempotentes; os avisos são gravados por `update ... set ultimo_aviso=$1, ultimo_aviso_em=now() where ... returning`.
  3. **Depois do commit:** e-mails das linhas de aviso ganhas.
- Evento que morre → `event_dead` na Central pelo drain existente.

### (d) Falha → tolerância → aviso → suspensão → pagamento → reativação
1. `invoice.payment_failed`/`customer.subscription.updated` (`past_due`) ou `PAYMENT_OVERDUE` → (c) → `em_atraso`.
2. **Avisos** (só org `active` ou `suspended{cobranca}`):
   - `venceu`: "Não identificamos o pagamento de DD/MM. Se pagou boleto, aguarde a compensação."
   - Canais: e-mail aos admins da org por `sendEmail` (`lib/email/roteador.ts:110`) com `marcaDaSaida(org)` (`lib/branding/saida.ts:184`), no idioma de `organizations.locale` e datas no `organizations.timezone`; item `kind='cobranca'` na Central; faixa vermelha em `/app`. E-mail que falha não é reenviado (Central e faixa seguem).
3. `suspende_em_breve` (critical): "Sua conta será suspensa em DD/MM se o pagamento não for confirmado."
4. No limite (§3.2), no cron: releitura → `fn_suspender_organizacao(org,'cobranca',…)` → e-mail "Conta suspensa por falta de pagamento" → audit `cobranca.org_suspensa`.
5. `/account-suspended`: admin vê "Pagar agora" (`linkDePagamento` ou portal) e "Já paguei" (`sincronizar`); sem link (principal terminal) vê "Assinar de novo"; não admin lê "Avise o administrador da sua empresa".
6. `invoice.paid`/`PAYMENT_CONFIRMED` → (c) → `ativa` → reativa → item `org_reativada` + e-mail "conta liberada" + audit `cobranca.org_reativada`. Nada sai em rajada.

### (e) Troca de plano (upgrade e downgrade)
`POST /api/v1/cobranca/assinatura/plano {plano_id}`, só admin:
- só planos não arquivados do mesmo intervalo (senão 422 `plano_invalido`); recusa com estado `em_atraso`/`cancelada` → 409 `pagamento_pendente` ("regularize o pagamento antes"); recusa do Asaas `pagamento_do_periodo_pendente` → 409 com esse mesmo código;
- downgrade: uso atual precisa caber, senão 409 `plan_limit_reached` com `details: { excedente: { assentos?: number, canais?: number } }` (só os > 0), que a tela transforma em "remova 2 pessoas e 1 número"; a mesma checagem vale no `PATCH` admin de §7g;
- **durante o teste grátis (`trial_ate > now()`, com ou sem provedor — decisão D-13):** troca imediata de `plano_id`; com provedor, chama também `trocarPlano` para que a primeira cobrança saia com o preço novo (no Asaas, a guarda `pagamento_do_periodo_pendente` não se aplica aqui: a cobrança pendente é a primeira, com vencimento em `trial_ate`, e é ela que deve levar o valor novo);
- **depois do teste, com provedor:** grava `plano_agendado_id`, chama `trocarPlano` (fora de transação; Asaas pode recusar com `pagamento_do_periodo_pendente`), e o plano local vira na **virada do ciclo paga** (§3.2). Tela: "O novo plano vale a partir de DD/MM." Nem upgrade nem downgrade mudam limite antes de pagos — fecha o subir no dia 1 e descer no dia 28;
- audita `cobranca.plano_trocado` (agendado e aplicado).

### (f) Cancelamento
`POST /api/v1/cobranca/assinatura/cancelar`: "Você mantém o acesso até DD/MM." → `cancelarNoFim`. Stripe: `cancela_no_fim=true`, estado segue `ativa`; Asaas: `cancelada` (lida com `includeDeleted`), `proximo_vencimento` mantido. Em `proximo_vencimento`, a régua avisa e suspende 48h depois ("Você cancelou. Assine de novo para voltar"). Reassinar pela mesma tela, inclusive do hub.

### (g) Platform admin, pelo card de cobrança no tenant
Tudo com `requirePlatformAdminEscrita()` e audit:
- **Rotas do dono** (todas `requirePlatformAdminEscrita()`, 404 com a chave desligada, audit):
  - PR 2: `POST /api/v1/admin/cobranca/planos` `{nome, preco_cents, intervalo, trial_dias, max_assentos?, max_canais?, teto_ia_usd_cents?, padrao_no_cadastro?}` → `plano_salvo`; `PATCH /api/v1/admin/cobranca/planos/[id]` (mesmos campos + `arquivado: boolean`) → `plano_salvo`/`plano_arquivado`; mudar `preco_cents` ou `intervalo` com assinatura em `plano_id` ou `plano_agendado_id` → 409 `plano_com_assinantes` ("arquive e crie outro"); dois padrões → 409 `state_conflict` (índice `cobranca_planos_um_padrao`).
  - PR 2: `POST /api/v1/admin/tenants/[id]/assinatura` `{plano_id}` (sem linha) cria `trial` com os dias do plano; linha existente → 409 `state_conflict`. `PATCH` na mesma rota `{plano_id}` = trocar plano (regras de §7e). `POST .../assinatura/prazo` `{ate}` (≤ 60 dias; senão 422) → `prazo_concedido`. `DELETE .../assinatura` = tornar isenta → `isencao_definida`.
  - PR 3a: `PATCH /api/v1/admin/cobranca/regua` `{tolerancia_dias}` (5–30; fora → 422), única escritora de `COBRANCA_TOLERANCIA_DIAS`; a aba Régua entra na PR 3a.
- **Atribuir plano** (sem linha): cria `trial` com os dias do plano.
- **Trocar plano** (com linha): o **mesmo caminho de (e)** — `trocarPlano` com provedor, agendado para a virada; **nunca** mexe em `estado`, `trial_ate` ou `vencida_desde`.
- **Dar prazo até DD/MM** (≤ 60 dias): grava `prazo_extra_ate`; se a suspensão é de cobrança, `fn_reativar_organizacao(org,'cobranca')`.
- **Tornar isenta:** linha com `provedor is null` (o único caso possível na PR 2) → apaga direto; com provedor (PR 3a em diante) → apaga só se `lerSituacao` mostra `assinaturasVivas = 0`, senão 409 `assinatura_viva_no_provedor` ("cancele no provedor antes"); leitura que falha → 503, nada apagado. Reativa se a suspensão era de cobrança.
- **Suspender/reativar administrativa:** §4, item 19.

### (h) Desligar a chave
`/admin/sistema` mostra "N empresas suspensas por falta de pagamento serão liberadas" (N = `count` de `organizations` com `status='suspended' and suspended_kind='cobranca'`, lido pela página) e, na PR 2, `app/actions/settings/updateModuloDaInstalacao.ts` ganha o ramo `modulo==='cobranca' && !ligado`: depois de `gravarModulo`, `rpc('fn_cobranca_liberar_suspensoes', {p_ator})` e audit `cobranca.modulo_desligado` com `{liberadas}`. A action passa a `requirePlatformAdminEscrita()`. Limites e régua deixam de valer; nada é cancelado no provedor (a tela avisa).

---

## 8. Crons e workers

| Peça | Rota / lugar | Frequência | Idempotência | Audit |
|---|---|---|---|---|
| **Cron da cobrança** | `app/api/v1/cron/cobranca/route.ts` + `43 * * * *\|120\|api/v1/cron/cobranca` em `CRONS` (`docker/scheduler/entrypoint.sh:59-130`; comentário fora da string, sem crase nem `$`, `:56-58`) | horária | `autorizaCron` (`lib/auth/cron-auth.ts:25-44`); chave desligada → `ok({pulado:'modulo_desligado'})` | Só com efeito: uma linha `cobranca.rodada` com contagens (`cron-audita-so-quando-ha-efeito`, `cron-routes-scheduled`) |
| Consumidor `cobranca.sinal` | `lib/cobranca/sinal.handler.ts` em `lib/event-log/register-handlers.ts`, `naOrgParada:"roda"` | segundos (loop do worker; `event-log-drain` como rede) | coalescer por `relida_em`; compare-and-set; lock curto | `cobranca.estado_mudou`, `org_suspensa`, `org_reativada`, só quando muda |
| Sincronização sob demanda | `POST /api/v1/cobranca/assinatura/sincronizar` | 1/30 s por org | a mesma `sincronizar()` | igual |

**Passos do cron:**
1. **Reconciliação** — até 50 linhas com `provedor is not null`, ordenadas por `relida_em nulls first`, que satisfaçam `(relida_em is null or relida_em < now() - interval '6 hours')` **e** uma de:
   - `estado <> 'cancelada'`;
   - `estado = 'cancelada'` e a org está `suspended{cobranca}` (pode ter reassinado e pago por boleto com o webhook perdido);
   - `estado = 'cancelada'` e `checkout_expira_em > now() - interval '30 days'` (checkout recente pode ter virado pagamento).
   Somam-se as candidatas à suspensão sem releitura de < 1h. Cobre a fila do Asaas interrompida depois de 15 falhas, a Stripe desistindo em 3 dias e a VPS fora do ar. Cada leitura é `sincronizar()` (HTTP fora de transação).
2. **Transições de tempo e régua** para as demais linhas, só com o banco. A exceção é `redacted`/`archived` → `cancelarNoFim`, que é chamada HTTP ao provedor e segue a regra comum de §7 (fora de transação, antes da escrita curta).
3. **Aviso de IA a 80%** para planos com teto.

Sem "pulso" gravado: a saúde do cron aparece derivada (§9).

**Cadência:** uma hora basta (reativação é por evento; suspensão é régua em dias). O cron novo chega à VPS na release seguinte (`update.sh:616-656` grava `SCHEDULER_IMAGE`).

---

## 9. Telas (com porta)

### Admin da plataforma

**`/admin/sistema`** — nova linha "Cobrança dos seus clientes":
- `MODULOS_OPCIONAIS`, `MODULOS_OPCIONAIS_POR_FLAG`, `CHAVE_DO_MODULO.cobranca = "MODULO_COBRANCA"` (`lib/instalacao/modulos.ts:50-94`); `MODULOS_NA_TELA` (`app/admin/(protected)/sistema/_form.tsx:190`); `TEXTO_DO_MODULO` (`lib/recursos-opcionais/catalogo.ts:99`, `Record` exaustivo);
- **novo** `MODULOS_SO_DA_INSTALACAO: readonly ModuloOpcional[] = ["cobranca"]` em `modulos.ts`, filtrado em `app/app/settings/recursos/page.tsx:54`: a empresa (manager+) **não** vê "Cobrança dos seus clientes — Desligado por quem administra o servidor". Teste afirma a ausência;
- em `MODULOS_AINDA_NAO_LIGAVEIS` (`modulos.ts:204`) durante a PR 2; sai na PR 3a.

**`/admin/cobranca`** (`app/admin/(protected)/cobranca/page.tsx`), abas:
- **Visão geral:** checklist de publicação (§7a); selo TESTE/PRODUÇÃO; "último aviso do provedor há X" (`max(received_at)`; "nenhum nos últimos 90 dias" além da poda); **"última leitura bem-sucedida há X"** = `max(relida_em)` das linhas com provedor que a reconciliação seleciona (§8; fica fora a `cancelada` antiga de org ativa), vermelho > 7h (é a saúde do cron: a reconciliação relê essas linhas a cada 6h); **problemas do dono**, derivados do estado: "N clientes com leitura falhando: chave inválida" (`ultimo_erro='credencial_invalida'`), "N clientes com duas assinaturas ativas — cancele uma no painel do provedor" (`assinaturas_vivas > 1`), "N pagamentos de assinatura cancelada — dê prazo ou estorne" (`ultimo_erro='pagamento_de_assinatura_cancelada'`); eventos `error`/`dead`.
- **Conexão:** provedor; chave (`last4`); "Testar e conectar"; URL do webhook; modo manual do Asaas.
- **Planos:** criar, editar, marcar padrão, arquivar; recusa preço < R$ 5; avisa que preço e intervalo travam com assinante.
- **Régua:** tolerância (piso 5, teto 30, padrão 7).
- **Clientes:** empresa, plano (e agendado), estado, vencida desde, próximo vencimento, última leitura (vermelho > 26h, só nas linhas que a reconciliação seleciona, §8), último erro. Ações: dar prazo, isentar, trocar plano, copiar link, abrir no tenant.
- **Porta:** `components/admin/AdminSidebar.tsx:34-110`; `NavItem` ganha `modulo?`; o layout admin passa `modulosLigados`; entrada `{href:'/admin/cobranca', label:'Cobrança', modulo:'cobranca'}`. Vigiado por `tests/unit/admin-navegacao-completude.test.ts`.

**`/admin/tenants/[id]`:** com a chave desligada, `TenantOverview.tsx:98-99,118-119` segue igual. Ligada: card "Cobrança" (plano, agendado, estado, atribuir/trocar, dar prazo, isentar) e "Rótulo antigo: X" se `settings.plan` existir. `TenantActions.tsx` mostra o **tipo** da suspensão; "Reativar" só para a administrativa; para a de cobrança, "Dar prazo" e "Isentar".

**`/admin/tenants/new`:** chave desligada → formulário atual (`app/admin/(protected)/tenants/new/_form.tsx:88,281-298`, enum `plan`). Ligada → select de `cobranca_planos` + "Sem cobrança (isenta)". `lib/schemas/tenant-creation.ts:14,19` ganha `plano_id: z.string().uuid().optional()` ao lado de `plan`; audit metadata (`app/api/v1/admin/tenants/route.ts:222`) acompanha.

### Cliente final

**`/app/settings/billing`** — chave desligada: placeholder atual (`app/app/settings/billing/page.tsx:17-52`) intocado. Ligada: `components/cobranca/PainelDaAssinatura.tsx`:
- estado em linguagem simples ("Teste grátis até…", "Em dia", "Em atraso desde…", "Cancelada, acesso até…", "Novo plano a partir de…");
- uso contra limites (pessoas x/y, números x/y, IA US$ gasto/teto);
- ações: Assinar / Pagar agora, Já paguei, Gerenciar pagamento, Trocar de plano, Cancelar, Assinar de novo;
- faixa MODO DE TESTE quando for o caso.
- **Porta:** entrada existente `lib/navigation/catalogo.ts:971-979` (sem `modulo`, para não sumir com a chave desligada), `minRole:"admin"`. Hoje o label é "Billing" (dicionário `es` "Facturación", `zh-CN` "账单") e "Plano e cobrança." é só a descrição. O label passa a "Plano e cobrança", com entrada nova no dicionário (`es` "Plan y facturación", mais `zh-CN`), para que a mensagem de §5 ("Configurações › Plano e cobrança") aponte para um item que existe.

**Faixa em `app/app/layout.tsx`** (trial ≤ 7 dias, `em_atraso`, cancelamento agendado), lida só com `cobranca` em `modulosLigados`.

### Suspenso
**`/account-suspended`** (fora de `app/app/`) vira o hub: `requireAuth()` + `orgAtivaSemPortao()`.
- Org operante → redireciona para `/app`.
- kind `cobranca` + chave ligada + admin → `PainelDaAssinatura`.
- Não admin → "Avise o administrador da sua empresa".
- kind `administrativa` → texto atual com `emailDeSuporte()`.
- Todos: "Pedidos de LGPD" reusando `app/app/lgpd/requests/RequestsTable.tsx` (extrair a parte de dados se depender do layout de `/app`), e "Trocar de empresa" quando há outra org ativa.
- **Porta:** redirect do §4 item 3, links do e-mail e da Central.

### Onboarding
Nada novo: trial automático, faixa como porta.

### i18n
Todo texto novo de tela, menu e e-mail entra no dicionário com `es` (e `zh-CN` onde o painel exige) **no mesmo PR** da tela; e-mails no idioma de `organizations.locale`.

---

## 10. Configuração

| Item | Onde mora | Cifrado? | Catálogo (`lib/instalacao/catalogo.ts`) | Padrão |
|---|---|---|---|---|
| Liga/desliga | `platform_config.MODULO_COBRANCA`, tela `/admin/sistema` | não | (mecanismo de módulos, não catálogo) | ausente = desligado |
| `COBRANCA_PROVEDOR`, `COBRANCA_TOLERANCIA_DIAS` | `platform_config` | não | `controle:'edita'`, `telaDona:'cobranca'` | tolerância 7 (piso 5 no código) |
| `STRIPE_SECRET_KEY` (`rk_` recomendada), `STRIPE_WEBHOOK_SECRET`, `ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN` | `platform_config` `eh_segredo=true`, AES-256-GCM, chave `AI_CRED_AES_KEY` fora do banco (`baseline.sql:43400-43450`; `config.ts:193-245`) | sim; tela vê `last4`; nunca em query string | `controle:'edita'`, `telaDona:'cobranca'` | sem chave de cifra, nada é gravado |
| `STRIPE_PORTAL_CONFIG_ID` | `platform_config`, escrito só pela máquina | não | `controle:'diagnostico'` com motivo; nunca lido por `valorDaInstalacao` | — |
| `COBRANCA_API_BASE_URL_TESTE` | `lib/env.ts`, `z.string().optional().default("")`; só loopback (senão ignorada, com log); em `.env.example` (`env-example-sync`), **não** em `.env.hostgator.example` | — | — | vazio = URLs oficiais |

- `telaDona` (`catalogo.ts:73`) ganha `"cobranca"` (`chave-da-instalacao-mora-numa-tela-so.test.ts`); leitores usam `valorDaInstalacao` (`painel-nao-promete-o-que-nao-cumpre.test.ts`).
- **Escrita das chaves `telaDona:'cobranca'` só pela rota de Conexão/Régua** (§7a); as ações genéricas recusam, com teste. Sem isso, a ação genérica (que só confere `controle`) trocaria a chave Stripe sem `testarChave`, sem a guarda de assinaturas vivas e com rastro de uma linha só.
- Sem edição manual: `update.sh` não muda; URL do webhook sai de `NEXT_PUBLIC_APP_URL`; `SUPPORT_EMAIL` reusado.
- Trocar `AI_CRED_AES_KEY`: segredos ilegíveis → leitura falha como `credencial_invalida` → estado intacto, nenhuma suspensão, e a Visão geral mostra.

---

## 11. Migrations, baseline, MANIFEST e tipos

**Números:** o próximo livre **no merge** — a main vai até `0491`, e o teto é a main **mais** as cabeças de todo PR aberto (número e carimbo).

**Regras:** idempotente (`if not exists`, `create or replace`, `drop trigger if exists` + `create`, `drop constraint if exists` + backfill + `add`); sem `BEGIN`/`COMMIT` nem temp table; apêndice rotulado antes da VARREDURA anon (`baseline.sql:42990`); tabelas antes das chamadas finais de `fn_proteger_tabelas_de_organizacao`/`fn_aplicar_travas_de_suporte` (`:43777`, `:43787`).

| PR | Migration (slug) | Conteúdo |
|---|---|---|
| 1 | `_org_operante_e_suspensao_tipada` | `suspended_kind` (backfill antes do CHECK); `fn_org_operante`; `fn_organizacao_estado_so_pelo_servidor` + gatilho; `fn_suspender_organizacao`/`fn_reativar_organizacao`; kind `'org_reativada'` no bloco único do CHECK de `agent_inbox_items` + reconstrução; revoke das duas origens em cada função |
| 2 | `_cobranca_planos_e_assinaturas` | as 2 tabelas (RLS, policy, revokes, grants); `fn_cobranca_ligada`, `fn_limite_do_plano`, `fn_cobranca_liberar_suspensoes`; os 3 gatilhos; `create or replace fn_create_tenant_with_owner` (mantém `settings.plan`); `create or replace` de `fn_suspender_organizacao` (ganha a guarda `org_isenta` do kind `cobranca`) e de `fn_reativar_organizacao` (ganha o passo 7, zerar `ultimo_aviso` na assinatura) — na PR 1 as duas **não** citam `cobranca_assinaturas`, que ainda não existe (plpgsql só resolve a relação ao executar, e o `UPDATE` do passo 7 daria `42P01` em toda reativação); revoke das duas origens repetido; `drop column if exists ai_budget_cents, rate_limit_rps` |
| 3a | `_cobranca_webhook_e_avisos` | `'stripe','asaas'` no bloco único do CHECK de provider; `uniq_webhook_events_log_cobranca`; kind `'cobranca'` no bloco único de `agent_inbox_items` + reconstrução |

- **MANIFEST:** uma linha por migration; `merge=union` → conferir duplicata depois de **cada** merge.
- **Tipos:** regenerar `lib/database.types.ts`.
- **Vocabulário:** `suspended_kind`, `estado`, `provedor`, `modo`, `ultimo_aviso`, `ultimo_erro`, `intervalo`, `moeda` no invariante.
- **Prova:** `pnpm test:db` (install `ON_ERROR_STOP=1` + update); CI em pg15 e pg17. `supabase/config.toml:29` diz `major_version = 15` e o baseline não usa `GRANT MAINTAIN`; o CLAUDE.md diz o contrário e é corrigido na PR 1 (DoD 16).
- **Fragmentos `.changes/`:**
  - PR 1: `corrigido` / `nada_mudou` — "suspender uma empresa passa a calar a IA e os envios dela; quem tem acesso só de leitura ao painel deixa de poder alterar dados".
  - PR 2: `alterado` / `nada_mudou` — a capacidade existe no código mas ainda não pode ser ligada (`MODULOS_AINDA_NAO_LIGAVEIS`), e nada que o operador vê muda. PRs 3a e 3b: `adicionado` / `capacidade_nova`. Válido porque, com a chave desligada, nada que existia some nem muda de forma (§2.1, §9); as colunas removidas não têm leitor nem tela.
- **Docs (DoD 16):** `docs/specs/01-spec-platform-base.md:101-102`; comentário de `lib/campanhas/rodada.ts:100-102`; CLAUDE.md (pg15).

---

## 12. Testes

### Unit (`pnpm test:unit`, a suíte inteira, sem caminho)

**Cobrança:**
- `lib/cobranca/regua.test.ts`: trial vencendo; trial vencido sem provedor suspende; boleto aberto não vencido não suspende; piso de 5 dias com configuração 0; `prazo_extra_ate`; aviso final ≥ 48h; releitura > 1h bloqueia; `cancelada` com e sem `proximo_vencimento`; reativação; guarda do kind; **pagou depois do aviso final, no mês seguinte a régua acorda depois do limite → primeiro avisa, só suspende 48h depois**; org `suspended{administrativa}` não recebe aviso; org `redacted` → `cancelarNoFim`, sem aviso.
- `lib/cobranca/estado.test.ts`: tradução; `vencida_desde` monotônico; **cancelar e reassinar não zera `vencida_desde`**; `proximo_vencimento` não é apagado por leitura nula; `ultimo_aviso` zera na volta a `ativa`/`trial`; `plano_agendado_id` aplicado só na virada paga.
- `stripe.test.ts`: segundo `v1` aceito, `v0` recusado, `t` fora de 300 s, corpo alterado; `testarChave` por `livemode`; **um caso por status**: `unpaid` sem fatura aberta → em atraso; `paused` → em atraso; `past_due` → em atraso; `active` com fatura aberta de boleto dentro da validade → em dia; `incomplete` → `existe=false` e `assinaturasVivas=1`; fatura de trial R$0 não conta em `jaPagou`; **auto-cancelada + reassinatura paga + fatura antiga aberta → `ativa`** (faturas pela assinatura); `linkDePagamento` nulo com principal terminal.
- `asaas.test.ts`: token em tempo constante; `includeDeleted=true` na URL; **cancelar (DELETE) no dia 2 de mês pago → `cancelada` com acesso até o fim do período**; **assinatura ACTIVE só com `PENDING` → `existe=false` ("suspenso clica Assinar e não paga → continua suspenso")**; `CONFIRMED` conta como pago; `REFUNDED`/chargeback reabrem; `'2026-10-05'` → `2026-10-06T02:59:59Z` e texto "05/10"; `trocarPlano` recusa com período corrente pendente e manda `updatePendingPayments:true` quando pago; CPF/CNPJ.
- `lib/sentry/scrub.test.ts`: um vetor por formato (`sk_live_`, `rk_test_`, `whsec_`, `$aact_`).

**Predicado, autorização e limites:**
- `lib/agent-engine/edge/llm/orcamento.test.ts` (novo; as decisões atuais de orçamento moram em `tests/unit/orcamento-decisao.test.ts`) (`decidirTetoDoPlano`): BYOK nunca bloqueia; purpose isento segue; `modo 'off'` da org não desliga o teto; `chave 'off'` desliga.
- `credentials`/`run-model-call`: **injetar `42883` na consulta do teto prova que o `modo` de `ai_budgets` continua aplicado** e que `SQL_CONFIG_COM_ORCAMENTO` não mudou.
- `gate.test.ts`: `orgStatus` não operante vence todos os vetos.
- `tests/unit/dispatcher-org-parada.test.ts`: `pula` + org parada → `skipped` em `consumed_by`; lista literal dos `roda`.
- `require-role.test.ts`: 403 `org_suspended`; `permiteOrgSuspensa` libera; **`allowPlatformAdmin:true` com `support_readonly` → 403; com `full` e MFA em dívida → 403; `"leitura"` libera `support_readonly`.**
- `resolveApiToken`: recusa sem debitar o balde.
- `sendMessageHandler`: `OrgNaoOperanteError` terminal no settle.
- Ações genéricas de configuração recusam chave `telaDona:'cobranca'`.
- Rota de conexão: localhost recusado sem `COBRANCA_API_BASE_URL_TESTE`, aceito com ela; `placeholder.invalid` recusado.
- Webhook: `23505` com linha `received` reemite; com `processed` responde 200 sem reemitir; linha gravada sem cabeçalhos e com corpo `{id,type}`.
- Handler de sinal: `relida_em` há 10 s → `retry` com `retry_at`.
- Recursos opcionais da empresa não listam `cobranca`.

**Cercas novas:** `org-operante-uma-regua` (AST de decisões), `org-suspensa-so-nas-rotas-permitidas`, `admin-escrita-exige-scope-full` (pelo mecanismo, `app/**`), `cron-respeita-org-operante`.

**Existentes que passam a cobrar:** `cron-routes-scheduled`, `cron-audita-so-quando-ha-efeito`, `suspensao-nao-dispara-campanha`, `evento-de-fato-nao-fica-pendente`, `painel-nao-promete-o-que-nao-cumpre`, `chave-da-instalacao-mora-numa-tela-so`, `navegacao-completude`, `admin-navegacao-completude`, `env-example-sync`, `kind-check-migration-x-baseline`, `orcamento-uma-regua-de-gasto`, **`i18n-espanhol-cobre-a-tela`, `i18n-catalogo-do-menu`**, `skills-embutidas` (PR 5).

### Invariantes (`pnpm test:db`, Postgres real, baseline install + update)
1. **Isolamento com 2 tenants** (`cobranca-isolamento.test.ts`; `cobranca_assinaturas` em `TABLES` de `rls-isolation.test.ts`): admin de A lê só A; `agent` de A não lê; `authenticated` não escreve (PATCH pelo PostgREST com JWT real); `anon` nada; `cobranca_planos` invisível; **viewer de A lê 0 linhas de `webhook_events_log` com provider in (`stripe`,`asaas`)**.
2. **Estado da org só pelo servidor:** com JWT de platform admin `support_readonly` **e** de `full`, `PATCH organizations set status`, troca de `suspended_kind` e `INSERT organizations` pelo PostgREST → 42501; `fn_suspender_organizacao` (service_role) funciona; `updateTenant` pela sessão (nome, fuso) segue funcionando.
3. **Org suspensa:** `emit_event` com service_role e com o admin da org continua funcionando; LGPD approve emite; B ativa segue normal.
4. **`fn_suspender`/`fn_reativar`:** jobs `pending` → `failed`; `queued` → `failed`; administrativa prevalece; idempotência; item `org_reativada` com a contagem; `event_log` na mesma transação; `redacted` com `suspended_kind` residual não quebra.
5. **Assentos:** teto 2 → 3º INSERT `PT402`; **duas conexões concorrentes** → exatamente uma passa; provisório inserido por `fn_create_tenant_with_owner` não conta; **INSERT provisório via PostgREST (JWT de admin do tenant) → 42501; `UPDATE provisional_until_handover=false` acima do teto → `PT402`; `UPDATE organization_id` conta**; chave desligada ou sem linha = sem limite; seeds de e2e passam.
6. **Canais:** idem, com desarquivar, `UPDATE organization_id`, `wacalls` fora, lock compartilhado com `fn_reserve_channel_connection`.
7. **Trial na criação:** chave ligada + padrão → `trial`; `created_by` platform admin → nada; chave desligada → nada; `fn_create_tenant_with_owner` com `plano_id` → linha; sem `plano_id` e chave desligada → `settings.plan` gravado como hoje.
8. **Deduplicação:** mesmo `(provider, external_id)` → `23505`.
9. **Fila e agendador:** `CLAIM_SQL` não enxerga job de org suspensa; `fireOneDue` avança sem enfileirar.
10. **Reconciliação:** linha `cancelada` de org `suspended{cobranca}` e linha `cancelada` com checkout de 10 dias atrás entram na seleção; `cancelada` antiga de org ativa não.
11. **Varreduras existentes:** `hardening-definer-varredura`, `vocabulario-banco-x-typescript`, `travas-de-suporte-cobrem-toda-tabela-na-instalacao`.

### E2E pela tela
Ambiente: `baseline.sql` + `bootstrap-owner`, `next build`/`next start`, envs opcionais ausentes.

**No CI (`SPECS_PARTE_*`):**
- **`cobranca-suspensao-e-limites.spec.ts`** (sem provedor): dono liga, cria plano (1 pessoa, 1 número), atribui a B; convite em B recusado com a mensagem do plano; dono suspende B; admin de B cai em `/account-suspended` com LGPD e o texto da suspensão administrativa (`emailDeSuporte()`, §9); `/app/inbox` redireciona; token API de B → 403; mensagem por `webhooks/in/[token]` real **é gravada** e nenhuma `llm_calls` nem outbound nasce; `support_readonly` clica em Suspender e vê o erro; dono reativa e B volta com zero saídas e o item de revisão.
- **`cobranca-revendedor.spec.ts` [P0]** com **receiver real**: stub HTTP local (`tests/e2e/fixtures/provedor-de-cobranca.ts`) fala o subconjunto Stripe/Asaas e **envia avisos assinados de verdade** à rota real (`COBRANCA_API_BASE_URL_TESTE` em loopback; a exceção de URL de §7a). Roteiro: conectar; checklist; cadastro → faixa de trial → Assinar com plano de `trial_dias=0` → "Em dia" (com teste grátis, o painel mostra "Teste grátis até DD/MM · 1ª cobrança agendada" até a virada paga); stub marca `past_due` → cron drenado pelo endpoint → avisos → aviso final → `agora` injetado **só na função pura** → suspensão; no hub, "Pagar agora" com o stub ainda pendente **não** reativa; "Já paguei" com o stub pago → reativada; trocar de plano mostra "vale a partir de DD/MM".
- **`cobranca-desligada.spec.ts`:** o self-hoster de empresa única vê o formulário de novo tenant, o badge e a tela Billing **como antes**, nenhuma faixa, nenhum item de admin, e "Recursos opcionais" sem cobrança.

**Fora do CI** (`FORA_DO_CI`, "precisa de chave de teste do provedor e URL pública"): `cobranca-stripe-teste.spec.ts` (`sk_test_` + `stripe listen`, `4242…` e `4000 0000 0000 0341`); `cobranca-asaas-sandbox.spec.ts`.

Evidência em `evidence/`; jornadas em `docs/testing/user-journey-map.md` (P0: primeira cobrança).

---

## 13. Sistema Vivo

| Invariante | Artefato concreto |
|---|---|
| **Entrada** | `POST /api/v1/webhooks/cobranca/{stripe,asaas}`; cron `api/v1/cron/cobranca`; `POST /api/v1/cobranca/assinatura/{checkout,sincronizar,plano,cancelar,gerenciar}` (`gerenciar` → `ok({url})` de `urlDeGerenciar`, `null` → 409 `sem_portal`); `POST /api/v1/admin/cobranca/conexao` e ações de `/admin/cobranca` e `/admin/tenants/[id]`; gatilho `fn_trial_na_criacao_da_org` |
| **Saída** | `organizations.status/suspended_kind`; `cobranca_assinaturas.estado/plano_id/ultimo_erro/assinaturas_vivas`; `agent_inbox_items` `org_reativada`, `cobranca`, `budget_exceeded ref_kind='plano'`; e-mails por `lib/email/roteador.ts` (cliente e dono na troca de chave); `PT402` → 409 `plan_limit_reached`; 403 `org_suspended` |
| **Log/atividade** | `webhook_events_log` (ponteiro); `event_log cobranca.sinal`, `tenant.suspended`, `tenant.reactivated`; ações no fim de `lib/audit/actions.ts`: `cobranca.provedor_conectado`, `plano_salvo`, `plano_arquivado`, `checkout_iniciado`, `estado_mudou`, `plano_trocado`, `assinatura_cancelada`, `prazo_concedido`, `isencao_definida`, `modo_publicado`, `org_suspensa`, `org_reativada`, `rodada`, `modulo_desligado`; `logger` `cobranca.*` |
| **Tela** | `/admin/cobranca` (saúde, problemas do dono, clientes); card no tenant; `/app/settings/billing`; faixa em `/app`; `/account-suspended` |
| **Porta** | `AdminSidebar` com `modulo:'cobranca'`; `catalogo.ts:971`; interruptor em `/admin/sistema`; redirect do suspenso; links do e-mail e da Central |
| **Onde se configura** | Ligar em `/admin/sistema`; chaves, régua e planos em `/admin/cobranca`; checklist diz o que falta; o cliente lê "o administrador ainda não conectou a cobrança" |
| **Anti-morte** | (1) reconciliação por idade de leitura, incluindo `cancelada` suspensa e checkout recente; (2) "última leitura bem-sucedida" vermelha > 7h (saúde do cron) e por cliente > 26h; (3) "último aviso do provedor há X"; (4) `ultimo_erro` e `assinaturas_vivas` na Visão geral; (5) `cobranca.sinal` morto → `event_dead`; (6) webhook de cliente desconhecido `status='error'`; (7) cercas `cron-respeita-org-operante` e `cron-routes-scheduled` |
| **Laço de retorno** | **Suspendeu quem pagou:** sinal, reconciliação (que agora alcança a `cancelada` suspensa) ou "Já paguei" leem `ativa` e reativam; `estado_mudou` guarda o `statusBruto`. **Leitura falhou:** estado intacto, `ultimo_erro` na tela, retry. **Régua dura demais:** dar prazo (reativa na hora) ou ajustar tolerância; piso de 5 dias e aviso de 48h da dívida corrente. **Limite errado:** edita o plano. **Pagamento tentou desfazer administrativa:** recusado pelo kind; e o gatilho de §2.1 impede trocar o kind pela porta dos fundos. **Pagou assinatura cancelada:** aparece ao dono. **Chave desligada:** libera todos |
| **Continuidade IA↔humano** | Reativação não reprocessa acúmulo; item `org_reativada` leva o humano às conversas. Teto do plano manda para humano pelo caminho existente |
| **Mapa vivo** | `docs/architecture/cobranca-do-revendedor.architecture.json`, nós que espelham os mapas `recursos-opcionais`, `teto-de-orcamento`, `organizacoes-e-acesso` e `central-avisos`, e um nó para a tabela `event_log` (não há mapa dela em `docs/architecture/`), cada um com ≥ 2 arestas reais dentro do mapa novo |

---

## 14. Ordem de entrega em PRs

### PR 0: ADR-0004 (`docs/adr/0004-cobranca-do-revendedor.md`), só docs
- Registra o terceiro eixo: nem o mantenedor faturando, nem a "instância hospedada" do ADR do PR #307 (fechado sem merge; colide em número com o ADR-0002 da main).
- **Seção "Relação com a ADR-0002":** classifica a cobrança como **capacidade do núcleo com chave da instalação** (precedente do caixa, `0002…:179`), não módulo de tabela: os gatilhos de limite e trial moram em tabelas do núcleo e consultam as tabelas da cobrança; a D4 reprova provisionadora que toque tabela de fora do módulo; a alternativa (tabelas pela provisionadora + gatilhos no baseline tolerando ausência por `to_regclass`, D7) poria SQL dinâmico em gatilhos quentes de `user_organizations` e `channel_sessions`. Registra o peso medido das duas tabelas vazias (medido na própria PR 0 por quem a escreve: aplicar o DDL de §2.2 e §2.3, com os índices, num Postgres 17 descartável — o ambiente da ADR-0002 — e somar `pg_total_relation_size` das duas tabelas; a ADR-0002 mediu ~368 KB para cinco) e que isso é **revisão da condição 2 para este caso, aprovada pelo dono** (decisão D-1). O texto usa "capacidade do núcleo com chave", nunca "módulo".
- Reconcilia `docs/doctrine/operacao-de-agentes.md` §4 (`:115-120`): proibições 2 e 3 valem para mantenedor e operador de agentes; assento e plano do revendedor são configuração dele, com limites nulos por padrão.
- **`operacao-de-agentes.md:96,103-107`** (e a mesma afirmação em prosa em `:32-33`, "hoje não existe nenhuma tabela de plano, fatura ou assinatura no schema"): a brecha "Faturamento e planos" passa a dizer que falta o faturamento do **operador de agentes** (eixo 2), distinto da cobrança do revendedor (eixo 3); o grep que "hoje devolve 0" é trocado por uma pergunta que o eixo 2 responde (as tabelas `cobranca_*` não podem ficar invisíveis a ele por acidente de nome).
- `docs/specs/19-spec-console-de-agencia.md:91`: console de agência segue sem faturamento.
- `VISION.md:61-62`: "nós não vendemos assinatura; quem instala pode cobrar os próprios clientes".
- `docs/growth/lp-plano.md:361` ("sem cobrança por usuário") é promessa do mantenedor.
- Revisa, regra a regra (medir antes), a seção 7 "Billing & Uso" de `docs/business-rules/00-business-rules-catalog.md:466-502`. B-03 (retenção de mídia, "cumprida desde a migration 0432") e B-05 (sync inicial da Nuvemshop) não tratam de cobrança e **não** são marcadas obsoletas. B-01 (`usage_events`, tabela que não existe no baseline), B-02 e B-04 são conferidas contra o código. B-04 é a regra de `rate_limit_rps` (`docs/specs/01-spec-platform-base.md:101`), coluna que a PR 2 apaga.
- Corrige `docs/doctrine/extensoes.md:159` ("ainda não construída") se a máquina da ADR-0002 já existe (`fn_modulo_instalar`, `baseline.sql:33108-33168`, presente na main em `76355d4b9`) — a PR 0 reconfere no SHA do dia com `grep -n 'fn_modulo_instalar' supabase/baseline.sql` antes de trocar o texto.

### PR 1: suspensão que suspende de verdade (sem chave, toda instalação)
§4 inteiro; migration 1 (inclui o gatilho de estado da org e o kind `org_reativada`); `operante.ts`; veto no gate; `naOrgParada` nos 23 handlers; `requireRole` com scope e `"leitura"`; `requirePlatformAdminEscrita` + cerca pelo mecanismo; `system/update`; hub `/account-suspended` (LGPD + troca de org); comentário de `rodada.ts`; invariantes 2–4 (arquivo `tests/invariants/org-suspensa.test.ts`) e o e2e `tests/e2e/suspensao-administrativa.spec.ts` em `SPECS_PARTE_*` (sem chave nem plano: dono suspende B; admin de B cai em `/account-suspended` com LGPD; `/app/inbox` redireciona; token API de B → 403; mensagem por `webhooks/in/[token]` é gravada e nenhuma `llm_calls` nem outbound nasce; `support_readonly` clica em Suspender e vê o erro; dono reativa e B volta com zero saídas e o item `org_reativada`). As etapas de plano do `cobranca-suspensao-e-limites.spec.ts` ficam para a PR 2; `pnpm test:db` local; fragmento `corrigido`.

### PR 2: planos e limites
Migration 2; chave (em `MODULOS_AINDA_NAO_LIGAVEIS`) e `MODULOS_SO_DA_INSTALACAO`; **prova com a chave travada na tela** (`updateModuloDaInstalacao.ts:50` recusa ligar): invariantes 5–7 e o `cobranca-suspensao-e-limites.spec.ts` gravam `platform_config.MODULO_COBRANCA='ligado'` direto no banco pelo fixture, e o passo "dono liga pela tela" do spec só entra na PR 3a, quando a chave sai da lista; `/admin/cobranca` com Planos e Clientes (atribuir, trocar em trial, prazo, isentar); gatilhos de assentos (com a trava de provisório) e canais; teto de IA em consulta separada; formulário de novo tenant com os dois modos; billing só leitura + faixa de trial; colunas mortas; spec 01.

### PR 3a: contrato, Stripe e régua
Migration 3; `lib/cobranca/*` (contrato, Stripe, estado, régua, sincronizar em fases); webhook, handler com coalescer, cron com a reconciliação ampliada, avisos; checkout em fases, portal, pagamento no hub; troca de plano agendada; Conexão (única escritora das chaves, e-mail aos admins), checklist, publicação; problemas do dono na Visão geral; scrub do Sentry; stub e e2e; a chave sai de `MODULOS_AINDA_NAO_LIGAVEIS`.

### PR 3b: Asaas
Adaptador com `includeDeleted`, `existe` por pagamento confirmado, datas no fim do dia SP, guarda do `trocarPlano`; CPF/CNPJ; token; webhook por API confirmado no sandbox (ou manual); e2e fora do CI.

### PR 4: guia Coolify (`docs/saas/coolify.md`)
Caminho suportado: `install.sh` por SSH na VPS do Coolify (detecta `coolify-proxy`, grava `REVERSE_PROXY=traefik`, descobre a rede `coolify` e os entrypoints `http`/`https`: `install.sh:587-592, 651-744, 982-1041, 1418-1450`). Banco **Supabase Cloud** (o single-server força Caddy em 80/443, `install-single-server.sh:158-170`). Não usar o compose pelo painel (profiles não confiáveis, um arquivo só, sem `update.sh` nem migrator). Conferir 307 e que `/api/v1/webhooks/cobranca/*` passa sem herdar `deskcomm-waha-block`. Atualizar pelo `update.sh`. Dimensionamento: medido na PR 4 por quem escreve o guia, numa VPS Coolify real instalada pelo `install.sh`, com `docker stats --no-stream` (RAM e CPU de `app`, `worker`, `scheduler` e WAHA) em repouso e com uma conversa de teste; o guia publica o número com a data e o SHA.

### PR 5: kit SaaS
`docs/saas/` (jornada do revendedor; Stripe × Asaas — "Stripe BR = cartão + boleto, sem Pix recorrente; Pix recorrente = Asaas"; chaves passo a passo; testar e publicar; régua; troca de plano na virada; nota fiscal fora; termos com o cliente final; `docs/saas/aulas/`). Skill `.agents/skills/deskcomm-saas/` (`SKILL.md` ≤ 500 linhas, description ≤ ~800 caracteres, `agents/openai.yaml`, citação nas 4 portas, `pnpm skills:sync`, "rode X para ver" em vez de números).

---

## 15. Riscos residuais

1. **Escrita de dados de negócio via PostgREST, Realtime e Storage por membro de org suspensa** segue pela RLS (decisão D-12). Nada que custe ou saia passa por aí; o estado da org e os limites estão travados no banco. Endurecimento futuro: varredura de policies restritivas `org_operante_write_*`, sem tocar `fn_support_write_allowed`.
2. **`support_readonly` ainda escreve pelo PostgREST onde a policy aceita `fn_is_platform_admin()`** fora das colunas travadas (ex.: `user_orgs_insert`, `baseline.sql:4308`; campos de exibição de `organizations`). A cobrança está fechada (gatilho de §2.1 e de assentos); o endurecimento geral (`fn_is_platform_admin_full` nas policies) é outro PR.
3. **Rotas de API com empresa suspensa respondem 403 JSON `org_suspended`** — as 20 que chamavam `resolveActiveOrg` (que redireciona) passaram a `orgAtivaDaApi` no PR 1, e a cerca `tests/unit/api-nao-redireciona-org-suspensa.test.ts` reprova quem voltar ao redirect. Para contar: `grep -rln "orgAtivaDaApi(" app/api | wc -l`.
4. **Jobs `running` no instante da suspensão** terminam o turno; gate e assert barram a saída; uma chamada de LLM em voo pode ser cobrada.
5. **Webhook do Asaas fraco** (token estático): corpo é só ponteiro, nunca guardado; decisão sempre por releitura.
6. **Provedor fora do ar:** estado congela, nenhuma suspensão sem releitura fresca.
7. **Estorno/chargeback:** Asaas reabre por `lerSituacao`; Stripe só se a assinatura voltar a `past_due` (sem `charge.dispute` nesta entrega).
8. **Abuso de trial:** mitigação `signup_mode = com_aprovacao` (`lib/auth/politica-de-cadastro.ts:66`). Trocar para o plano maior durante o trial dá o teto de IA dele no trial (decisão D-13).
9. **Teto de IA soma BYOK** (org mista bate antes).
10. **Bloqueio pelo teto de IA** deixa `force_human` sem retomada automática (`orcamento.ts:102-117`).
11. **Deriva de API:** Stripe (`Stripe-Version`, `current_period_end` no item, portal na conta); Asaas (base do sandbox, `User-Agent`, webhook por API, `includeDeleted`). Conferido no dia de cada PR.
12. **Cron novo só chega na release;** num Coolify operado pelo painel, nunca (por isso a PR 4).
13. **Duas assinaturas vivas** criadas fora do fluxo: mostradas ao dono, não canceladas sozinhas.
14. **Desligar a chave não cancela nada no provedor.**
15. **~20 chamadores de `sendMessageHandler`** não lidos um a um quanto ao settle; o gate barra a IA antes; teste por chamador com settle próprio fecha os conhecidos.
16. **Saúde do cron em instalação só com trial** (sem provedor): "última leitura" não se aplica; a suspensão por trial vencido depende do scheduler, cuja presença é garantida por `cron-routes-scheduled`, não observada na tela.
17. **Stripe `vencida_desde` = instante em que vimos o atraso** (até 6h depois do real, a favor do cliente).

---

## 16. Alternativas consideradas e recusadas

O desenho passou por três críticos adversariais (segurança e isolamento; doutrina, empacotamento e atualização; dinheiro e estado). Todo achado bloqueador e alto foi aplicado. Abaixo, o que foi recusado **no todo ou em parte**, com a evidência. A numeração (1.x, 2.x, 3.x) é a do crítico que levantou o achado.

**1.1 (crítico 1, alto — support_readonly pelo PostgREST): recusada a parte (2), `fn_is_platform_admin_full()` nas policies `orgs_write_platform_admin` e `user_orgs_insert/update`.** Aplicada a parte (1), o gatilho de §2.1, que fecha os três ataques citados (a, b, c) **para qualquer scope**. Com o gatilho, o `full` também não escreve essas colunas pelo PostgREST (todo caminho legítimo já é service_role ou definer: `lib/auth/provision.ts:107-109,287-289`; `app/actions/settings/updateTenant.ts:68-80` não toca as colunas). Trocar as policies muda o poder do `support_readonly` sobre dados que não são de cobrança (nome, fuso, membros) — é endurecimento geral e fica como risco 2, fora do escopo desta capacidade. Os assentos inseridos por essa via contam no gatilho de §5.

**1.2 (crítico 1, alto — bypass do `requireRole`): recusado só o detalhe "liberar bypass para métodos que não são GET".** `requireRole` não recebe o método (`lib/auth/require-role.ts:52-53`). No lugar: `allowPlatformAdmin: true` passa a exigir `full` + MFA, e `"leitura"` libera qualquer scope, com a cerca garantindo que `"leitura"` só existe em handler `GET`. Mesmo efeito, sem ler o método em runtime.

**1.4 (crítico 1, médio — linha do webhook): recusado `raw_body NULL`.** `raw_body` é `NOT NULL` (`supabase/baseline.sql:1898`); anulá-lo exigiria alterar a coluna para todos os provedores. Aplicado equivalente: corpo `{id,type}` sempre (nenhuma PII, nem de cliente desconhecido), org nula, cabeçalhos nulos, `asaas-access-token` em `PROIBIDOS`.

**1.5 (crítico 1, médio — `cobranca.sinal` forjável): recusada a reserva de `cobranca.sinal` em `emit_event`.** Aplicados o coalescer (`retry` com `retry_at` quando `relida_em` < 30 s, `lib/event-log/dispatcher.ts:45-48`) e o HTTP fora da transação. Com isso, um sinal forjado custa no máximo uma leitura por 30 s por org — o mesmo que o botão "Já paguei" já permite ao mesmo usuário —, e não segura lock nem conexão. Redefinir `emit_event` exige copiar o corpo vigente derivado, e o próprio baseline registra que copiar a definição errada já reintroduziu comportamento revogado (`supabase/baseline.sql:28395-28400`, migration 0224). Risco alto por ganho nulo depois do coalescer.

**2.J (crítico 2, baixo — pulso em `platform_config`): recusado guardar o pulso em qualquer lugar.** Ele é derivado: "última leitura bem-sucedida" = `max(relida_em)`, vermelha > 7h, já que a reconciliação relê a cada 6h toda linha que ela seleciona (§8). `STRIPE_PORTAL_CONFIG_ID` foi aceito como `diagnostico`. Limite registrado no risco 16.

**2.K (crítico 2, baixo — poda de D+90): recusado gravar `primeiro/ultimo_aviso_recebido_em`.** Aplicada a correção da frase de §2.4. O checklist passa a aceitar também "existe assinatura `ativa` com provedor" como prova de que o caminho funcionou, e isso sobrevive à poda sem armazenamento novo. "Último aviso há X" diz "nenhum nos últimos 90 dias" além do horizonte, o que é verdade.

**2.A (crítico 2, alto — ADR-0002): recusada a opção (b)** (provisionadora + gatilhos que toleram tabela ausente via `to_regclass`). Motivo: SQL dinâmico dentro dos gatilhos quentes de `user_organizations` e `channel_sessions`, contra duas tabelas pequenas. Aplicada a opção (a), com a revisão da condição 2 levada ao dono (decisão D-1).

**2.C (crítico 2, alto — `settings.plan`): recusada a alternativa "apagar e declarar `exige_acao`".** Aplicada a outra saída, não destrutiva: nada muda com a chave desligada. Apagar passa a ser a decisão D-2.

**3.3 (crítico 3, alto — Stripe `unpaid`/`paused`): recusada a consulta adicional de faturas `uncollectible`.** Aplicado o mapeamento pelo status da assinatura (`past_due`, `unpaid`, `paused` → atraso), que cobre os três destinos que o painel oferece depois das tentativas. Contar `uncollectible` como vencida marcaria para sempre, como devedora, uma org cuja dívida o revendedor perdoou no painel (a fatura continua `uncollectible` com a assinatura já `active`).

**3.4 (crítico 3, alto — `vencidaDesde` na Stripe): recusada a conta `finalized_at + boleto.expires_after_days`.** Aplicado: só há atraso com status `past_due`/`unpaid`/`paused`, e `vencida_desde` é o instante em que vimos isso pela primeira vez (monotônico). A conta proposta depende do método de pagamento de cada fatura e da configuração de boleto da assinatura. Isso é mais código e mais deriva de API para ganhar no máximo 6 horas, e esse erro favorece o cliente.

**3.8 (crítico 3, alto — fraude de upgrade/downgrade): recusado o upgrade imediato cobrando a diferença** (`proration_behavior=always_invoice` ou cobrança avulsa no Asaas). Aplicado o caminho menor que o próprio achado recomenda: toda troca só vale na virada paga do ciclo. O upgrade imediato fica como decisão D-3.

**3.10 (crítico 3, médio — Asaas `updatePendingPayments:true`): recusado trocar para `false`.** O Asaas gera a cobrança do próximo ciclo com até ~40 dias de antecedência (premissa de pesquisa não versionada: a PR 3b a confirma no sandbox antes do merge — cria assinatura mensal, lista `GET /payments?subscription=` e lê `nextDueDate` antes e depois da geração da cobrança seguinte — e registra no PR se `nextDueDate` é o vencimento da cobrança pendente ou o do ciclo seguinte; a guarda de §6.2 e `proximoVencimento` dependem dessa resposta). Com `false`, essa cobrança já gerada ficaria com o preço antigo, e o plano novo seria cobrado um ciclo depois de valer. Aplicado no lugar: `trocarPlano` recusa enquanto a cobrança do período corrente estiver pendente. Depois dessa guarda, a única cobrança pendente é a do próximo período, e é ela que deve levar o valor novo. O defeito apontado (mudar o boleto que o cliente já tem ou já pagou do ciclo corrente) fica fechado.

**3.14 (crítico 3, baixo — insert do log + emit): recusada a RPC `security definer` única.** Aplicada a alternativa barata que o próprio achado cita: o `23505` sobre uma linha ainda `received` reemite o sinal, e a linha passa a `processed` depois do emit. Não nasce função definer nova (nem revoke, nem entrada na varredura) para um caso que a releitura já torna inofensivo.

**Médio aceito além do pedido:** o e-mail a todo platform admin `full` na troca de chave (crítico 1, achado 6) foi incluído porque custa uma chamada a `sendEmail`.
