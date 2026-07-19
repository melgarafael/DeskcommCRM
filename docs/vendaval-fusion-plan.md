# Fusão Vendaval → DeskcommCRM — briefing de execução (Terminal B)

> Escrito pelo Maestro (grounded no código real dos dois repos, 2026-07-17). Terminal B executa;
> o Maestro monitora e COBRA prova real a cada etapa.

## 0. A regra que vale mais que tudo (leia 3x)

O projeto anterior (Vendaval, `~/vendaval`) falhou por UM motivo: tudo foi validado contra testes,
mocks e dados de replay — **nada contra a realidade**. Testes verdes deram falsa confiança e um
canvas oco passou por "pronto". **NÃO REPITA ISSO.**

**Diretriz-mãe (inegociável) a cada avanço:**
1. **Prova de realidade, não de teste.** Toda etapa termina com evidência OBSERVADA da perspectiva
   de um USUÁRIO: uma tela real via **Playwright** contra o app rodando, uma query real via **MCP do
   Supabase** contra dados reais, uma mensagem de WhatsApp REAL fluindo. Teste unitário que só prova
   a si mesmo NÃO conta como progresso.
2. **Zero ficção.** Nada de "deve funcionar", nada de mock que finge passar, nada de avanço no papel.
   Se não rodou de verdade e você não VIU funcionar, não avançou.
3. **Conserto certo, não remendo.** Quebrou? Ache a causa raiz e conserte. Nada de silenciar erro.
4. **Progresso visível, tangível, palpável.** Ao fim de CADA fase, o Maestro (e o dono) têm que
   conseguir VER a coisa funcionando — não ler um relatório de que funciona.

## 1. Objetivo

**Um repositório só: o DeskcommCRM.** Fusão total do back-end do Vendaval (bom, mas nunca ligado à
realidade) dentro do DeskcommCRM (Next.js + TS + Supabase + WAHA + AI SDK — CRM real com chat ao vivo,
pipelines, multi-atendimento, WhatsApp e um agente de IA simples). Alvo final: **CRM open-source que a
comunidade roda numa VPS** (docker-compose). O canvas do Vendaval é JOGADO FORA.

## 2. Por que é viável (mesma stack, encaixes já existem)

Os dois são TypeScript + Postgres + WAHA + AI SDK Anthropic. O Vendaval JÁ foi arquitetado com o
DeskcommCRM como borda — o contrato exato está em `~/vendaval/docs/specs/edge-contract.md` (referencia
arquivos e linhas reais do Deskcomm). Como agora é UM repo, a maquinaria de "dois sistemas" colapsa em
chamadas internas.

**Encaixes verificados no código real do Deskcomm:**
- Envio: `app/api/v1/messages/_handler.ts` → `sendMessageHandler(supabase, ctx, input)` já insere a
  mensagem, envia pelo WAHA, atualiza status/conversa, emite `emit_event` + audit. `ctx.actor` pode ser
  `{type:'ai_agent'}`. **O cérebro do Vendaval CHAMA essa função direto** (os guardrails/anti-ban rodam ANTES).
- Entrada: WAHA → `event_log` (RPC `emit_event`). O Deskcomm tem um dispatcher nativo (`dispatchAgents`).
- Agente atual (a ser substituído): `lib/ai/runtime/agent.ts` (609 linhas) + `lib/ai/runtime/tools.ts`.
- MCP / ferramentas / contexto: `lib/mcp/server.ts` (é aqui que entra a tool `crm_reactivate_bot` que faltava).
- UI de config do agente (SUBSTITUI o canvas): `app/app/ai/agents/[id]/page.tsx` + `_actions.ts`.
- Deploy: já tem `Dockerfile` + `docker-compose.prod.yml` → adicionar um serviço `worker`.
- Cérebro a portar (de `~/vendaval/daemon/src/`): `agent/*` (inbound-turn, followup-turn, human-handoff),
  `guardrails/*`, `pacing/*` (anti-ban), `edge/llm/run-model-call.ts`, memória/RAG, playbook, `flywheel/`,
  eval (`~/vendaval/eval/`), otimizador (`~/vendaval/optimizer/` — GEPA).

