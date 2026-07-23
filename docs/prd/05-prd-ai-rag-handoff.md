---
title: Sub-PRD 05 — IA Conversacional + RAG por tenant + Sentiment Detection + Handoff
parent: 00-prd-master.md
depends_on: 01-prd-platform-base.md, 02-prd-customer-360.md, 03-prd-whatsapp-waha.md, 04-prd-pipeline-attendance.md
version: 0.1
status: em revisão
date: 2026-04-28
owner: Rafael Melgaço
referencia_arquitetural: docs/research/reference-synthesis.md
---

# Sub-PRD 05 — IA Conversacional + RAG por tenant + Sentiment Detection + Handoff

> Camada de inteligência operacional do DeskcommCRM. Define como o chatbot responde inbounds com contexto rico (perfil + último pedido + base de conhecimento do tenant), como o sistema detecta frustração em tempo real, e como o produto orquestra a transição bot→humano sem perda de contexto. Sem essa camada, o produto vira CRM convencional com WhatsApp colado; com ela, é o diferencial que justifica a tese do AI Sales OS — agentes de IA operando a venda de verdade (ver `VISION.md`).

---

## 1. Contexto & Posicionamento

PMEs de e-commerce recebem volume de atendimento que não fecha economicamente com humano puro: 60–70% das conversas são repetitivas (rastreio, prazo, troca, frete). Chatbot decorativo (FAQ em árvore) é pior que humano — frustra, escala reclamação, derruba reputação. A camada de IA do DeskcommCRM ocupa esse meio: bot que lê contexto real (últimas 20 mensagens + perfil + último pedido), conhece o tenant (FAQ + política + catálogo Nuvemshop + conversas resolvidas) e sabe a hora de chamar humano.

Dentro da arquitetura herdada: bot é mais um produtor de activities na timeline polimórfica do Sub-PRD 02 (`crm_lead_activities` com `type='ai_responded' | 'handoff_triggered' | 'sentiment_alert'`); RAG é camada de leitura sobre fontes versionadas por tenant; sentiment roda fora do path crítico via `event_log` (doutrina §2: trigger nunca faz HTTP). Modelo default vem do PRD-mestre §6.5 — Vercel AI Gateway com strings `"anthropic/claude-sonnet-4-6"` e fallback Anthropic→OpenAI no Gateway, sem import direto de SDK. Camada invisível pro cliente final, mas é a maior alavanca de margem operacional do produto.

---

## 2. Escopo

### Dentro do escopo
1. AI Agents por tenant (modelo lógico; 1 tenant N agents; MVP 1 default)
2. Estratégia de modelo via Vercel AI Gateway (Sonnet 4.6 + Haiku 4.5 triagem)
3. RAG por tenant com 4 fontes (FAQ + política + catálogo Nuvemshop + conversas resolvidas opt-in)
4. Pipeline de ingestão (chunking + embedding + persistência + re-indexação incremental + versionamento)
5. Roteamento da chamada do bot (contexto + RAG + invocação + persistência)
6. Sentiment detection em tempo real (Haiku, paralelo via event_log)
7. Handoff bot→humano com 4 gatilhos + política de retomada
8. Logs de chamadas LLM (`ai_invocations`) + dashboard de uso/custo
9. Orçamento de IA por tenant (alarme 80%, ação em 100%)
10. Guardrails (`ai_agents.guardrails` jsonb)
11. Citações de fonte em `messages.metadata.citations[]`
12. Modo "humano sempre" (por tenant ou por contact)
13. Logging de prompts/responses (debugability + LGPD)

### Fora do escopo
- Captura/envio físico WhatsApp → Sub-PRD 03
- Roteamento de atendentes humanos e UI da fila → Sub-PRD 04
- Sync e webhooks Nuvemshop que populam catálogo → Sub-PRD 06
- MCP tools-side, A/B testing → Fase 2
- Voice/áudio, multi-language, geração proativa, co-pilot → pós-MVP

---

## 3. Capacidades Funcionais

### 3.1 AI Agents por tenant

