---
title: Spec Técnica 19 — Console de Agência (operação de N clientes)
parent: 00-prd-master.md
depends_on: 01-spec-platform-base.md, 11-spec-mcp-server-internal.md, 12-spec-ai-agents-ui.md, 13-spec-governanca-atendimento.md
version: 0.2
status: rascunho
date: 2026-09-13
owner: Josue Tostado
related_rules: (nenhuma regra de negócio formal ainda — as decisões de produto estão na §1.2 desta spec e na doutrina docs/doctrine/operacao-de-agentes.md)
---

# Spec Técnica 19 — Console de Agência (operação de N clientes)

> Capacidade nova, fora do escopo original do MVP (`00-prd-master.md` §4). Não existe sub-PRD
> dedicado. A lei que esta spec serve é [`operacao-de-agentes.md`](../doctrine/operacao-de-agentes.md).
>
> **v0.2 — revisão depois de medir o código.** A v0.1 propunha uma API de carteira e reaproveitar
> a duplicação de agente como pacote. As duas coisas estavam erradas: os endpoints de carteira já
> existem, e a duplicação é escopada por organização. As correções estão nas §3, §4 e §1.2.

---

## 1. Visão Geral

### 1.1 O que é

Uma superfície para **um operador servir N organizações clientes** a partir de uma instalação: ver
a carteira, saber se o agente de cada cliente está de pé, entrar no cliente com auditoria, aplicar
um modelo de agente e registrar o aceite antes de entregar.

**O que esta spec NÃO é.** Não é o CRM do cliente (isso já existe), não é faturamento e não é um
runtime de agentes novo. É a **camada de operação** que hoje só existe como procedimento manual
descrito nas skills `deskcomm-cliente-novo` e `deskcomm-metricas`.

### 1.2 Decisões de produto fechadas

1. **Unidade de cobrança: retainer por cliente operado** (dono do produto, 2026-09-13). O trabalho
   imediato é **este console**, não um medidor de consumo — cobro por consumo exigiria construir
   medidor → fatura antes do primeiro real, e não existe nenhuma tabela de plano, fatura ou
   assinatura no schema.
2. **O software permanece MIT e completo.** O que se cobra é a operação (invariantes 1 e 2 da
   doutrina). Nada aqui fica atrás de pagamento para quem opera sozinho.
3. **A marca do cliente é do cliente.** `platform_branding` é da instalação,
   `organizations.settings.branding` é do cliente.
4. **Entrar no cliente é ato auditado.** Não se cria "modo deus": reusa-se a sessão de suporte de
   `docs/support-sessions.md`, com ator real e prazo.
5. **Pacote de agente é agente-modelo — mas a duplicação de hoje NÃO serve como está.**
   `duplicateAgentWithVersion` resolve a versão de origem **dentro da mesma organização**
   (`pickSourceVersion(admin, orgId, agentId)`). Copiar de uma organização-modelo para a organização
   do cliente é uma mudança real numa função compartilhada, não reuso puro. Ver §3.
6. **Quem hospeda — EM ABERTO, e a §1.2 anterior contradizia a doutrina do repo.** A v0.1 fechou "a
   agência hospeda N organizações numa instalação". A referência de agência do **próprio repo** diz
   o contrário: _"Se a agência opera vários clientes, o modelo suportado é **uma instalação por
   cliente** (VPS + Supabase + domínio próprios). Várias organizações numa instalação só existe
   para quem administra a plataforma inteira."_ — e dá o motivo: _"misturar clientes numa VPS
   mistura número, marca e risco"_. Enquanto isso não for decidido, a §4 descreve a hipótese de uma
   instalação. Divergir da doutrina é decisão do dono do produto, com o custo escrito. Ver §7.
   Custo a considerar junto: o plano grátis do Supabase permite **2 projetos por usuário**, então o
   modelo de uma instalação por cliente encarece a partir do terceiro cliente.
