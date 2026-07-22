---
title: DeskcommCRM — PRD-Mestre
version: 0.2
status: em revisão
date: 2026-07-19
owner: Rafael Melgaço
referencia_arquitetural: docs/research/reference-synthesis.md
---

# DeskcommCRM — PRD-Mestre

> Documento-índice da visão, escopo e estrutura do produto. Cada subsistema é detalhado em sub-PRDs (`01-plataforma-base.md` ... `06-nuvemshop-lgpd.md`). Decisões arquiteturais herdadas estão em `docs/research/reference-synthesis.md`.

---

## 0. Nota de transição (2026-07) — de "CRM de e-commerce" para "AI Sales OS"

Este PRD nasceu (v0.1, abril/2026) com o produto posicionado como **CRM operacional para e-commerce**. Após a abertura do código, a realidade da adoção mudou o produto: a maioria da comunidade roda o Deskcomm em **clínicas, infoprodutos, imobiliárias, agências e serviços**, e os pedidos de feature nos especializaram em **agentes de IA integrados via MCP**. O posicionamento vigente está em [`VISION.md`](../../VISION.md):

> **Sistema operacional de vendas open source com agentes de IA nativos e WhatsApp — self-hosted, multi-tenant, para qualquer negócio que vende conversando.**

Implicações de leitura deste documento e dos sub-PRDs:
- **E-commerce passa de definição do produto a primeiro vertical.** Referências a Nuvemshop, pipeline de pedidos e vocabulário de e-commerce continuam válidas como o template do vertical de origem — o mecanismo que as generaliza é o `vocabulary` configurável por pipeline (Sub-PRD 02 §3.7).
- **O modelo comercial é open source + infraestrutura** (parceria HostGator para self-host em VPS), não venda de assinatura. Menções a "modo SaaS" descrevem uma opção arquitetural preservada, não o plano comercial corrente.
- Requisitos, contratos e decisões técnicas dos sub-PRDs permanecem válidos — a arquitetura multi-tenant com `vocabulary` configurável foi o que permitiu a expansão multi-nicho sem refactor.

---

## 1. Sumário Executivo

**O que é.** DeskcommCRM é um sistema operacional de vendas open source com agentes de IA nativos — um CRM operacional onde a IA atende, qualifica e move o funil junto com humanos. Unifica atendimento humano, agentes com RAG por tenant, gestão de pedidos/negócios e pipeline de pós-venda numa única plataforma multi-tenant, tendo WhatsApp como canal primário (via WAHA, API não-oficial). Nasceu especializado em e-commerce (vertical de origem, com integração Nuvemshop); hoje serve qualquer negócio que vende conversando — ver Nota de transição (§0).

**Quem usa.** Hoje, em modo BPO: a empresa operadora (TBD) usa o DeskcommCRM internamente pra prestar atendimento como serviço aos e-commerces clientes contratados. Atendentes humanos operam múltiplos tenants através de uma "caixa de entrada unificada" via *super-admin role*. Amanhã, em modo SaaS: o mesmo produto será comercializado direto pra e-commerces operarem por conta própria. Toda a arquitetura é multi-tenant desde o dia 1, sem refactor previsto pro pivot.

**Quem é o cliente alvo (tenant).** PME brasileira que vende pelo WhatsApp — e-commerce, clínica, imobiliária, infoprodutor, agência ou serviço — na faixa de ~300 atendimentos/dia, 2–5 atendentes humanos e 1–2 números WhatsApp. O perfil de calibração original (e-commerce Nuvemshop com ~5 mil pedidos/mês) segue sendo a referência de carga.

**Diferencial competitivo.** Quatro elementos juntos — ausentes nos concorrentes incumbentes (Kommo, Octadesk, Zendesk, Pipedrive, RD CRM):
1. **Agentes de IA operando o CRM** com RAG por tenant (FAQ + políticas do negócio + catálogo sincronizado + conversas resolvidas), não chatbot decorativo — com trilha de auto-aprimoramento: conversas resolvidas realimentam a base de conhecimento.
2. **Multi-nicho por design**: pipeline, vocabulário e métricas configuráveis por tenant (`vocabulary` por pipeline) — o ciclo de e-commerce ("Carrinho abandonado → Pago → Enviado → Entregue → Pós-venda") é o template do vertical de origem, não o limite do produto.
3. **MCP-ready**: arquitetura inclui MCP server (interno hoje; contrato público na Fase 2) com 19 tools canônicas pra LLMs operarem o sistema.
4. **LGPD nativa**: redact e data_request como contrato de primeira-classe (incluindo os webhooks da Nuvemshop no vertical e-commerce), não afterthought.

