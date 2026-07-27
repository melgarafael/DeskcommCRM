# HANDOFF — Casos Humanos

> **LEIA no início de cada avanço. ALIMENTE ao fim de cada wave** com: progresso, testes rodados+resultado, bugs achados/corrigidos, o que ficou pra trás, o que foi acrescentado, estado atual. Zero progresso invisível.
> Cadência (spec §11.4): back = teste rodado; front = **Playwright clicando de verdade + avaliação de UX/clareza**; front+back = integrado. Quebrou → arruma antes de avançar. Prova de agente/mensageria SÓ em conta/conversa REAL.

- **Spec:** `docs/specs/15-spec-casos-humanos.md`
- **Plano:** `docs/superpowers/plans/2026-07-23-casos-humanos.md`
- **Ledger SDD:** `.superpowers/sdd/progress.md` (seção "CASOS HUMANOS")
- **Execução:** subagent-driven (implementer fresco/task + task review + review final)

## Estado atual
**Waves 1-6 completas e revisadas. Wave 7 (prova E2E) PARCIAL** — interrompida por limite SEMANAL de API (reseta 25/jul 02h). Código todo verde: `test:unit` 533/533, `test:db` 236, typecheck/lint 0.

### O que a prova E2E mostrou (docs/evidence/casos-humanos/, 7 telas, cenário real "assinatura inativa após pagamento", agente anthropic real)
- **PROVADO na tela:** abertura do caso pela IA (summary/blocker escritos pelo agente) · lista com "Aguardando você" · detalhe com blocos rotulados · ação "Preciso de info do cliente" → badge vira "Aguardando o cliente" + painel desabilitado com a razão certa · conclusão → aba "Abertos (0)" + estado vazio. **UX aprovada por mim**: clara, ensina, de-quem-é-a-bola óbvio, 3 ações inequívocas, zero enum cru. O fix do W6 (sem pré-seleção) confirmado ao vivo.
- **NÃO provado ao vivo (re-provar após reset):** etapa C — lead responde → IA chama `provide_case_update` sozinha. No teste, o modelo respondeu ao cliente mas não chamou a tool (faltava o `case_id` no contexto). **Corrigido em código** (`getCaseAwaitingLead`, commit f111c58) mas o re-teste caiu no limite; a prova seguiu com a transição aplicada à mão (documentado honestamente na timeline do caso).
- **NÃO provado:** envio outbound REAL ao lead (WAHA) em cada etapa; escalação ponta-a-ponta (E). Faltou re-rodar.

**5 bugs reais achados e corrigidos** (nenhum apareceria em typecheck/teste com mock — todos de INTERAÇÃO entre waves):
1. Transição de caso + efeito não atômicos → caso travado sem recuperação (`a124444`).
2. `cases_enabled` em 2 de 7 cópias de `VERSION_COLUMNS` → toggle se desmarcava e revertia no save (`e698c72` + teste anti-divergência).
3. "Concluí" pré-selecionado → atendente fechava caso sem querer (`8b1a906`).
4. case-reply-turn descartava a conclusão (checava "aberto", mas W5 já transicionou) → IA nunca repassava ao lead (`f111c58`).
5. provide_case_update inalcançável no caminho comum (modelo sem case_id quando o lead responde) (`f111c58`).