Tabela lógica `ai_agents` com `(organization_id, name, system_prompt, knowledge_base_id, is_active, model_config jsonb, guardrails jsonb)`. 1 tenant pode ter N agents (ex: "Atendimento Vendas" + "Suporte Pós-venda"); MVP seeda 1 default no onboarding. Roteamento avançado (qual agent atende qual conversa por pipeline/stage/tag) deferido — MVP usa default ativo. `system_prompt` editável pelo admin via UI; mudança auditada (Sub-PRD 01 §3.5). `model_config` controla `model` (default `"anthropic/claude-sonnet-4-6"`), `temperature`, `max_tokens`, `top_k_rag`. `is_active=false` cai em modo humano sempre (§3.12).

**ACs.** Onboarding cria 1 agent default. Edit de system prompt aplica na próxima inbound. Tenant com 0 agents ativos cai em humano sempre com banner. Audit captura `ai_agent.created|updated|deactivated`.

### 3.2 Estratégia de modelo

Adesão ao PRD-mestre §6.5. Resposta principal: Sonnet 4.6 via Gateway, string `"anthropic/claude-sonnet-4-6"`. Sentiment: Haiku 4.5 via Gateway. Fallback Anthropic→OpenAI configurado no Gateway, transparente pra app. Zero data retention configurável por tenant. Atualização de versão upstream não é automática: pin de versão, smoke test em staging antes de promover (risco A6).

**ACs.** Código usa string de modelo, nunca import direto de SDK. Failover do Gateway mantém p95 <3s. `zero_data_retention=true` propaga pras chamadas.

### 3.3 RAG por tenant — fontes de ingestão

Base vetorizada por tenant, isolada via `organization_id`. **4 fontes**:

1. **FAQ manual** — markdown editável via UI do admin. Item = pergunta + resposta + tags. Edição dispara re-indexação incremental.
2. **Política da loja** — upload de PDF/markdown (troca, frete, garantia, privacidade). Parsing PDF→texto, chunking, embedding. Versão registrada (rollback possível).
3. **Catálogo Nuvemshop sincronizado** — produtos vindos do Sub-PRD 06 (nome, descrição, preço, categoria, disponibilidade). Sync incremental por webhook `product/created|updated`.
4. **Conversas resolvidas como few-shot** — opt-in + anonimização obrigatória (nome/telefone/email/CPF substituídos por tokens). Apenas conversas `status='resolved'` com flag `usable_for_rag=true` marcada por atendente humano.

Princípios: isolamento forte (filter `organization_id` em toda query); versionamento por `kb_version` com rollback; re-indexação incremental, não em massa; pipeline assíncrono via `event_log` (`kb_source.changed` → worker `kb-reindex`); fontes desabilitáveis individualmente.

**ACs.** Edit de FAQ → bot usa conteúdo novo em ≤30s. Upload de PDF gera embedding e notifica admin. `product/updated` reindexa só o produto afetado. Conversa só entra como few-shot após anonimização validada. Query sem filter de `organization_id` é bloqueada com alerta.

### 3.4 RAG por tenant — pipeline técnico

**Vector store**: pgvector vs Supabase Vector — **deferido pra Spec** (§9). Trade-off: pgvector dá controle fino e roda no mesmo Postgres do CRM (simplifica RLS); Supabase Vector tem managed APIs e melhor DX. Benchmark obrigatório. **Embeddings**: OpenAI `text-embedding-3-small` vs Voyage — deferido. **Chunking**: fixed-size com overlap vs semantic — deferido; default inicial 512 tokens overlap 64. **Retrieval**: top-K=5 default, configurável por tenant (range 1–10). Persistência em `kb_chunks` (`organization_id, source_type, source_id, kb_version, content, embedding, metadata`). Ativação atômica (swap de versão ativa); rollback = reativar versão anterior.

**ACs.** Re-indexação total de 1k itens em ≤5min. Retrieval top-K=5 em <300ms p95. Rollback em <2s. Filter de `organization_id` obrigatório no retrieval layer.

### 3.5 Roteamento da chamada do bot

Quando inbound chega numa conversa cujo agent default está ativo (e `force_human` não setado), bot monta contexto + RAG + invoca + persiste resposta como activity + dispara outbound (Sub-PRD 03).

**Contexto montado**: últimas 20 mensagens da conversation; perfil do contact (`name`, `tags`, `custom_fields` relevantes); último pedido linkado via `crm_lead_links` (número, status, valor, data); top-K=5 RAG hits; system prompt + guardrails do agent.