**Restrições principais.** MVP-B em produção em **8–12 semanas**. Stack obrigatória: bundle adotado (Next.js 14+ App Router + Supabase + WAHA Plus + Vercel + MCP server separado em Node ESM). LGPD desde o dia 1. Arquitetura multi-tenant com RLS Postgres em toda tabela tenant-aware.

---

## 2. Problema & Visão

### Problemas que o DeskcommCRM resolve

1. **Atendimento desfragmentado.** PMEs hoje atendem via WhatsApp Web pessoal + planilha + memória do atendente. Sem histórico unificado, sem multi-atendente real, sem auditoria. Quando o atendente sai da empresa, o relacionamento com o cliente vai junto.

2. **Custo proibitivo de atendimento humano puro.** Contratar 5 atendentes 12h/dia é caro. ROI só fecha com IA cobrindo 60–70% dos casos repetitivos (rastreio, troca, FAQ, política de envio), mantendo humano apenas pra casos com fricção emocional ou complexidade.

3. **LGPD em pé de fragilidade.** Lojistas raramente têm processo formal de redact e data_request. Multas vêm crescendo desde 2023 e passam pra eles em primeiro lugar — e pro fornecedor de software, em segundo. Não é compliance opcional.

4. **CRMs B2B genéricos não servem pra quem vende conversando.** Pipedrive, RD CRM e similares foram desenhados pra venda de SaaS — funil "Lead → Proposta → Negociação → Fechado". Venda conversacional (e-commerce, clínica, imobiliária, infoproduto) tem ciclo curto, automatizado, repetitivo, centrado no WhatsApp. O vocabulário e o ritmo são outros — e cada nicho precisa do seu (`vocabulary` configurável).

5. **Sem MCP nativo no mercado.** Lojistas que querem operar o CRM via Claude Desktop ou agentes IA hoje não têm plataforma que exponha CRUD do CRM como tools MCP. Tendência forte pós-2025; janela competitiva aberta.

### Visão

> "DeskcommCRM é o sistema operacional de vendas onde agentes de IA e humanos atendem juntos os clientes de qualquer negócio que vende pelo WhatsApp, com Customer 360° unificado, compliance LGPD nativa, operação multi-tenant pronta pra escala — e agentes que se auto-aprimoram a cada conversa resolvida."

Em três anos: ser a resposta padrão pra "melhor CRM open source com agentes de IA e WhatsApp" — milhares de instâncias self-hosted (VPS HostGator como caminho recomendado), ecossistema de agentes plugados via MCP público, templates prontos por nicho (e-commerce, clínica, imobiliária, infoproduto), e o flywheel de auto-aprimoramento medido em produção. Posicionamento completo em [`VISION.md`](../../VISION.md).

---

## 3. Personas & Stakeholders

### 3.1 Operador BPO (atendente da empresa operadora) — *persona primária no MVP*
**Quem.** Funcionário da empresa operadora, gerencia atendimentos de **múltiplos tenants** simultaneamente pela "caixa de entrada unificada".
**Dores.** Trocar de aba entre tenants é lento. Esquecer contexto do cliente entre conversas. Não saber se já respondeu uma dúvida frequente. Saber a hora certa de escalar.
**Precisa.** Visualização cross-tenant, contexto do cliente em 1 clique, sugestões de resposta da IA, marcação de status (resolvido / pendente / esperando cliente), quotas por tenant.

### 3.2 Super-admin de plataforma — *persona primária no MVP*
**Quem.** Sócio/líder operacional da empresa operadora; acesso irrestrito a todos os tenants.
**Dores.** Gerenciar SLAs por tenant, ver saúde de cada número WAHA, identificar tenant que está perto de banimento, distribuir carga entre atendentes.
**Precisa.** Dashboard cross-tenant, alertas de saúde WAHA, audit trail completo, gestão de roles por tenant.

