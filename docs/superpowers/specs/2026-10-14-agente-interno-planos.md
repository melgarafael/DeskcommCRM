# Planos por fatia — agente interno de configuração

- Spec: `docs/superpowers/specs/2026-10-14-agente-interno-config-design.md` (§9 = impacto medido)
- Classificação (quem-sou.sh, 2026-10-14): **contribuidor** — `paulolimajr77`, origin = produto. Hooks armados (`core.hooksPath`, pre-commit cobra tripla de migration, pre-push recusa push na main).
- Âncora medida na abertura: `atraso=0 proprios=0` — cada fatia nasce de `origin/main` **na hora de codar** (`git fetch origin`, re-medir atraso/sobreposição; `merge`, nunca reset/force).
- Issue: comentar "pego esta" na **#1941** antes da F1 (sem resposta em 48h, começar e dizer no PR).
- Regra geral (contribuir P4–P6): pré-voo antes do PR; gates `typecheck, lint, lint:channels, test:unit (inteiro, sem tail), test:db (schema/RLS), test:shell (só se tocar kit), build`; sabotagem commitada com "1 vermelho de N, o previsto" no corpo; prova em par (chat × ferramenta direta, mesmo texto cru) + tela em banco fresco do baseline; spec e2e nova em `SPECS_PARTE_1..6` (ou `FORA_DO_CI` com motivo) — `e2e-cobertura-completa` reprova órfã; fragmento `.changes/` com `impacto` + `secao` + `titulo` + corpo (`capacidade_nova`); corpo do PR com "O que NÃO medi"; identidade sem `root@`.

## F1 — chat de leitura (branch `feat/assistente-f1-chat-leitura`)

**Entrega:** tabelas `config_threads`/`config_messages` (migration **0655**, prefixo > `20261014000001`, `-- manifest:`, apêndice baseline), `POST/GET /api/v1/ai/assistente/chat` (sessão cookie, `requireRole("agent")`, Zod, `ok()/fail()`, tetos próprios usuário/org/dia a implementar — sem Bearer, sem entrada em `public-paths`), tela `app/app/assistente/page.tsx` (chat read-only: métricas via rotas §4 + dúvidas via skills portadas para `skill_versions` ≤200 linhas), porta `NAV_CATALOG` (grupo "Assistente" **a criar** — `NAV_GROUPS` só tem 6; `sidebar: true` tensiona a regra da dobra, ver `catalogo.ts:456-460` + `navegacao.spec.ts`, medir na F1) + botão no `TopBar.tsx` junto ao `UserMenu` (portal — backdrop-blur corta dropdown; ver `AvisoDePropostaEmDestaque.test.tsx`), `database.types.ts` regenerado, i18n PT/ES, `.changes/assistente-chat-leitura.md` (com `secao` + `titulo` + corpo).
**Testes novos:** RLS `config_*` (isolamento + completude), chat sem sessão → 401, PII nunca em payload de tool (varredura como `branding`), `telas-filtram-a-organizacao-ativa` cobre a tela.
**Sabotagem prevista:** remover filtro de org da rota → RLS/isolation fica vermelho; publicar proposta inexistente → n/a (F1 não escreve negócio).
**E2E nova:** `assistente-chat-leitura.spec.ts` (pergunta de relatório no chat = número da tela; par chat × GET direto) + prova visual em VPS fresca.
**Docs no PR:** `architecture/*.json` (+2 arestas), `current-state`, `user-journey-map` (navegação), `threat-model` (superfície sessão-only), `spec-12` (segunda porta). DoD 14 (porta, `CLAUDE.md:730`), 13 (checklist, `:729`), 12 (par/QA, `:728`), 4 (RLS, `:720`), 5 (audit, `:721`), 7 (Zod, `:723`).

## F2 — propostas com aprovação (branch `feat/assistente-f2-propostas`)