### PROVA VIVA COMPLETA do bug#4 (24/jul, após Rafael adicionar crédito Anthropic)
Worker de casos (worktree, código f111c58) isolado como único consumidor (o worker do feat/operacao-visivel foi pausado com autorização e RESTAURADO ao fim). Re-enfileirei `case_reply_turn(resolved)` p/ o caso resolved `be89f3cf` (conversa WhatsApp REAL, sessão E2E Wave12) e o turno rodou INTEIRO: config publicada → tools montadas → `llm: chamada concluída` → cadeia `before_send` (incl. casePromiseGate) → **mensagem OUTBOUND enviada ao lead**, status `sent`, external_id REAL `3EB07D762269E6C12BEDDA`:
> "Carlos, boa notícia! 🎉 O time financeiro localizou o seu pagamento e reativou a assinatura — o acesso já está liberado! Pode entrar no portal agora e confirmar se está tudo certo?"
Job `done`, zero erro. **A nota interna do humano virou mensagem pro cliente e FOI ENVIADA.** Com o código velho, o handler daria no-op (bug#4) e nada sairia — Carlos nunca saberia. Bug#4 provado ponta-a-ponta no sistema real.

### (histórico) 1ª tentativa da re-run — bug#4 provado no nível de handler, resto bloqueado por crédito
- Worker reiniciado com o código f111c58 (o que estava vivo era de 23/jul, pré-fix, no-watch).
- **PROVA VIVA do bug#4:** re-enfileirei `case_reply_turn(resolved)` p/ o caso resolved `be89f3cf` e o worker NOVO deu **0 no-op / 5 linhas chegando à API** → o handler prosseguiu até `runAgentTurn` num caso resolved (o velho daria no-op antes do LLM). Integração real (worker+banco).
- **BLOQUEIO (precisa do Rafael):** credencial Anthropic da org e2e SEM CRÉDITO ("credit balance is too low") → nenhum turno de modelo completa. Etapas C (lead→provide_case_update) e D/E (outbound real) não proveis ao vivo até haver crédito OU trocar p/ credencial financiada (a de OpenAI gpt-4o já foi validada em ondas anteriores).
- Wart pré-existente do ambiente E2E: `ephemeral_token_insert_failed` (duplicate api_tokens prefix) impede as tools MCP DA TELA de montar — não afeta as tools nativas de caso (open/provide/send).
- bug#2 (toggle) segue travado pelo teste de drift; prova viva no navegador ficou bloqueada (form de agente read-only p/ manager; :3000 é build velho, :3010 é dev com o toggle presente porém desabilitado).

### PROVA VIVA da etapa C / bug#5 (24/jul) — FEITA
Montei um caso NOVO `ef1aaf1c` em awaiting_lead (pedido do humano: "confirme o CPF do titular") + inseri a mensagem inbound do cliente respondendo o CPF, e enfileirei um inbound_turn REAL. Achado que virou aprendizado: na 1ª tentativa o caso NÃO transicionou — porque a Lia (agente publicado da conversa) estava com `cases_enabled=false`, então `provide_case_update` e o bloco getCaseAwaitingLead corretamente NÃO montam (o gating funcionando, não é bug). Liguei `cases_enabled=true` na versão publicada e re-disparei:
- Caso `awaiting_lead` → **`awaiting_human`**; novo evento `lead_provided` (actor=lead): "Cliente informou que o CPF do titular é 312.456.789-09...". Job inbound_turn `done`.
- Ou seja: o modelo viu o bloco getCaseAwaitingLead (case_id + o ask), viu a resposta do cliente e **chamou provide_case_update sozinho** — o exato fix do bug#5. Sem ele (case_id ausente do contexto), o modelo não teria como.

**LOOP A→B→C→D PROVADO AO VIVO com o código corrigido.** (D/conclusão→outbound real = bug#4 acima; C/lead→provide_case_update = aqui.) Restaurei tudo: cases_enabled da Lia de volta p/ false, worker do feat/operacao-visivel de volta, worker de casos parado. Artefatos de teste deixados no DB dev (casos be89f3cf/ef1aaf1c) como evidência — inócuos na org e2e.

### Épico pronto para merge review. Nada mergeado (branch feat/inbox-multimodal).
**A INVARIANTE CENTRAL (W4) ESTÁ SEGURA** — review opus confirmou: lead nunca recebe promessa-de-humano sem caso aberto (garantia estrutural: fail-safe re-roda a cadeia inteira, zero envio fora dela).
**Nota de execução:** 2 implementers caíram por session limit (W4 1ª tentativa, W5). Ambos retomados sem perda — a W5 estava verde na árvore e foi verificada/commitada pelo controller.
**Decisão de escopo:** need_lead_info NÃO arma cron novo (agente já tem schedule_followup); lead_unresponsive→aviso fica como enhancement documentado.
Minors abertos p/ review FINAL: (a) `revoke all from anon` nas 2 tabelas (forward-fix 0067); (b) 1 skip test:db; (c) doc comment W3b; (d) detector: apertar falsos positivos ("pode te ajudar", "passar o link") — candidato W6; (e) PRÉ-EXISTENTE: doc de before-send cita before-send.test.ts inexistente (cadeia sem snapshot test).

## O que este épico entrega
Sistema de casos/tickets: a IA delega uma tarefa a um humano de retaguarda e **continua dona da conversa** com o lead (loop assíncrono IA↔humano), com garantia dura anti-alucinação (gate que impede a IA de prometer humano sem abrir caso). Novo e **paralelo** ao handoff existente.

## Waves
- [x] **W0** confirmar runtime + HANDOFF
- [x] **W1** schema (migration 0066: agent_cases + agent_case_events + cases_enabled + CHECKs case_reply_turn) — review Approved
- [x] **W2** repositório + tools de dados (open/provide) + JobKind — review Approved
- [x] **W3a** agent-config.casesEnabled + tools open/provide no turno (gated) + bloco de sistema + drop CaseIds.leadId — review Approved
- [x] **W3b** handler case_reply_turn + registro no worker — review Approved
- [x] **W4** guardrail anti-alucinação (fail-safe auto-open; cenários adversariais como asserções) — review OPUS Approved ← requisito crítico SEGURO
- [x] **W5** ativação por agente (cases_enabled) + rotas API + ponte de escalação (performHumanHandoff) — commit 86e7c20, review em curso
- [x] **W6** UI de casos (3 ações estruturadas, rótulos pt-br, timeline traduzida) — review Approved pós-fix
- [ ] **W7** prova E2E do loop completo em conta/conversa REAL + avaliação de UX na tela

## Log
- 2026-07-23 **W0**: runtime confirmado (`AGENT_DISPATCH_CONSUMER`=engine default, .env.example/.env.hostgator.example=engine; `workers/agent-worker/main.ts:188`). Spec/plano corrigidos (string `engine`, não `agent-engine`). Ambiguidades da spec resolvidas nas extrações: handoff canônico = `performHumanHandoff` (human-handoff.ts:149); guardrail = gate novo em before-send.ts; UI = polling 60s (useAgentInbox). Sem código de produção ainda.

### VALIDADO PELO RAFAEL (24/jul, teste manual na tela) — "Funcionou 100%!"
Rafael rodou o loop inteiro na mão pela UI, em caso LIMPO (fd622ad2 "Reagendar entrega da 2ª via", info nova = CEP): clicou "Preciso de info do cliente" → IA perguntou o CEP ao lead no WhatsApp → Rafael respondeu como o lead → IA chamou provide_case_update sozinha → caso voltou pra "Aguardando você" com o CEP na timeline. Loop A→B→C→D validado pelo usuário, não só por mim.
Aprendizado do teste: a 1ª tentativa dele "não atualizou" porque o caso de teste ef1aaf1c estava POLUÍDO (o CPF já estava no histórico de mensagens de uma prova minha anterior), então a IA se adiantou e chamou provide_case_update antes da confirmação do cliente. NÃO era bug — era dado de teste sujo. Caso limpo (info que a IA não sabe) resolve. Lição: ao montar prova de provide_case_update, a info pedida ao lead NÃO pode já existir no histórico da conversa.
Conflito de worker entre sessões documentado em memory reference_shared_worker_cross_session.