### 3.3 Tenant — gestor do e-commerce (lojista) — *persona secundária no MVP, primária no SaaS*
**Quem.** Dono ou gerente do e-commerce cliente. Acessa o sistema via super-admin do tenant.
**Dores.** Saber se a empresa BPO está atendendo bem (no MVP) ou operar atendimento próprio (no SaaS). Configurar políticas de IA, FAQ, base RAG. Ver métricas (NPS, tempo de resposta, taxa de resolução por IA).
**Precisa.** Painel do tenant com KPIs operacionais, configuração de chatbot/RAG, gestão de atendentes do tenant, exports LGPD.

### 3.4 Cliente final — comprador do e-commerce
**Quem.** Pessoa física que comprou ou está comprando no e-commerce. Não acessa o sistema diretamente; é atendida via WhatsApp.
**Dores.** Esperar 30+ minutos por resposta. Repetir histórico toda vez que troca de atendente. Não conseguir falar com humano quando o bot trava.
**Precisa.** Resposta em <30s pra dúvidas simples, transição transparente pra humano quando complexo, contexto preservado entre interações.

### 3.5 Atendente do tenant (modo SaaS, fase 2+)
**Quem.** Funcionário do e-commerce cliente que opera o CRM próprio (no modo SaaS).
**Dores.** Similar ao Operador BPO, mas escopo de 1 tenant.
**Precisa.** Mesma UI do Operador BPO, mas sem cross-tenant.

### 3.6 ANPD / auditor LGPD — stakeholder regulatório
**Quem.** Autoridade Nacional de Proteção de Dados ou auditor contratado pelo tenant.
**Precisa.** Audit trail íntegro de toda operação em dados pessoais; capacidade de gerar export estruturado de qualquer titular em até 7 dias úteis; capacidade de redact (anonimização ou delete) em até 15 dias úteis.

---

## 4. Escopo do MVP & Fora-de-escopo

### 4.1 Dentro do MVP (Fase 1, 8–12 semanas)

**Plataforma base**
- Auth multi-tenant via Supabase Auth (JWT com `tenant_id` claim, MFA TOTP forçado pra admin)
- RBAC com 4 roles (viewer / agent / manager / admin) + super-admin de plataforma
- RLS em toda tabela tenant-aware via `fn_user_org_ids()`
- Audit log denso (`api_audit_log`) em toda mutação
- Onboarding de tenant (mesmo que ainda não exposto publicamente)

**Customer 360° (determinístico)**
- Identity resolution determinística por email + telefone E.164 + CPF
- Timeline event-sourced via `crm_lead_activities` polimórfica
- Custom fields declarativos por pipeline (`pipeline.settings.fields`)
- Vocabulary customizável (lead=Cliente, deal=Pedido, won=Pago, lost=Cancelado pra e-commerce)

**Canal WhatsApp via WAHA Plus**
- Conexão de número por QR code via UI
- Recebimento de mensagens com HMAC-SHA512 + idempotência via `unique (org, external_id)`
- Envio com persistência otimista (`status='sending'` antes do despacho)
- Anti-banimento (throttle 1msg/1.2s + jitter, warm-up assistido, spinning de copy, detecção STOP automática)
- Multi-número e multi-atendente por tenant
- Mídia via Supabase Storage (não inline)
- Cron `recover-stuck-messages` + `sync-sessions` + `process-pending-webhooks`

**Pipeline Kanban + Atendimento**
- 5 tabelas core CRM com fractional indexing (`position_in_stage numeric` + `midpoint()`)
- Pipeline default seedado no signup ("Carrinho abandonado → Aguardando pagamento → Pago → Em separação → Enviado → Entregue → Pós-venda")
- Drag-drop com `@hello-pangea/dnd`
- Roteamento simples (round-robin entre atendentes) e atribuição manual
- Tickets como crm_leads + activities; sem entity separada de "ticket" no MVP

**IA Conversacional + Handoff**
- Chatbot por tenant com prompt customizável
- RAG por tenant (vector store: pgvector ou Supabase Vector — a escolher na spec)
- Ingestão: FAQ manual + política da loja + catálogo Nuvemshop sincronizado + conversas resolvidas anteriores
- Sentiment detection em tempo real (cada inbound roda análise binária alta/baixa frustração)
- Handoff automático quando: cliente pede explicitamente humano, sentiment cai abaixo do threshold, IA admite incerteza, conversa entra em estágio crítico do pipeline (ex: pós-venda com defeito)
- Atendente humano vê histórico completo do bot ao assumir