7. **O aceite diz o que NÃO avaliou.** A avaliação existente avalia **texto**, e devolve a lista
   explícita dos gates que dependem do turno real (§3). Veredito que parece completo e não é seria
   pior que veredito nenhum — é a regra escrita no próprio módulo.

### 1.3 Posição na arquitetura

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Console de agência — tela nova sobre API que já existe                  │
│  carteira · saúde · entrada auditada · aplicar pacote · aceite           │
└───────────┬──────────────────────────────────────────────────────────────┘
            │  REUSO (já no repo)                    NOVO (esta spec)
            │  GET /api/v1/admin/usage               GET  .../tenants/[id]/agents
            │  GET /api/v1/admin/tenants/[id]/health POST .../tenants/[id]/package
            │  POST .../tenants/[id]/impersonate     POST .../tenants/[id]/acceptance
            │  GET /api/v1/admin/dashboard/kpis
            ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  lib/ai/agents/duplicate.ts  → generalizar para origem em OUTRA org       │
│  lib/ai/agents/avaliar-resposta-de-teste.ts → avalia texto, e diz o resto │
│  lib/ai/budget/check.ts · llm_calls.cost_cents · ai_budgets → custo/teto  │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Escopo

**Dentro:** carteira por cliente (custo do período, saúde, agente publicado e sua versão); entrada
auditada; aplicação de pacote de agente; registro de aceite por cliente.

**Fora (de propósito):** faturamento/planos/cotas (§1.2 decisão 1); console de revenda; SOC 2, ISO
27001, multi-região e idioma adicional (fora de escopo por decisão escrita no
`docs/prd/00-prd-master.md` §7.4); substituir `lib/agent-engine/` (proibido pela §4 da doutrina).

---

## 3. O que já existe, o que falta — medido

| Necessidade                                                                       | Estado        | Evidência                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lista de clientes com mensagens, invocações de IA, tokens e **custo por cliente** | **JÁ EXISTE** | `app/api/v1/admin/usage/route.ts` — `UsageTenantRow` já traz `organization_id`, `tenant_name`, `messages_count`, `ai_invocations_count`, `ai_tokens_total`, `ai_cost_cents`; aceita `range` (7d/30d/90d) e filtro por `tenant_id` |
| Saúde por cliente, **incluindo gasto de IA contra o teto**                        | **JÁ EXISTE** | `app/api/v1/admin/tenants/[id]/health/route.ts` — computa WAHA, Nuvemshop, `aiOverallStatus(percentUsed, modo)` e atraso de auditoria                                                                                             |
| Entrar no cliente com auditoria                                                   | **JÁ EXISTE** | `app/api/v1/admin/tenants/[id]/impersonate/route.ts` + `docs/support-sessions.md`                                                                                                                                                 |
| KPIs de plataforma                                                                | **JÁ EXISTE** | `app/api/v1/admin/dashboard/kpis/route.ts`                                                                                                                                                                                        |
| Suspender/reativar cliente                                                        | **JÁ EXISTE** | `app/api/v1/admin/tenants/[id]/suspend` e `.../reactivate`                                                                                                                                                                        |
| **Qual agente está publicado em cada cliente, e em que versão**                   | **FALTA**     | Nem `usage` nem `health` trazem agente — `ai_agents.published_version_id` existe, mas não é exposto                                                                                                                               |
| **Aplicar um pacote de agente a um cliente**                                      | **FALTA**     | `lib/ai/agents/duplicate.ts` compila, mas a origem é sempre a mesma organização                                                                                                                                                   |
| **Registro de origem e de aceite**                                                | **FALTA**     | ver abaixo                                                                                                                                                                                                                        |

### Por que `provisioning_origin` NÃO serve como registro de origem

A coluna existe (`ai_agent_versions.provisioning_origin`, criada pela migration `0227`), e é a
primeira suspeita de quem procura "de onde este agente veio". Ela **não** serve, e o motivo é o
domínio, não o nome:

```sql
check (provisioning_origin in ('onboarding','legacy_reconciliation'))
```