## 3. Arquitetura-alvo

`docker-compose`: **`web`** (Next.js: CRM + chat + UI de agente) · **`worker`** (novo: o cérebro 24/7 do
Vendaval — fila, cron/follow-up, watchdog, turnos, flywheel) · **`postgres`** · **`waha`**. Um host, `docker compose up`.
- Modelo de dados do Deskcomm é o CANÔNICO: `organizations`/`contacts`/`conversations`/`messages`/
  `channel_sessions`. As tabelas do harness (lead_state, memória, guardrails, traces, flywheel) viram
  migrations no MESMO Supabase, chaveadas nesses IDs. `orgs`/`leads` do Vendaval SOMEM.
- O `worker` chama `sendMessageHandler` direto; o `dispatchAgents` roteia pro cérebro rico.

## 4. Fases — cada uma termina em prova de realidade

**Fase 0 — fusão física (mecânica).** Módulos TS do Vendaval no repo (`lib/agent-engine/`), migrations do
harness no Supabase, serviço `worker` no compose, canvas removido. *Prova:* `docker compose up` sobe web+worker+db+waha;
o worker conecta no Supabase e loga "pronto" (mostrar via Playwright a home do app no ar + MCP Supabase listando as tabelas novas).

**Fase 1 — UM TURNO REAL ponta a ponta (a prova que nunca aconteceu).** WhatsApp real chega → worker pega →
turno do agente rico com os guardrails CORE (opt-out, disclosure, promessa, ritmo anti-ban) → `sendMessageHandler`
→ resposta aparece no CHAT do Deskcomm. *Prova:* você manda um WhatsApp de verdade a um número conectado e VÊ o
agente responder no chat (Playwright abrindo a conversa + MCP Supabase mostrando a mensagem outbound com `sent_via='ai'`).
Sem isso funcionando de verdade, NADA avança.

**Fase 2 — continuidade + config real.** Memória/RAG/follow-up no turno (usando histórico real do Deskcomm) +
os knobs reais (prompt/playbook, modelo, guardrails, fontes) na tela `app/app/ai/agents/[id]`. *Prova:* Playwright
configurando um agente de verdade e o comportamento MUDANDO numa conversa real.

**Fase 3 — observabilidade + flywheel vivo.** Telas de traces/métricas como rotas Next.js sobre o banco; o
flywheel roda sobre TRACES REAIS (loop vivo, não replay). *Prova:* um trace real de uma conversa real aparecendo na tela.

**Fase 4 — hardening VPS/open-source.** compose final, `.env.example`, docs de instalação, backup. *Prova:*
subir do zero numa VPS limpa seguindo só o README e ter um agente respondendo.

## 5. Como reportar ao Maestro

A cada etapa concluída: `lina ask "@Maestro" "<fase/etapa>: <o que está funcionando DE VERDADE> — evidência: <o que rodou/vi>" --intent status`.
Travou? `lina ask "@Maestro" "travado em <X>: <causa raiz> — preciso de <Y>" --intent status`. Nunca reporte "pronto"
sem evidência observada. O Maestro vai te checar com `lina check` e pedir a prova real.

## 6. Doutrinas a respeitar
- Do Deskcomm: siga o `CLAUDE.md`/`AGENTS.md`/MANIFEST do repo (migrations, RLS, LGPD nativa, multi-tenant).
- Do Vendaval (que continuam valendo na fusão): org/tenant de fonte confiável nunca do body; opt-out/is_blocked
  irrevogáveis; anti-ban antes de qualquer envio; credenciais server-side; PII fora de log; toda mudança de schema = migration idempotente.