**Integração Nuvemshop**
- OAuth (App embedded ou external, a definir na spec)
- Webhooks `order/created`, `order/paid`, `order/cancelled`, `order/fulfilled`, `cart/abandoned`
- Webhooks LGPD `customer/redact`, `customer/data_request`, `store/redact`
- Sync inicial de produtos/clientes/pedidos
- Tabela `orders` linkada a `crm_leads` via `crm_lead_links` polimórfico

**LGPD framework**
- Endpoint `/api/v1/lgpd/data-request` — gera export estruturado (JSON + PDF) em D+7
- Endpoint `/api/v1/lgpd/redact` — anonimização (preferida) ou delete cascade conforme caso
- Audit log de toda operação em dados sensíveis
- Consentimento granular por tenant (marketing, transacional, perfilamento separados)

### 4.2 Fora do MVP (entra em fases posteriores)
- MCP server público (Fase 2)
- Identity resolution probabilística (Fase 3)
- Multi-canal além de WhatsApp — Instagram DM, email, web chat (Fase 4)
- Multi-plataforma e-commerce — VTEX, Shopify (Fase 5)
- Permissão por pipeline (`user_pipeline_access` table) — adicionar quando cliente real pedir
- Dashboard analytics avançado e relatórios executivos
- Programas de fidelidade, NPS automatizado, recovery de carrinho via campanha

### 4.3 Decisões deliberadas de não-fazer
- **Não adotar microsserviços.** Monolito Next.js + Supabase + serviço externo só pra WAHA é a fronteira aceitável.
- **Não adotar event sourcing puro.** `event_log` table + workers, padrão pub/sub leve. CQRS é overkill nesse estágio.
- **Não construir abstrações multi-platform especulativas além do `EcommercePlatformAdapter`.** YAGNI até segundo provedor entrar.

---

## 5. Arquitetura de Referência Herdada

DeskcommCRM **adota integralmente** a doutrina arquitetural extraída do material da *Aula CRM Nichado com WhatsApp (WAHA)*. Síntese completa em `docs/research/reference-synthesis.md`.

**Pontos não negociáveis herdados:**
- Stack Next.js + Supabase + WAHA Plus + Vercel
- Multi-tenant via RLS com helper `fn_user_org_ids()`
- 5 tabelas core CRM (`crm_pipelines`, `crm_stages`, `crm_leads`, `crm_lead_activities`, `crm_lead_links`)
- Polimorfismo explícito em timeline e vínculos
- Fractional indexing no kanban
- Idempotência via `unique (org, external_id)`
- `event_log` + workers; **trigger NUNCA faz HTTP**
- Realtime via Supabase Realtime (postgres_changes + broadcast)
- API REST canônica `/api/v1/` com cursor pagination, idempotency-key, dual auth
- 4 roles RBAC; sem permissão por pipeline no MVP
- Doutrina DIRC (Duplicar / Integrar / Referenciar / Calcular)
- 19 tools MCP canônicas (pra Fase 2)

Toda decisão de spec/epic que conflitar com o bundle herdado **requer justificativa explícita** no documento que decide a divergência.

---

## 6. Capacidades Diferenciadoras (gaps sobre a referência)

São os 6 deltas que o DeskcommCRM constrói sobre a base herdada — onde reside o valor competitivo e onde a engenharia adiciona algo não-trivial:

### 6.1 Integração Nuvemshop nativa
OAuth + 8+ webhooks (incluindo LGPD redact/data_request) + sync inicial. Adapter pattern (`EcommercePlatformAdapter`) abstrai a interface pra VTEX/Shopify entrarem em fases posteriores sem reescrita.

### 6.2 Sentiment detection + handoff automático
Cada mensagem inbound roda análise leve (Haiku 4.5 ou modelo dedicado) em paralelo via `event_log`. Threshold configurável por tenant. Marcador de timeline (`crm_lead_activities.type='handoff_triggered'` com `metadata.sentiment_score`). Política de retomada documentada (cliente volta a engajar bem? bot reassume? quem decide?).

