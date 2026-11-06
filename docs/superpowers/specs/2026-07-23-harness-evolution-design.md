# Design — Evolução do Harness de Agentes (épico em 5 fases)

**Data:** 2026-07-23
**Status:** Aprovado (design mestre). Cada fase gera seu próprio plano de implementação.
**Escopo:** Transformar o agente de IA num harness completo e coeso — runtime único, Memória Geral da Org, Skills instaláveis com marketplace, Intent Router configurável e Painel de Evolução. Objetivo de negócio: o harness como moat — o acúmulo de personalização e aprendizado por tenant torna a migração onerosa.

---

## Contexto (estado atual do código)

- **Dois runtimes coexistem**, chaveados por `organizations.settings.ai_dispatch_mode`: o runtime nativo (`lib/ai/runtime/agent.ts`, single-turn, dono do RAG pgvector) e o **agent-engine** (`lib/agent-engine/`, porte do Vendaval, ativo em produção via `workers/agent-worker/main.ts`). Capacidades disjuntas: RAG só no nativo; memória durável, skills situacionais, follow-up, guardrails e flywheel só no engine.
- **Skills situacionais já funcionam** (`lib/agent-engine/agent/skills.ts` + `skill_versions`/`skill_pointers`): matcher determinístico por keywords (e, opcionalmente, por etiqueta da conversa ou do contato via `any_tags`), índice no prefixo estável cacheável, corpo carregado sob demanda. Skills de plataforma (`org_id null`) com override por tenant já existem no schema — semente do marketplace. O que não existe: pacote (`references/`, `assets/`), upload `.zip`, UI de catálogo.
- **Memória por lead existe** (`lead_checkpoints`, `lead_notes`, `lead_state`); **memória por org não existe**.
- **Flywheel com gate humano existe** (`lib/agent-engine/flywheel/live.ts`): juiz avalia turnos reais, distiller propõe bullets de playbook, dono aprova na tela (`flywheel_distiller_proposals`, apply via `lib/ai/apply-proposal.ts`).
- **Não há roteamento por intenção.** A escolha do agente é `(org, channel_session)` + `priority` + `trigger_config` — `lib/agent-engine/agent/agent-config.ts` `loadPublishedAgentConfig`.
- **RAG pgvector** (`ai_chunks`, RPC `retrieve_top_k_chunks`, ingestão em `lib/ai/rag/` + `workers/rag-indexer.ts`) é consumido só pelo runtime nativo.
- **Prefixo estável é doutrina** (`lib/agent-engine/edge/llm/stable-prefix.ts`): tudo que entra no system prompt permanente precisa ser cacheável; conteúdo por-lead vai no sufixo.

## Decisões registradas

1. **Runtime único**: o agent-engine é o harness canônico. Ele absorve o RAG; o runtime nativo sai do caminho de execução (Fase 0).
2. **Skills v1 sem código executável**: `SKILL.md` + `references/` + `assets/`. Scripts só quando houver sandbox (fora deste épico).
3. **Memória da Org híbrida**: documento-mãe curado (estilo CLAUDE.md) + entradas de aprendizado individuais (estilo MEMORY.md), ambos versionados e aprovados por humano.
4. **Ordem de entrega**: Fase 0 → 1 → 2 → 3 → 4, cada fase com valor stand-alone; o painel final só lê artefatos que as fases anteriores depositam.
5. **RAG como tool** (`search_knowledge`), não injeção automática no prompt — preserva o prefixo estável e deixa o agente decidir quando buscar.

---

## Arquitetura de camadas de contexto (o "encaixe")

A ordem de montagem do system prompt do turno passa a ser:

```
PREFIXO ESTÁVEL (cacheável, muda só quando algo é publicado)
  1. Playbook de plataforma
  2. Memória Geral da Org  (doc-mãe + entradas ativas)      ← Fase 1
  3. Prompt do agent (ai_agent_versions.system_prompt)
  4. Índice de skills (name + description)                   ← já existe
SUFIXO POR-LEAD (muda a cada turno)
  5. Checkpoint + rolling_summary + lead_state + índice de notas
  6. Contexto do lead (get_lead_context)
  7. Corpos de skills casadas pelo matcher                    ← já existe
```