Dois valores fechados, ambos sobre **como a instalação provisionou a organização** — não sobre qual
modelo gerou o agente. Acrescentar um valor mudaria o significado de um campo existente que já
participa de uma comparação de consistência (`p_expected_provenance`). Registro de origem e aceite
continuam sendo a única peça que provavelmente exige migration — e, se exigir, ela sai na tripla
do repo (migrations + `supabase/baseline.sql` + `MANIFEST.md`, com `lib/database.types.ts`
regerado e invariante de isolamento em `pnpm test:db`).

### Restrições reais que um pacote precisa respeitar

Medidas nas duas tabelas do baseline, não estimadas — um pacote que viole qualquer uma delas
falha no INSERT:

| Campo                | Restrição                                                                 |
| -------------------- | ------------------------------------------------------------------------- |
| `channel_session_id` | **NOT NULL** — a versão copiada precisa da sessão de canal **do cliente** |
| `provider`           | `anthropic` \| `openai` \| `google`                                       |
| `kind` (`ai_agents`) | `rag_bot` \| `mcp_agent`                                                  |
| `cost_budget_cents`  | entre 1 e 10000                                                           |
| `token_budget`       | entre 1000 e 500000                                                       |
| `max_steps`          | entre 1 e 25                                                              |
| `status` da versão   | nasce `draft` — duplicar nunca publica                                    |

---

## 4. Superfície de API

**Reuso — nada de novo:** a carteira da tela é montada com `GET /api/v1/admin/usage` +
`GET /api/v1/admin/tenants/[id]/health`; a entrada auditada é
`POST /api/v1/admin/tenants/[id]/impersonate`. Inventar um `/portfolio` aqui seria duplicar o que
já existe e já tem teste.

**Novo — três rotas, e só:**

| Rota proposta                           | Método | O que faz                                                             |
| --------------------------------------- | ------ | --------------------------------------------------------------------- |
| `/api/v1/admin/tenants/[id]/agents`     | GET    | Agente publicado do cliente, sua versão, escopo e origem registrada   |
| `/api/v1/admin/tenants/[id]/package`    | POST   | Aplica um agente-modelo ao cliente e registra a origem                |
| `/api/v1/admin/tenants/[id]/acceptance` | POST   | Registra o veredito de aceite (data, autor, e o que não foi avaliado) |

Toda rota segue o padrão do repo: Zod valida o input, `requirePlatformAdmin` como guard,
`organization_id` de fonte confiável, `audit()` em toda mutação, resposta por `ok()`/`fail()`.

**Nenhuma rota usa service role sem filtro explícito de organização.** O console agrega N clientes,
e é exatamente aí que o vazamento cross-tenant nasce.

---

## 5. Critérios de aceite

Todos observáveis por terceiro. "Está implementado" não é aceite.

1. **Carteira real.** Um operador abre a tela e vê **3 organizações** clientes com custo do período,
   saúde e o agente publicado de cada uma — sem planilha paralela.
   _Prova:_ Playwright contra o app rodando, com 3 organizações semeadas — screenshot com as três.
2. **Saúde verdadeira.** Derrubar o agente de um cliente muda a linha daquele cliente na tela; os
   outros dois não mudam.
   _Prova:_ estado antes/depois na mesma sessão, sem refresh manual.
3. **Entrada auditada.** Abrir um cliente pelo console gera registro de sessão de suporte com o ator
   real (o operador), e o modo somente-leitura prevalece quando escolhido.
   _Prova:_ consulta ao audit log mostrando o ator correto, não o usuário do cliente.
4. **Pacote aplicado.** Aplicar um agente-modelo a um cliente cria o agente daquele cliente, com a
   sessão de canal **do cliente**, nascendo `draft`, e a carteira passa a mostrar a origem.
   _Prova:_ diff do agente criado + registro de origem visível na tela.
5. **Isolamento mantido.** O usuário de um cliente **não** enxerga a carteira nem o agente de outro.
   _Prova:_ invariante em `pnpm test:db`, mais uma tentativa de acesso cruzado que devolve 403/404.