### 6.3 Chatbot RAG por tenant
Vector store por tenant (pgvector ou Supabase Vector — a definir na spec). Pipeline de ingestão com 4 fontes: FAQ manual, política da loja (PDF/markdown), catálogo Nuvemshop sincronizado, conversas resolvidas anteriores como exemplos. Roteamento de chamada combina contexto (últimas 20 messages + perfil do contato + último pedido) + RAG hits. Modelo default: Sonnet 4.6 via AI Gateway, Haiku 4.5 pra triagem de sentimento.

### 6.4 Super-admin de plataforma
Coluna `is_platform_admin` em tabela `auth.users` ou tabela auxiliar `platform_admins`. Helper RLS retorna TRUE pra essa role em qualquer tabela tenant-aware. UI separada `/admin` (talvez subdomínio `admin.deskcomm.com`). Operação BPO ganha "caixa de entrada unificada" cross-tenant; clientes SaaS futuros não veem essa UI.

### 6.5 AI Provider strategy via Vercel AI Gateway
Default: Vercel AI Gateway com fallback de provedor (Anthropic primário; OpenAI de backup). Observability nativa (tokens, latência, custo por tenant). Zero data retention configurável. Strings `"anthropic/claude-sonnet-4-6"` em vez de import direto de SDK específico, conforme guidance da plataforma.

### 6.6 Adapter pattern de plataforma e-commerce
Interface `EcommercePlatformAdapter` define `fetchOrders`, `fetchCustomers`, `subscribeWebhooks`, `redactCustomer`, `dataRequest`. Nuvemshop é primeira impl no MVP; VTEX e Shopify entram como adapters adicionais sem alterar a camada de domínio (`crm_leads`, `orders`, etc.).

---

## 7. Conformidade & LGPD

### 7.1 Princípios LGPD aplicados
- **Minimização**: armazenar apenas o necessário pra atendimento. Sem coleta de dados secundários sem consentimento explícito.
- **Anonimização preferida sobre delete**: vendas históricas precisam permanecer pro faturamento; nome do cliente vira "Cliente Anonimizado #1234".
- **Audit trail íntegro**: toda operação de dados sensíveis logada com `who/what/when/why`, em tabela imutável (`api_audit_log`).
- **Consentimento granular**: marketing / transacional / perfilamento separados, cada um pode ser revogado independentemente.

### 7.2 Mecanismos no MVP
- Endpoint `/api/v1/lgpd/data-request` — gera export estruturado em JSON + PDF entregue em D+7 ao titular ou ao tenant.
- Endpoint `/api/v1/lgpd/redact` — anonimização cascata (contact + conversations + messages média + activities) com flag `is_anonymized`. Delete físico apenas quando solicitado e sem dependências (raro).
- Webhook receiver pros 3 webhooks LGPD da Nuvemshop:
  - `customer/redact` → fluxo de anonimização sob solicitação
  - `customer/data_request` → fluxo de export
  - `store/redact` → quando lojista cancela conta Nuvemshop, redact em cascade do tenant inteiro
- HMAC validado em todo webhook LGPD (Nuvemshop assina; nós verificamos).
- Audit do receipt de cada webhook (deduplicação via `unique (provider, external_id)`).

### 7.3 Retenção
- Mensagens: retenção configurável por tenant. Default 365 dias; lojistas podem solicitar arquivamento de fria-via mais curto.
- Audit log: 5 anos (boas práticas ANPD).
- Eventos do `event_log`: 90 dias retenção operacional + arquivamento pro cold storage S3 se necessário.

### 7.4 Fora do escopo LGPD do MVP
- Certificação SOC 2 / ISO 27001 (entra na Fase 1.5 ou 2 conforme demanda comercial).
- Pseudonimização avançada de payloads em transit (toda comunicação interna já é em transit-encrypted via Supabase).

---

## 8. Métricas de Sucesso & KPIs

### 8.1 KPIs propostos pro MVP

