# CRM Automações — Fluxos visuais

**Slug:** `crm-automacao-fluxos`
**Status:** Draft (aguardando aprovação)
**Data:** 2026-08-22
**Base escrita (CONFIRMADO):** `docs/superpowers/specs/2026-07-17-webhooks-design.md` (v1 aprovada e implementada), `lib/automation/engine.ts`, `app/app/webhooks/_components/RuleEditor.tsx`, follow-up em `docs/superpowers/specs/2026-07-21-followup-system-design.md`

---

## Problem Statement

A v1 de automação já roda em produção: gatilho no `event_log` → condições AND → ações em ordem (`automation_rules`). O editor é um sheet linear (QUANDO / SE / ENTÃO). Isso cobre o caso de uma regra reta. Não cobre o que o operador descreve como **fluxo**: ramificar (“se etapa X, senão Y”), ver o caminho no canvas, e distinguir isso do follow-up (cadência com relógio e IA).

O follow-up já tem grafo + enrollment + `next_eval_at`. Unificar os dois motores seria um terceiro relógio disfarçado — anti-padrão documentado no follow-up (“UM grafo, UM enrollment, UM relógio” **daquele** domínio). Esta feature **não** funde os motores.

## Goals

- [ ] Manager monta e lê uma automação como grafo no canvas, sem perder o motor `event_log` existente.
- [ ] Regra linear v1 continua válida (round-trip: sheet antigo ou grafo 1:1 ⇄ mesmas colunas).
- [ ] Ramificação determinística (condição verdadeira/falsa) executa um caminho só, com run visível na aba Atividade.
- [ ] Follow-up (`/app/ai/followups`) e automação (`/app/webhooks`) permanecem telas e motores distintos.

## Out of Scope

| Feature | Reason |
| --- | --- |
| Nós `wait` / `ai_classify` / `ai_message` | Relógio e LLM já são o motor de follow-up. Aqui o tick é o evento. |
| Sub-fluxos, A/B split | Fora do follow-up MVP; não entra aqui. |
| Formulário hospedado embedável | Fora da v1 de webhooks; continua fora. |
| Round-robin de `assign_owner` | Explicitamente v2 do design 2026-07-17; outra feature. |
| Novos tipos de gatilho além dos 5 atuais | Schema/API já fixam `TRIGGER_EVENTS`; expandir é feature à parte. |
| Fila outbound dedicada / retry configurável | Fora da v1. |
| Reescrever `automation_rules` como `followup_flow_pointers` | Dois relógios; não misturar. |
| Marca “escreve.ai” na UI | Doutrina white-label. |

---

## User Stories

### P1: Canvas 1:1 da regra linear ⭐ MVP

**User Story:** As a manager, I want to ver e editar a automação como um fluxo (gatilho → filtros → ações em série → fim) so that o caminho cabe numa tela e não num sheet empilhado.

**Why P1:** Vertical slice: UI nova, mesmo contrato de dados. Motor, RLS, throttle e ações **não mudam**. Demo sem migration.

**Acceptance Criteria:**

1. WHEN o manager abre `/app/webhooks` na aba Automações e clica em criar/editar THEN o sistema SHALL abrir um canvas (React Flow, mesmo padrão visual Sage do builder de follow-up) com nós `trigger`, zero ou mais `condition` em série (AND), um ou mais `action` em série, e `end`.
2. WHEN o manager salva um grafo 1:1 (sem ramificação) THEN o sistema SHALL persistir nas colunas existentes `trigger_event`, `conditions`, `actions` (compile/decompile) e SHALL recusar grafo que não compile (422 com erros ancorados no nó).
3. WHEN uma regra criada pelo sheet linear antigo é reaberta THEN o sistema SHALL desenhar o grafo equivalente sem perda de campos.
4. WHEN o manager ativa a regra THEN o motor existente SHALL executar como hoje (mesmos runs em Atividade).
5. WHEN o role é `agent` THEN o sistema SHALL continuar escondendo a seção (RBAC atual, manager+).

**Independent Test:** Criar fluxo “lead.created → add_tag”, ligar, POST na fonte de captação, drenar `event_log`, ver run verde e tag no lead. Screenshot do canvas + Atividade.

---

### P2: Ramificação determinística

**User Story:** As a manager, I want a condition node with two exits (sim/não) so that a regra não precisa ser duplicada para o caso contrário.

**Why P2:** Primeiro comportamento que o modelo linear **não** expressa. Exige `graph` persistido.

**Acceptance Criteria:**