**Output do bot**: `response_text`, `confidence_score` (0.0–1.0; algoritmo deferido), `citations[]`, `should_handoff` + `handoff_reason` (quando o próprio modelo decide escalar — gatilho 3).

Latência alvo <3s p95 entre inbound (após HMAC ok) e outbound `sending`. Bot respeita janela 24h Meta (§3.10) e `contacts.is_blocked=true`. Activity `ai_responded` registra `metadata.tokens|latency_ms|confidence_score|citations[]`. Persistência otimista como `messages.status='sending'` (mesmo padrão do Sub-PRD 03).

**ACs.** Resposta contextual em <3s p95. Bot cita número de pedido correto (do contexto, não alucinado). Confidence persistido em metadata. Inbound após janela 24h não gera outbound; cria activity `system.window_24h_expired`.

### 3.6 Sentiment detection em tempo real

Cada inbound roda análise binária (alta / baixa frustração) com Haiku 4.5, fora do path crítico. Webhook do WAHA emite `message.received`; worker dedicado consome via `event_log` — não bloqueia response-time do canal nem do bot. Output: `sentiment_score` float 0.0–1.0 (1.0=neutro/positivo; 0.0=altamente frustrado), persistido em `messages.metadata.sentiment_score`. Latência 1–2s. Threshold por tenant (default 0.3); abaixo dispara handoff (G2). Activity `sentiment_alert` criada apenas quando score < threshold.

**ACs.** Score em ≤2s p95 sem afetar bot. Score < threshold dispara `sentiment_alert` + handoff. Ajuste de threshold aplica nas próximas mensagens. Falha do worker degrada graceful.

### 3.7 Handoff bot→humano (4 gatilhos)

- **G1 — Pedido explícito.** Regex no inbound tipo `/humano|atendente|pessoa|gente real|falar com algu[eé]m/i` (lista deferida). Match síncrono.
- **G2 — Sentiment baixo.** `sentiment_score` < threshold do tenant. Avaliado quando worker grava score.
- **G3 — Incerteza da IA.** Resposta contém marcadores ("não sei", "vou verificar") OU `confidence_score` < threshold (default deferido). Avaliado pós-resposta, **antes do despacho** — bot retém mensagem e dispara handoff.
- **G4 — Estágio crítico.** Conversa entra em stage marcado `requires_human=true` (configurável por manager); ou contexto detecta menção a fraude/jurídico/produto fora do catálogo (guardrails §3.10).

Ao acionar: criar activity `handoff_triggered` com `metadata.trigger_reason` (`'explicit_request'|'low_sentiment'|'ai_uncertainty'|'critical_stage'`) + `metadata.sentiment_score`/`confidence_score` quando aplicáveis; mudar `conversation.status='pending'` (Sub-PRD 04); notificar atendentes online via Realtime + push. Bot fica silencioso até reativação (§3.8).

**ACs.** "Quero falar com humano" → handoff em ≤500ms; bot não responde. Sentiment 0.15 (threshold 0.3) → `handoff_triggered` em ≤2s. Bot que ia responder "não sei" intercepta, dispara handoff, não envia o "não sei". Stage `requires_human=true` dispara handoff na entrada do stage.

### 3.8 Política de retomada após handoff

Default: bot **não reassume**. Humano fica responsável até `conversation.status='resolved'`. Atendente pode reativar bot via botão "Passar pra IA"; ação auditada (`ai_reactivated_by_agent` activity). Após `resolved`, próxima conversation que abrir naquele contact começa com bot (default), exceto se `contacts.force_human=true` (§3.12). Sem retomada automática por "cliente voltou a engajar bem" no MVP — risco de oscilação confunde cliente.

**ACs.** Handoff → bot silencioso até reativação ou resolved. "Passar pra IA" → próxima inbound com bot. Conversa resolvida + nova conversation 7 dias depois no mesmo contact → bot responde. Contact com `force_human=true` → bot nunca responde.

### 3.9 Logs de chamadas LLM

Tabela lógica `ai_invocations` por tenant: `agent_id`, `conversation_id`, `message_id`, `model`, `tokens_prompt`, `tokens_completion`, `latency_ms`, `cost_cents`, `finish_reason`, `kb_version_used`, `created_at`. Custo calculado a partir de tabela de pricing por modelo (atualizável sem deploy). Insert fire-and-forget. Dashboard do admin: custo do mês, mensagens processadas, taxa de handoff, latência média, distribuição de confidence.