| KPI | Definição | Target MVP | Como medir |
|---|---|---|---|
| **Taxa de resolução por IA** | % de conversas que terminam sem handoff humano | 50–60% | Contador de conversas com `handoff_triggered=false` / total resolvidas |
| **Tempo médio até primeira resposta** | Minutos entre mensagem do cliente e primeira resposta (humano ou IA) | <30s pra IA; <5min pra humano | Diff entre `messages.created_at` (inbound) e próxima outbound |
| **NPS pós-atendimento** | Nota 0–10 do cliente final ao final da conversa resolvida | ≥75 (% promotores) | Mensagem automática de NPS após `conversation.status='resolved'` |
| **Custo médio por atendimento** | R$ por conversa resolvida (IA + humano + infra) | <R$ 3,00 | Custo total mensal / número de conversas resolvidas |
| **Taxa de banimento WAHA** | % de números banidos por mês | 0% | Alertas em ≥1 incidente; pós-mortem obrigatório |
| **Tempo de resposta a data_request LGPD** | Dias úteis entre webhook recebido e export entregue | ≤7 dias | Diff entre `webhook.received_at` e `export.delivered_at` |
| **SLA de uptime do tenant** | % de minutos no mês com WAHA WORKING + API respondendo 200 | ≥99,5% | Health-check externo (UptimeRobot ou similar) |

### 8.2 Métricas de produto (não MVP-gating)
- Número de tenants ativos
- Mensagens processadas por mês (por tenant e total)
- Custo de IA por tenant (token use)
- Quantidade de leads/pedidos importados da Nuvemshop
- Tempo médio de ciclo de pipeline (carrinho → entregue)

### 8.3 Critério de sucesso geral do MVP
DeskcommCRM é considerado MVP-validado quando:
1. Pelo menos **1 tenant real** está em produção atendendo clientes finais por **30 dias contínuos** sem incidente que cause banimento WAHA ou perda de dados.
2. Pelo menos **5 KPIs dos 7 listados acima** estão sendo medidos automaticamente e dentro do target ou com plano de correção.
3. Audit log e LGPD passam revisão manual sem encontrar lacuna crítica.

---

## 9. Roadmap de Alto Nível

| Fase | Duração | Entrega principal |
|---|---|---|
| **Fase 1 — MVP-B** | 8–12 semanas | Plataforma base + Customer 360 det. + WAHA + Pipeline Kanban + Atendimento humano + Chatbot RAG + Handoff sentiment + Nuvemshop |
| **Fase 1.5 — Hardening** | +4–8 semanas | Testes automatizados densos, runbooks, observability profunda, documentação operacional, security review |
| **Fase 2 — MCP público** | +6–8 semanas | MCP server `/crm-mcp/` com 19 tools, deploy HTTP, auth Bearer multi-tenant |
| **Fase 3 — Identity probabilística** | +4 semanas | Device fingerprint, behavior matching, merge UI |
| **Fase 4 — Multi-canal** | +6–8 semanas | Instagram DM, email, web chat |
| **Fase 5 — Multi-plataforma e-commerce** | +4 semanas cada | VTEX, depois Shopify (1 por trimestre) |

Roadmap revisado a cada 4 semanas. Estimativa otimista; recalibrar a cada milestone.

---

## 10. Riscos & Mitigações

| # | Risco | Severidade | Mitigação |
|---|---|---|---|
| R1 | **Banimento de número WAHA** (WhatsApp detecta API não-oficial) | Crítico | Anti-banimento herdado (throttle, warm-up, spinning, STOP detection); monitoramento de saúde; ter número backup pré-aquecido por tenant; runbook de troca-de-número documentado |
| R2 | **Mudança contratual da Nuvemshop** (deprecação de webhook, mudança de auth) | Alto | Adapter pattern isola a integração; assinar feed de release notes da Nuvemshop; testes de contrato no CI |
| R3 | **Ban da WAHA Plus pelo WhatsApp** (third-party upstream) | Alto | Variante BYO documentada (cliente roda WAHA próprio); consideração de migração futura pra API oficial Meta como Fase 2.5 |
| R4 | **Custo de IA escala pior que receita** (tokens em RAG explodem) | Alto | AI Gateway com observability por tenant; orçamento por tenant configurável; fallback pra Haiku ou modelos menores pra triagem |
| R5 | **LGPD/ANPD multa primeiro tenant** (lacuna em data_request) | Alto | LGPD desde o dia 1; revisão jurídica antes de produção; SLA interno de D+7 com alarme em D+5 |
| R6 | **Sentiment detection produz falso-positivo crônico** (escala humano demais ou de menos) | Médio | Threshold configurável por tenant; revisão semanal de casos divergentes; trigger humano-no-loop pros primeiros 30 dias |
| R7 | **Vazamento cross-tenant** (bug em RLS ou query sem filtro) | Crítico | RLS em toda tabela; testes de isolamento no CI (cada teste cria 2 tenants e verifica que cliente A não vê dados de B); audit log de queries com flag `bypassed_rls=true` |
| R8 | **Atraso na entrega do MVP** (8–12 semanas é otimista) | Médio | Sub-PRDs priorizados Now/Next/Later; possibilidade de MVP-A (sem IA) como fallback se cronograma estourar |
| R9 | **Equipe pequena queima** (greenfield com escopo grande) | Médio | TBD na próxima rodada; considerar 2-3 devs full-stack + 1 DevOps part-time como mínimo |