1. WHEN o grafo tem um nó `condition` com arestas `cond_result: true` e `false` THEN no evento o motor SHALL avaliar as checks (mesmo avaliador `evaluateConditions`) e SHALL seguir só a aresta correspondente.
2. WHEN um caminho não tem aresta para o resultado THEN o sistema SHALL falhar o run (`failed`, erro explícito no nó) e SHALL **não** executar ações do outro ramo.
3. WHEN a regra ramificada é salva THEN `is_active` nasce/permanece pausada até o manager ligar (comportamento v1).
4. WHEN o grafo ramificado é publicado/salvo THEN o validador SHALL exigir: 1 trigger alcançável, todo caminho termina em `end`, sem ciclo, nós `action` só com tipos já registrados.
5. WHEN o evento carrega `metadata.caused_by_rule` THEN o motor SHALL continuar pulando (anti-loop profundidade 1 — **CONFIRMADO** v1; cadeia regra→regra continua fora).

**Independent Test:** Regra `lead.stage_changed`: se etapa destino = X então tag A, senão tag B. Mover lead para X e para Y; dois runs, tags distintas. Sem a tag do outro ramo.

---

### P3: Linguagem do canvas e empty state

**User Story:** As a manager, I want rótulos em português de operação (não `trigger_event`) so that a tela não fala jargão de webhook.

**Why P3:** Já é lei na wave W4 (`aviso automático`, `funil`, `etapa`, `marcador`). O canvas novo não pode reintroduzir inglês de API.

**Acceptance Criteria:**

1. WHEN a paleta lista nós THEN labels SHALL usar o vocabulário já em `labels.ts` / doutrina leigo-friendly.
2. WHEN a lista de automações está vazia THEN o empty state SHALL explicar o primeiro fluxo em linguagem de operação, sem pedir n8n.

**Independent Test:** Gate existente de jargão (`catalogo-tools-leigo-friendly` e/ou grep de UI) não acusa as strings novas da paleta.

---

## Edge Cases

- WHEN o grafo tem ação `send_whatsapp_message` fora da janela 7h–22h THEN o sistema SHALL adiar o **evento** (`postponeUntil` já existente), não o nó — all-or-nothing do v1.
- WHEN contato `is_blocked` THEN `send_whatsapp_message` SHALL skip com motivo no run (já existe).
- WHEN ação desconhecida no grafo THEN compile/publish SHALL 422; run SHALL não começar.
- WHEN duas regras ativas batem no mesmo evento THEN ambas SHALL rodar (comportamento v1: N regras por trigger).
- WHEN compile de grafo ramificado para colunas lineares é impossível THEN o sistema SHALL persistir `graph` e SHALL **não** apagar `actions` até o motor ramificado estar no ar (ver design: coluna nova só em P2).
- WHEN tenant B lista regras THEN 0 linhas do tenant A (RLS existente).

---

## Requirement Traceability

| Requirement ID | Story | Phase | Status |
| --- | --- | --- | --- |
| AUTOFLUXO-01 | P1: canvas 1:1 | Tasks | In Tasks |
| AUTOFLUXO-02 | P1: compile ⇄ colunas v1 | Tasks | In Tasks |
| AUTOFLUXO-03 | P1: round-trip regra antiga | Tasks | In Tasks |
| AUTOFLUXO-04 | P1: motor inalterado no linear | Tasks | In Tasks |
| AUTOFLUXO-05 | P1: RBAC manager+ | Tasks | In Tasks |
| AUTOFLUXO-06 | P2: arestas true/false | Tasks | In Tasks |
| AUTOFLUXO-07 | P2: fail-closed sem aresta | Tasks | In Tasks |
| AUTOFLUXO-08 | P2: regra nasce/fica pausada | Tasks | In Tasks |
| AUTOFLUXO-09 | P2: validador de grafo | Tasks | In Tasks |
| AUTOFLUXO-10 | P2: anti-loop profundidade 1 | Tasks | In Tasks |
| AUTOFLUXO-11 | P3: vocabulário PT | Tasks | In Tasks |
| AUTOFLUXO-12 | P3: empty state | Tasks | In Tasks |

**Coverage:** 12 total, 12 mapped to tasks.

---

## Success Criteria

- [ ] Demo P1: canvas → save → drain → Atividade, sem migration.
- [ ] Demo P2: um evento, um ramo, run com ações só daquele ramo.
- [ ] `pnpm typecheck` / `lint` / testes unitários do compile+validador+motor ramificado verdes.
- [ ] P2: `pnpm test:db` se houver coluna/`baseline`; E2E Playwright com evidência visual do canvas.
- [ ] Zero menção de marca própria no DOM novo.

## Notas CONFIRMED vs INFERRED

- **CONFIRMADO:** 5 gatilhos, 5 ações, AND nas conditions, anti-loop depth 1, regra pausada no create, UI em `/app/webhooks`, follow-up é outro produto.
- **INFERIDO (produto):** que “fluxos” significa canvas + ramificação sobre o motor de regras, não um segundo follow-up. Se a intenção era só o canvas 1:1, P2 sai do MVP.