**ACs.** Toda chamada LLM gera 1 linha em `ai_invocations` em ≤500ms p99. Dashboard mostra custo do mês com diff vs anterior. Custo total bate ±2% com fatura do Gateway no fim do mês.

### 3.10 Guardrails

Em `ai_agents.guardrails` jsonb. Aplicados em duas camadas: instruções no system prompt + validação programática pós-resposta (defesa em profundidade — modelo pode ignorar prompt; validador intercepta).

**Guardrails default MVP:**
- Nunca prometer ressarcimento (estorno, reembolso) sem confirmação humana → handoff
- Nunca falar de produto fora do catálogo Nuvemshop — sem RAG hit em pergunta sobre produto → handoff
- Sempre escalar se cliente mencionar `fraude | jur[ií]dico | ANPD | pol[ií]cia | processo | advogado`
- Sempre escalar se cliente pede dados sensíveis (CPF de terceiro, dados bancários completos)
- Respeitar janela 24h Meta — não envia outbound se passou >24h da última inbound; alerta atendente
- Respeitar `contacts.is_blocked=true` — não responde

Guardrails versionados junto com o agent (mudança auditada). Formato declarativo do jsonb deferido pra Spec.

**ACs.** "Quero meu dinheiro de volta" → handoff. "Vocês têm produto X?" sem X no catálogo → handoff. "Vou processar vocês" → handoff imediato com tag `legal_mention`. Outbound em janela expirada → bloqueado; activity `system.guardrail_blocked`.

### 3.11 Citações de fonte (debug interno)

Resposta com RAG hit persiste `messages.metadata.citations[]` com `{chunk_id, source_type, source_id, score, kb_version}`. No MVP, citações **não** vão pro cliente final (resposta vai limpa pelo WhatsApp); ficam disponíveis pra debug interno (UI do atendente em modo debug, logs). Pós-MVP: explorar exposição opcional ("Conforme nossa política de troca...").

**ACs.** Resposta com RAG hit → ≥1 citation. Sem RAG → `citations=[]`. UI debug mostra fontes citadas. Citação aponta `kb_version` correta (rastreabilidade pós-rollback).

### 3.12 Modo "humano sempre"

Override que desliga bot total ou pontualmente. **Por tenant**: admin desliga bot inteiro (`is_active=false` em todos os agents OU `organizations.settings.ai_disabled=true`); inbounds vão direto pra fila humana com `conversation.status='pending'`. **Por contact**: `contacts.force_human=true` (cliente VIP, conta sensível, em disputa) — bot nunca responde mesmo com agent ativo. Mudança auditada. UI mostra badge "Humano forçado". Reset de `force_human=false` requer `manager+`.

**ACs.** Admin desliga IA → inbounds não disparam bot. Contact com `force_human=true` → status='pending' direto. UI mostra badge + botão "Reativar IA pra esse contato" (manager+).

### 3.13 Orçamento de IA por tenant

`ai_budget.monthly_limit_cents` + `ai_budget.action_at_100pct: 'throttle'|'disable'`. Alarme em 80% notifica admin (email + UI banner). Em 100%: modo `throttle` continua respondendo mas só com Haiku 4.5 (degrada qualidade pra controlar custo) OU rejeita inbounds excedentes (decisão deferida); modo `disable` desliga bot até virar mês ou admin aumentar limite. Cálculo rolling a cada `ai_invocation` insert; reset todo dia 1º. Super-admin pode setar `platform_max_per_tenant` pra evitar runaway (proteção operadora BPO).

**ACs.** Tenant em ≥80% recebe alarme. Em 100% modo `disable` → bot desliga com activity `ai_budget_exhausted`. Reset mensal libera em D+1. Override manual reativa em <30s.

### 3.14 Logging de prompts e responses

Toda invocação grava prompt completo + response + tools chamados (Fase 2). Retenção: 90 dias hot + cold storage (S3) com lifecycle (doutrina audit Sub-PRD 01). Sanitização de PII opcional por tenant (CPF, telefone, email, nome próprio mascarados antes do envio ao modelo — LGPD Sub-PRD 01 §3.6). Acesso restrito a `admin` do tenant + super-admin; toda leitura auditada. Armazenado como blob comprimido (gzip/zstd), não jsonb cru.