Carga sob demanda além do prompt: `search_knowledge` (RAG), `read_skill_reference` (referências de skill), `get_lead_note` (já existe). Tudo read-only e whitelisted no circuit breaker.

---

## Fase 0 — Convergência (runtime único)

- **Tool `search_knowledge`** no agent-engine: recebe `query`, embeda (`lib/ai/embed.ts`), chama `retrieve_top_k_chunks` com o `active_kb_version_id` do agent e os thresholds do `config` (`rag_top_k`, `rag_similarity_threshold`). Entra em `READ_ONLY_TOOLS` do tool-breaker. Resultado inclui metadados de citação; quando o agente envia mensagem baseada em busca, as citações vão para `messages.metadata.citations` (formato existente de `lib/ai/citations/`).
- **Dispatch único**: `ai_agent.dispatch_requested` passa a ser consumido só pelo `agent-worker` (`lib/agent-engine/edge/crm/drain.ts`). O dispatcher nativo (`lib/ai/dispatcher/`) e `lib/ai/runtime/agent.ts` são retirados do caminho quente e marcados como depreciados; remoção física em ciclo posterior. `ai_dispatch_mode` deixa de existir como chave de runtime (mantido apenas para o contrato de agentes externos da spec 14, que é outro eixo).
- **Agents `kind=rag_bot`** rodam no engine com `search_knowledge` habilitada por default.
- **O que NÃO muda**: pipeline de ingestão RAG (`lib/ai/rag/`, `workers/rag-indexer.ts`), telas de knowledge, credenciais BYOK, orçamento (`ai_budgets`), handoff do engine.
- **Critério de aceite**: turno real ponta-a-ponta (WhatsApp → engine → resposta com citação de conhecimento) provado na tela; runtime nativo sem tráfego; teste de isolamento RLS intacto.

## Fase 1 — Memória Geral da Org

- **Schema** (padrão versão-imutável + ponteiro do repo):
  - `org_memory_versions` — documento-mãe markdown, imutável, `version_number`, `published_at`; ponteiro da versão ativa em tabela própria `org_memory_pointers` (mesmo padrão de `skill_pointers`).
  - `org_memory_entries` — aprendizados individuais: `title`, `body`, `source` (`manual` | `flywheel`), `status` (`proposed` | `active` | `archived`), `proposal_id` (FK opcional para `flywheel_distiller_proposals`), timestamps. RLS + `organization_id` em ambas.
- **Injeção**: camada 2 do prefixo estável (ver arquitetura acima), montada em `stable-prefix.ts`: doc-mãe íntegro + entradas `active` renderizadas compactas. Versão publicada nova ⇒ prefixo novo ⇒ invalidação de cache correta e barata.
- **Flywheel → memória**: o distiller ganha um segundo tipo de proposta (`target: org_memory`). O fluxo de apply existente cria a `org_memory_entry` com `status=active`. Nada vira comportamento sem aprovação humana (doutrina mantida).
- **UI** `app/app/ai/memory`: editor do documento com histórico de versões e diff; linha do tempo das entradas (aprovar proposta, arquivar, criar manual).
- **Critério de aceite**: editar memória na tela → publicar → próximo turno de QUALQUER agent da org reflete a regra (prova visível); entrada proposta pelo flywheel aparece na linha do tempo e só entra no prompt após aprovação.

## Fase 2 — Skills como pacote instalável + marketplace