---

## 11. Glossário

- **Tenant** — uma organização cliente do DeskcommCRM (um negócio que vende pelo WhatsApp: e-commerce, clínica, imobiliária, infoprodutor, etc.). No DB = `organizations`. Sinônimo: organização.
- **Operador BPO** — funcionário da empresa operadora que atende múltiplos tenants. Tem role super-admin de plataforma.
- **Super-admin de plataforma** — role que cruza tenants. Distinto do `admin` de um tenant específico.
- **Lead / Cliente** — registro central no CRM (`crm_leads`). No vocabulary de e-commerce, lead = "Cliente". Engloba cliente em qualquer estágio (interesse, comprou, pós-venda).
- **Deal / Pedido** — instância de oportunidade comercial; em e-commerce, sinônimo de Pedido. Modelado como `crm_leads` (não `crm_deals`).
- **Activity** — evento da timeline polimórfica (`crm_lead_activities`). Pode ser whatsapp_inbound, whatsapp_outbound, payment_received, stage_changed, agent_action, etc.
- **WAHA** — WhatsApp HTTP API. Solução não-oficial, baseada em engenharia reversa. Usamos a versão Plus (multi-tenant) por padrão.
- **Janela de 24h** — restrição da Meta: bots WhatsApp só podem enviar mensagens não-iniciadas pelo cliente até 24h após a última inbound. Após isso, exige template aprovado.
- **DIRC** — Duplicar / Integrar / Referenciar / Calcular. Heurística obrigatória antes de adicionar campo: "Esse dado vive aqui (Duplicar)? Vem de outro lugar via FK (Integrar)? É só ponteiro (Referenciar)? Pode ser computado on-demand (Calcular)?"
- **MCP** — Model Context Protocol da Anthropic. Spec aberta pra integração de LLMs com sistemas externos. Implementado via tools, resources, prompts e transports (stdio, HTTP).
- **RAG** — Retrieval-Augmented Generation. Padrão onde o LLM consulta uma base de conhecimento vetorizada antes de responder.
- **RLS** — Row-Level Security do Postgres. Política aplicada à linha que filtra acesso por usuário/tenant.
- **Identity resolution** — processo de unificar perfis duplicados de cliente. Determinística no MVP (email, telefone, CPF); probabilística (device fingerprint, comportamento) entra na Fase 3.

---

## 12. Apêndice — Índice de Sub-PRDs

| Sub-PRD | Tópico | Status |
|---|---|---|
| `01-prd-platform-base.md` | Plataforma Base (auth multi-tenant, RBAC, super-admin, audit, LGPD framework) | a escrever |
| `02-prd-customer-360.md` | Customer 360° + Identity Resolution determinística | a escrever |
| `03-prd-whatsapp-waha.md` | Canal WhatsApp via WAHA Plus (sessões, anti-banimento, multi-atendente) | a escrever |
| `04-prd-pipeline-attendance.md` | Pipeline Kanban + Atendimento + Tickets + Roteamento | a escrever |
| `05-prd-ai-rag-handoff.md` | IA Conversacional (chatbot + RAG + sentiment + handoff) | a escrever |
| `06-prd-nuvemshop-lgpd.md` | Integração Nuvemshop (OAuth + webhooks + LGPD) | a escrever |

Cada sub-PRD contém: contexto, escopo, requisitos funcionais, requisitos não-funcionais, contratos de API/dados, dependências, riscos específicos, plano de validação.

---

## Anexos

- `docs/research/reference-synthesis.md` — Síntese da arquitetura herdada
- `tasks/todo.md` — Workflow de construção (PRD → Regras → Specs → Epics → Stories → Plano)