**ACs.** Admin abre invocação X e vê prompt+response. Sanitização de CPF ativa → próximo prompt grava `***********`. Logs >90d migram pra cold storage. Tentativa de acesso cross-tenant retorna 403 + alerta.

---

## 4. Requisitos Não-Funcionais

**Performance.** Bot inbound→outbound `sending` <3s p95. Sentiment <2s p95 (paralelo). Retrieval RAG top-K=5 <300ms p95. Re-indexação incremental de 1 item <5s p95. Insert em `ai_invocations` <500ms p99.

**Custo.** Custo médio por conversa resolvida pelo bot target <R$ 0,50 (revisitado mensalmente). AI Gateway com observability por tenant é mandatório.

**Confiabilidade.** Falha do provedor primário → fallback transparente no Gateway. Worker de sentiment falho não derruba bot (degrada graceful). Vector store down → bot continua sem RAG (maior chance de handoff por incerteza).

**Segurança & Conformidade.** Isolamento cross-tenant forte no vector store (A5). Logs de prompts respeitam LGPD. Zero data retention configurável por tenant. Mudanças de `system_prompt`, `guardrails`, `is_active`, `force_human`, `monthly_limit_cents` são auditadas (Sub-PRD 01 §3.5).

**Observabilidade.** Dashboard por tenant (custo, mensagens, taxa de handoff, latência, distribuição de confidence). Métricas globais (super-admin) com top consumers e alertas de tenants em 80%/100%. Sentry nos workers com sanitização antes do send.

---

## 5. Acceptance Criteria do sub-PRD

A camada é **MVP-completa** quando:

1. Tenant criado tem 1 `ai_agent` default ativo; bot responde em <3s p95 a inbound padrão
2. RAG ingere as 4 fontes (FAQ via UI + 1 PDF + catálogo Nuvemshop ≥10 produtos + ≥5 conversas resolvidas anonimizadas) e retrieval retorna top-5 relevantes
3. Edit de FAQ → bot usa conteúdo novo em ≤30s; rollback de versão em <2s
4. Sentiment grava `messages.metadata.sentiment_score` em ≤2s p95 sem afetar bot principal
5. 4 gatilhos de handoff funcionam com `metadata.trigger_reason` correto; após handoff bot fica silencioso até "Passar pra IA" ou `resolved`
6. `ai_invocations` registra todas chamadas; dashboard mostra custo do mês com diff <2% vs fatura do Gateway
7. Orçamento: alarme 80%, ação configurável em 100%; reset no dia 1º
8. Guardrail bloqueia promessa de ressarcimento (handoff) e produto fora de catálogo (handoff)
9. Modo humano sempre funciona em 2 níveis (tenant e contact via `force_human`)
10. `messages.metadata.citations[]` com chunk_id + kb_version corretos
11. Logs de prompt+response retidos 90d hot; sanitização de PII configurável
12. Isolamento cross-tenant testado: query forçando outro `organization_id` é bloqueada e gera alerta
13. Bot respeita janela 24h Meta e `contacts.is_blocked=true`

---

## 6. Dependências

### Internas
- **Sub-PRD 01** — auth, RLS, audit, event_log, convenções API
- **Sub-PRD 02** — `crm_lead_activities` polimórfica (tipos `ai_responded`, `handoff_triggered`, `sentiment_alert`); `contacts` (`is_blocked`, `is_anonymized`); `crm_lead_links` pra último pedido
- **Sub-PRD 03** — webhook inbound, envio outbound, janela 24h, idempotência
- **Sub-PRD 04** — `conversation.status='pending'`, roteamento, notificação Realtime/push, stages `requires_human=true`
- **Sub-PRD 06** — sync de catálogo (fonte 3 do RAG); webhooks `product/created|updated` (bloqueante pra RAG completo; bot funcional sem catálogo se outras 3 fontes existirem)

### Externas
- Vercel AI Gateway com fallback Anthropic→OpenAI
- Anthropic API (Sonnet 4.6 + Haiku 4.5)
- OpenAI API (fallback + potencialmente embeddings)
- Voyage AI opcional (decisão deferida)
- pgvector ou Supabase Vector
- S3 (cold storage de logs >90d)

---