- **Formato do pacote**: diretório com `SKILL.md` (frontmatter: `name`, `description`, `matcher.any_keywords`, `matcher.probe_keywords`) + `references/*.md` + `assets/*` (mídia/documentos enviáveis). Sem executáveis.
- **Storage**: arquivos do pacote em bucket privado `skill-assets` (`{org_id|platform}/{skill}/{version}/...`); `skill_versions` ganha colunas de manifest (lista de arquivos, tamanhos, hashes). Corpo da skill continua na tabela (fonte do disclosure).
- **Upload `.zip`**: rota `POST /api/v1/ai/skills/import` — descompacta com limites (tamanho total, nº de arquivos, extensões whitelist), valida frontmatter com Zod, cria `skill_version` nova (imutabilidade preservada; re-upload = versão nova).
- **Carga em camadas**: índice no prefixo e corpo-sob-matcher já existem; novos degraus: tool read-only `read_skill_reference(skill, path)` (só lê referências de skills atualmente casadas no turno — sem vazamento entre skills) e envio de `assets/` via `send_message` com mídia (depende da Onda 0/2 do épico multimodal para o caminho outbound de mídia; se ainda não estiver pronto, assets ficam atrás de flag).
- **Marketplace**: UI `app/app/ai/skills` com dois planos — "Instaladas" (da org) e "Catálogo" (skills de plataforma, `org_id null`). Instalar = criar pointer da org; Personalizar = fork para versão própria (override que o schema já suporta). Seed inicial de skills de fábrica por nicho (e-commerce, clínicas, imobiliárias).
- **Telemetria**: registrar ativação de skill por turno (skill, versão, gatilho hard/probe) — em tabela própria `skill_activations` (consulta direta e barata pelo painel da Fase 4; a tabela `metrics` agregada não dá granularidade por skill/versão).
- **Critério de aceite**: upar um `.zip` na tela → skill aparece no agente → mensagem com keyword dispara a skill → resposta usa o conteúdo e (se aplicável) envia um asset — tudo provado na tela; skill do catálogo instalável e personalizável em 2 cliques.

## Fase 3 — Intent Router

- **Schema**:
  - `ai_routers` — `organization_id`, `name`, `channel_session_id` (unique por sessão), `is_active`, `config` jsonb (`fallback_agent_id`, `classifier_model` default Haiku, `sticky` bool default true, `min_confidence`).
  - `ai_router_members` — `router_id`, `agent_id`, `intent_name`, `intent_description`, `examples text[]`, `position`.
  - Editáveis direto (sem versões imutáveis na v1); mutações auditadas em `api_audit_log` como as demais.
- **Runtime** (no `inbound_turn`, antes de `loadPublishedAgentConfig`):
  1. Guards existentes primeiro — `force_human`, `bot_silenced_until`, STOP/opt-out. Quem pediu humano nunca é classificado.
  2. Se o canal tem router ativo: classificação com saída estruturada (lista de `intent_name` + descriptions + exemplos + opção `none`), uma chamada barata, orçada como as demais (`run-model-call.ts`).
  3. **Stickiness**: a conversa grava `active_ai_agent_id`; turnos seguintes mantêm o agent sem reclassificar, exceto se a classificação (rodada em amostra/heurística de mudança de assunto) devolver intenção diferente com confiança ≥ `min_confidence`. Handoff/fechamento limpa a atribuição.
  4. `none` ou confiança baixa → `fallback_agent_id`; router sem fallback e sem match → sem resposta de IA (comportamento atual de canal sem agent).
- **Gatilho**: canal com router ⇒ o vínculo `channel_session_id` da versão do agent deixa de ser exigido para os membros do router (o router é a fonte do disparo). Vínculo direto agent↔canal permanece para canais sem router.
- **Telemetria**: cada decisão gravada (router, intenção detectada, confiança, agent escolhido, sticky ou reclassificado) — auditável na UI do router e insumo do painel.
- **UI** `app/app/ai/routers`: CRUD do router, seleção de canal, membros com intenção/descrição/exemplos, fallback, teste de classificação ("cole uma mensagem, veja pra quem iria").
- **Critério de aceite**: duas intenções distintas no mesmo canal roteando para agents diferentes, provado na tela com o log de decisão visível; conversa em andamento não troca de agent sem mudança real de assunto.