6. **Aceite honesto.** O cliente aparece "entregue" apenas com veredito registrado, com data e
   autor, **e com a lista do que não foi avaliado**.
   _Prova:_ os dois estados na tela, e o registro no banco.
7. **Isso não quebrou nada.** `pnpm typecheck`, `pnpm lint`, `pnpm test:unit` e `pnpm test:db`
   verdes.

---

## 6. Requisitos de harness

- **Porta de navegação:** declarar a tela em `lib/navigation/registry.ts` (ou na allowlist com
  justificativa escrita) — `tests/unit/navegacao-completude.test.ts` reprova tela alcançável só por
  URL digitada.
- **Mapa de arquitetura:** representar a peça nova em `docs/architecture/` com ao menos duas
  arestas, como o Living System Checklist exige.
- **Marca:** nada de nome de produto em código que alcança o usuário —
  `tests/unit/branding.test.ts` varre `app|components|lib|workers|hooks`.
- **Sem `console.log`:** log por `lib/logger.ts`.
- **Migrations:** tripla completa se houver tabela nova (§3).
- **Auditoria:** toda mutação do console emite `audit()`.

---

## 7. Aberto — decisões que esta spec NÃO toma

Não invente nenhuma destas:

1. **Quem hospeda.** Uma instalação por cliente (o modelo que a doutrina do repo declara) ou N
   organizações numa instalação da agência (o que a §4 descreve)? A doutrina responde a primeira e
   dá o motivo — misturar clientes numa VPS mistura número, marca e risco. Divergir disso é decisão
   do dono do produto, e o custo vai escrito junto: Supabase grátis = 2 projetos por usuário.
2. **Preço e SLA.** Nenhum número existe em lugar nenhum do repo; o primeiro cliente real define.
3. **Limite da carteira.** Quantos clientes um operador deve conseguir ver sem paginação — a tela
   deve aguentar o número real, e esse número ainda não existe.

---

## 8. Plano de execução

**Ordem inegociável, e não é técnica:** a §5 da [`operacao-de-agentes.md`](../doctrine/operacao-de-agentes.md)
diz que **nada avança antes de um cliente real**. A fase A pode ser construída antes disso (é
barata e prova valor numa demonstração); as fases B e C não — elas só se sabem certas contra uso real.

### Fase A — visibilidade (nenhum schema novo)

Montar a tela sobre `admin/usage` + `admin/tenants/[id]/health` + `admin/dashboard/kpis`, e
acrescentar a **única leitura que falta**: o agente publicado e sua versão por cliente
(`GET .../tenants/[id]/agents`).

_Pronto quando:_ os critérios 1, 2, 3 e 5 da §5 passarem com 3 organizações semeadas.
_Por que primeiro:_ não cria schema, não toca em função compartilhada, e é o que um operador usaria
no dia 1.

### Fase B — pacote de agente (schema novo + função compartilhada)

Generalizar a resolução de origem do `duplicateAgentWithVersion` para aceitar uma organização de
origem diferente da de destino, amarrar a `channel_session_id` do cliente, e registrar a origem.
Respeitar os tetos da §3 — o pacote não pode carregar orçamento acima do que o CHECK aceita.

_Pronto quando:_ o critério 4 da §5 passar, e `lib/ai/agents/duplicate.ts` continuar atendendo os
dois chamadores de hoje (rota e ação da lista) sem mudança de comportamento — a duplicação
existente é usada todo dia e não pode regredir.

### Fase C — aceite por cliente

Construir o registro de aceite, e ser explícito sobre o alcance: a avaliação existente
(`avaliarRespostaDeTeste`) é **de texto** e devolve a lista dos 10 gates que dependem do turno real.
O registro guarda autor, data e essa lista.

_Pronto quando:_ o critério 6 da §5 passar — e a tela disser, em voz alta, o que **não** foi avaliado.

### O que NÃO está nesta sequência

Cobrança e planos (decisão 1), certificações, multi-região, e qualquer paridade de funcionalidade
com concorrente que não venha de um cliente pagante. Tudo isso é proibição escrita, não esquecimento.