## 7. Riscos Específicos do sub-PRD

| # | Risco | Severidade | Mitigação |
|---|---|---|---|
| **A1** | Custo de IA explode (top-K alto + Sonnet em todos) | Crítico | Top-K conservador (5); orçamento por tenant com alarme 80% / throttle 100%; observability via Gateway; fallback Haiku em throttle |
| **A2** | Bot aluciena sem RAG (catalog miss) | Crítico | Guardrail "produto fora de catálogo" + validador pós-resposta; sem RAG hit em pergunta sobre produto → handoff |
| **A3** | Bot escala humano demais (false positive sentiment) | Alto | Threshold por tenant; revisão semanal nos primeiros 30d; humano marca "handoff desnecessário" alimentando ajuste |
| **A4** | Bot escala humano de menos (false negative) | Alto | 4 gatilhos redundantes; regex de pedido explícito como rede de segurança; revisão amostral de NPS |
| **A5** | Vector store cross-tenant leak | Crítico | Filter `organization_id` em toda query (programático + RLS quando viável); teste de isolamento no CI; alerta se query sem filter |
| **A6** | Modelo upstream muda comportamento sem aviso | Médio | Pin de versão via Gateway; smoke test em staging; monitoramento de regressão semanal; rollback rápido |
| **A7** | Latência alta em pico (>5s p95) | Alto | Gateway com fallback regional; controle de tamanho de contexto; alerta em p95 >3.5s sustained; degradação graceful |
| **A8** | RAG stale (FAQ editado e bot responde antigo) | Alto | Re-indexação incremental síncrona; SLA <30s; UI mostra "última indexação"; alerta se lag >5min |
| **A9** | Bot envia fora da janela 24h e tenant é banido | Crítico | Guardrail hard de janela 24h; validação pré-despacho; activity `system.window_24h_expired` em vez de tentar enviar |
| **A10** | Custo de embeddings em sync inicial de catálogo grande | Médio | Batching agressivo; modelo de embeddings menor pra initial load; sync spread em horas |
| **A11** | Conversas anonimizadas vazam PII residual no few-shot | Alto | Validador automático (regex CPF/email/telefone/nome próprio); opt-in explícito; revisão amostral |
| **A12** | Logging de prompts armazena PII e vira problema LGPD | Médio | Sanitização opcional por tenant; retenção 90d hot + cold; acesso restrito; auditado |

---

## 8. Fora de Escopo (deste sub-PRD)

- MCP tools-side (bot mutar CRM via tools) — Fase 2
- A/B testing de prompts — Fase 2
- Multi-language (tenant em ES/EN) — pós-MVP
- Voice/áudio (transcrição de áudio) — pós-MVP
- Geração proativa (recovery de carrinho por IA) — pós-MVP
- NPS automatizado com cálculo agregado — pós-MVP
- Roteamento avançado de agents (1 default no MVP) — pós-MVP
- Fine-tuning custom por tenant — não previsto
- Modo "co-pilot" (sugestão pro humano em vez de envio) — pós-MVP
- Aprendizado online (bot melhora com feedback) — pós-MVP

---

## 9. Decisões deferidas pra Spec (Fase 3)

A decidir em `docs/specs/05-spec-ai-rag-handoff.md`:

1. **Vector store**: pgvector vs Supabase Vector — benchmark (latência, custo, DX, RLS)
2. **Embeddings**: OpenAI `text-embedding-3-small` vs Voyage — benchmark em PT-BR
3. **Chunking**: fixed-size com overlap vs semantic; tamanho/overlap ótimos
4. **Schema SQL completo** de `ai_agents`, `ai_invocations`, `kb_chunks`, `kb_versions`, `kb_sources`
5. **Política de re-indexação**: debounce e batching (sync de 10k produtos em quantos lotes?)
6. **Formato declarativo dos guardrails jsonb** (regex? JSON schema com operadores? híbrido?)
7. **Sistema de prompt templates com variáveis** (Handlebars-like? Mustache? custom mínimo?)
8. **Threshold default de `confidence_score`** pra disparar G3
9. **Listas canônicas**: regex de pedido explícito de humano (PT-BR), marcadores de incerteza, termos de escalação obrigatória
10. **Algoritmo de cálculo de `confidence_score`** (heurística + auto-avaliação ou só heurística)
11. **Política de modo throttle em 100%**: degrada pra Haiku ou rejeita inbounds excedentes?
12. **Estratégia de anonimização** de conversas resolvidas pra few-shot (validador + revisão amostral)
13. **A/B testing framework** (deferido pra Fase 2, spec deve considerar encaixe)
14. **Layout do dashboard de uso** + fluxo de UI pra editar FAQ, upload de política, marcar `usable_for_rag`