## Fase 4 — Painel de Evolução

> **CONCLUÍDA em 2026-07-27** (plano `docs/superpowers/plans/2026-07-27-harness-fase4-painel-evolucao.md`, 7 tasks). Entregue: `knowledge_searches` (migration 0086) + telemetria no `searchKnowledge`, a ponte do funil deixando de ser stub, o agregador puro `lib/ai/evolution/aggregate.ts`, a rota `GET /api/v1/ai/evolution` e a tela `app/app/ai/evolution`.
>
> **Três itens desta seção ficaram DE FORA, por decisão registrada** (não por esquecimento):
> - **vereditos do juiz ao longo do tempo** — o veredito é sobre dataset de avaliação, não sobre conversa real do tenant; ao lado de "negócios ganhos" ele se leria como resultado de negócio;
> - **comparativo antes/depois automático** — a linha do tempo marca as datas e o dono compara nos gráficos; um "melhorou 12%" sobre trinta conversas seria número que mente com aparência de rigor;
> - **follow-ups executados** — `followup_enrollment_events` não tem evento de execução legível, e a própria seção proíbe coletor novo.
>
> Detalhe do que foi provado (e por qual caminho) no `HANDOFF-harness-evolution.md`.

Leitura dos artefatos depositados pelas fases anteriores — nenhum sistema novo de coleta além do que já foi instrumentado:

- **Linha do tempo de aprendizado**: entradas de memória criadas/aprovadas (Fase 1), propostas do flywheel aplicadas (existente), skills instaladas/atualizadas (Fase 2).
- **Atividade**: ativações de skill por período, decisões de roteamento por intenção, buscas de conhecimento, follow-ups executados.
- **Qualidade e resultado**: vereditos do juiz ao longo do tempo (`flywheel_judge_verdicts`), taxa de handoff, funil `lead_state` (won/lost), custo por conversa (`llm_calls`/`metrics`).
- **UI** `app/app/ai/evolution` (ou aba "Evolução" dentro do agent): cards de resumo + linha do tempo + gráficos de tendência. Comparativos antes/depois ancorados nas datas de aplicação de propostas/memórias.
- **Critério de aceite**: um tenant consegue responder na tela, sem ajuda, "o que meu agente aprendeu este mês e o que melhorou?".

---

## Transversais (valem para toda fase)

- **Migrations**: arquivo versionado em `supabase/migrations/` + apêndice idempotente no `baseline.sql` + linha no MANIFEST (doutrina do repo). Nunca schema sem migration.
- **Multi-tenancy**: `organization_id` + RLS em toda tabela nova; teste de isolamento no CI.
- **Teste imediato por peça (protocolo obrigatório do épico)**: nada de testar só no fim da fase. Cada peça de frontend é testada em Playwright no ato — clicando os botões reais — e avaliada também na EXPERIÊNCIA (está completa? está clara? o usuário leigo entende o que é?); qualquer "não" gera correção imediata antes de avançar. Cada peça de backend é testada funcionalmente no ato; quebrou, arruma na hora. Peças front+back são testadas integradas no mesmo esquema.
- **Handoff doc vivo**: `HANDOFF-harness-evolution.md` na raiz, alimentado constantemente — progressos, testes rodados, bugs achados e corrigidos, o que ficou pra trás, o que foi acrescentado, estado atual do desenvolvimento. Lido no início de toda sessão.
- **Prova visível**: cada fase fecha com demonstração real na tela (protocolo do repo), não só testes.
- **Zod** em todo input externo (upload de skill, config de router, edição de memória). Audit log em toda mutação.
- **Fora de escopo deste épico**: scripts executáveis em skills (precisa de sandbox), roteamento entre canais distintos no mesmo router (1 router = 1 channel_session na v1), feedback CSAT do cliente final (o painel v1 usa sinais já existentes).