**Entrega:** migration (próximo NNNN livre na hora — re-medir + `checar:colisao-de-migration`) criando `config_proposals` (5 estados: `pendente/aprovada/aplicada/rejeitada/expirada`), tetos próprios usuário/org/dia no chat (molde: chat de casos; a F1 nasceu sem trava por decisão registrada na spec §8.2), `lib/agent-engine/agent/config-turn.ts` (`CONFIG_TOOL_DEFS` leitura+propose, sem `send_message`, client de sessão — service role proibido no turno), rotas `propostas` + `[id]/{approve,apply,reject}` (pedir/aprovar/aplicar **só admin** + `requireSupportWrite` + `audit()`; aplicar exige `aprovada`), execução 1 proposta = 1 artefato via handlers existentes (agents draft→publish, from-model→publish, routers PUT, knowledge/memory/credentials, settings actions), skills de escrita portadas, `.changes/assistente-propostas.md`.
**Testes novos:** aplicar `pendente` → 403 + vermelho (sabotagem: remover guard → teste cai); cross-tenant em proposals; não-admin pedindo escrita → 403; crítico (credencial/canal/exclusão) sem tool (propor retorna recusa tipada).
**Sabotagem prevista:** trocar `aprovada` por `pendente` no guard do apply → "1 vermelho de 1, o previsto".
**E2E nova:** `assistente-proposta-aprovar.spec.ts` (pedir agente da clínica → aprovar → rascunho existe, nada publicado; par chat × POST direto no handler).
**Docs no PR:** `spec-16` (4º papel), `spec-11` (8 tools fora do catálogo), `spec-12`, mapa (arestas do turno), `threat-model`, `business-rules` (audit do turno), `docs/doctrine/operacao-de-agentes.md`. DoD 4/5/7 + 12 (par) — refs acima.

## F3 — auditoria do tenant (branch `feat/assistente-f3-auditoria`)

**Entrega:** migration `config_snapshots` (`organization_id`, `taken_at`, `resultado jsonb`, `pendencias`), rota de auditoria (calcula PREENCHIDO/POSSO COMPLETAR/PRECISO CONFIRMAR/NÃO SE APLICA + dependências, grava snapshot, mostra evolução), retenção = a do tenant (decisão registrada), bloco na tela do assistente, `.changes/assistente-auditoria.md`.
**Testes novos:** snapshot de outra org invisível (RLS); retenção/expurgo cobre snapshots (`retencao-das-tabelas-da-ia`); `audit-resource-id-e-uuid` no novo action.
**Sabotagem prevista:** snapshot sem `organization_id` → isolation vermelho.
**E2E nova:** `assistente-auditoria.spec.ts` (rodar 2× após completar item → evolução "5→4"; par auditoria × leitura direta das tabelas).
**Docs no PR:** `current-state`, `user-journey-map` (J1 pós-onboarding), `business-rules` (retenção). DoD 4/12.

## F4 — laço de retorno (branch `feat/assistente-f4-evolucao`)

**Entrega:** só edição — `app/api/v1/ai/evolution/route.ts` + `lib/ai/evolution/aggregate.ts` (nova fonte `config_*`: aprovação/aplicação/arrependimento por kind) + bloco em `app/app/ai/evolution/page.tsx`; matcher das skills consome o sinal. Leitura **só** via `aggregate` (`telemetria-tem-um-leitor-so`).
**Testes novos:** agregação pura com `config_*` fixture; `uso-de-ia-tela-honesta`/`usage-nao-conta-em-dobro` continuam verdes.
**Sabotagem prevista:** ler `config_proposals` direto na rota (fora do aggregate) → `telemetria-tem-um-leitor-so` vermelho.
**E2E:** estender spec da F2 (rejeitar proposta → evolution mostra o sinal; par).
**Docs no PR:** `spec` de evolution se existir + `VISION.md` **só** se declarar o loop de config como flywheel; caso contrário, só `current-state`. Fecha o invariante 7 (§7 da spec).

## Ordem e dependências

F1 → F2 → F3 → F4, cada uma mergeável sozinha com DoD cheia. Re-medir antes de cada uma: `MAIN/atraso/sobreposição`, próximo NNNN, `git diff` contra `origin/main`. Spec + este plano entram commitados na F1 (docs da feature viajam com a primeira fatia).