---

## Anexos

- `docs/research/reference-synthesis.md` (especialmente §2 Arquitetura, §3 Data model, §11 Gaps a desenhar — pontos 3 e 4)
- `docs/prd/00-prd-master.md` (especialmente §6.2, §6.3, §6.5)
- `docs/prd/01-prd-platform-base.md` (audit log, event_log, LGPD framework)
- `docs/prd/02-prd-customer-360.md` (timeline polimórfica, contacts, crm_lead_links)
- `docs/prd/03-prd-whatsapp-waha.md` (inbound webhook, outbound dispatch, janela 24h)
- `docs/prd/04-prd-pipeline-attendance.md` (conversation.status, roteamento, stages)
- `tasks/todo.md`

---

## Anexo — Sistema de Follow-up Inteligente (2026-07)

> Contrato detalhado: `docs/superpowers/specs/2026-07-21-followup-system-design.md`.
> Pesquisa de referência (odysseus/hermes/openclaw + autópsia TomikCRM): `docs/research/followup-reference-mining.md`.

O agente ganhou um subsistema de follow-up com **um motor, um enrollment, um relógio** (`followup_enrollments.next_eval_at`) — silêncio, demanda ("me chama em X dias") e campanha são gatilhos do MESMO grafo, nunca motores paralelos (o anti-padrão-raiz do CRM anterior).

**Modelo de dados** (migrations 0054/0056/0057/0061, todas no baseline + MANIFEST):
- `followup_flow_versions` (grafo imutável) + `followup_flow_pointers` (identidade, `draft_graph`, `handoff_policy`, `trigger_config`) — padrão `*_versions`/`*_pointers` do harness; lead em voo fica pinado na versão em que entrou.
- `followup_enrollments` (lead no fluxo: status active/waiting_reply/paused_handoff/completed/cancelled/dead, `next_eval_at`, `outcome`) + `followup_enrollment_events` (append-only, idempotência por `(enrollment_id, idempotency_key)`).
- `ai_agent_versions.followup jsonb` (`{enabled, flow_pointer_ids}`) — seletor de fluxos por agente, no veto de imutabilidade da versão.

**Motor** (`lib/followup/engine.ts`, cron `followup-flow-worker` 1/min): claim `FOR UPDATE SKIP LOCKED`, 1 nó/tick, envio **at-most-once** (mensagem duplicada de follow-up = ban), backoff `[30s,1m,5m,15m,1h]` → dead-letter em `agent_inbox_items`. Nós de IA delegam a `job_queue` (kind `followup_turn`).

**6 nós** (Zod + validador estrutural exato no publish, `lib/followup/validate-publish.ts`): Gatilho (silêncio/estágio/fim-de-conversa), Espera (fixa/inteligente com clamp), Condição, IA Classifica (grace obrigatório ≥15min), Ação (ai_message/template), Fim. Builder visual React Flow em `/app/ai/followups`.

**As 3 causas-raiz do CRM anterior viraram regras estruturais:** (1) janela 24h validada no PUBLISH (espera longa exige template fallback); (2) `ai_classify` com grace obrigatório (nunca classifica no instante zero); (3) `paused_handoff` com retomada por evento (`ai.handoff_resolved`) — estado órfão impossível.

**Reatividade** (`lib/followup/reactivity.ts`, via event_log dispatcher): inbound acorda classify; STOP cancela tudo (`opted_out`); handoff pausa/retoma. **Gatilho de silêncio** (`lib/followup/silence-sweep.ts`) só enrolla se um agente publicado tem o fluxo habilitado (gate org-wide). **Flywheel**: `lib/followup/outcome-stats.ts` agrega outcomes por fluxo/versão (`conversion_rate`) no run do flywheel.

**Fila** (`/app/ai/followups` aba Fila): união de enrollments vivos + promessas do `schedule_followup`, com cancelamento manager+.
