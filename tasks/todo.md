# SonghaiCRM — Workflow de Construção

Ordem definida pelo Rafael: **PRD → Regras de Negócio → Specs → Epics → Stories → Plano com Tasks**.

---

## Fase 0 — Brainstorming (em andamento)

- [x] Entender demanda e confirmar com o usuário
- [x] Decidir tenancy model (multi-tenant clássico desde dia 1)
- [x] Decidir escopo MVP (Opção B — com IA core)
- [x] Decidir integração e-commerce (Nuvemshop only)
- [x] Decidir perfil do primeiro tenant (PME médio)
- [x] Ler material de referência da Aula CRM Nichado WAHA
- [x] Decidir adoção da arquitetura de referência (integral, opção A)
- [x] Criar skeleton de docs do projeto
- [x] Preservar síntese da referência em `docs/research/`

## Fase 1 — PRD-Mestre + sub-PRDs

- [x] Escrever PRD-Mestre (`docs/prd/00-prd-master.md`) — visão, problema, escopo, stakeholders, métricas, restrições — **v0.1 escrito, em revisão pelo Rafael**
- [x] Sub-PRD 01: Plataforma Base (auth, multi-tenant, RBAC, audit, LGPD framework) — **v0.1 escrito**
- [x] Sub-PRD 02: Customer 360° + Identity Resolution determinística — **v0.1 escrito**
- [x] Sub-PRD 03: Canal WhatsApp (WAHA + anti-banimento + janela 24h + multi-atendente) — **v0.1 escrito**
- [x] Sub-PRD 04: Pipeline Kanban + Atendimento + Tickets + Handoff — **v0.1 escrito**
- [x] Sub-PRD 05: IA Conversacional (chatbot + RAG por tenant + sentiment detection) — **v0.1 escrito**
- [x] Sub-PRD 06: Integração Nuvemshop + LGPD webhooks — **v0.1 escrito**
- [x] Revisão final do PRD-Mestre + sub-PRDs — **spot-check de consistência cross-doc passou**

## Fase 2 — Regras de Negócio

- [x] Regras de tenancy e isolamento (T-01 a T-08) — em `docs/business-rules/00-business-rules-catalog.md`
- [x] Regras LGPD (L-01 a L-10) — idem
- [x] Regras WhatsApp (W-01 a W-12) — idem
- [x] Regras de pipeline (P-01 a P-08) — idem
- [x] Regras de atendimento (AT-01 a AT-08) — idem
- [x] Regras de IA (IA-01 a IA-11) — idem
- [x] Regras de billing/uso (B-01 a B-05) — idem

## Fase 3 — Specs Técnicas — **COMPLETA (8 specs, ~60k palavras)**

- [x] Spec 01 Plataforma Base (auth, RLS templates, audit, LGPD framework, API conventions)
- [x] Spec 02 Customer 360 + Identity Resolution
- [x] Spec 03 WhatsApp via WAHA Plus
- [x] Spec 04 Pipeline Kanban + Atendimento (UI 3 colunas)
- [x] Spec 05 IA + RAG + Sentiment + Handoff
- [x] Spec 06 Nuvemshop + LGPD
- [x] Spec 07 Event Log + Workers + Crons (transversal)
- [x] Spec 08 Deploy + Observability (transversal)
- [x] 15 diagramas Mermaid em `docs/research/architecture-diagrams.md`

## Fase 3.5 — Design System + Screen Flow (extra) — **COMPLETA**

- [x] Showcase navegável `/design` com 5 paletas + 4 tipografias + 3 densidades + componentes + motion
- [x] Direção locked: **Sage + Atkinson Hyperlegible + Aerada + Phosphor**
- [x] Tokens materializados em `tailwind.config.ts` + `app/globals.css` + `app/layout.tsx`
- [x] `<ThemeProvider>` com light/dark/system + persistência localStorage
- [x] shadcn components reescritos pra Sage (button/card/input/textarea/badge)
- [x] Documentação em `docs/design-system/` (11 arquivos, ~10.4k palavras)
- [x] Screen flow em `docs/design-system/screen-flow/` (9 arquivos, ~13.8k palavras)
- [x] 94 telas inventariadas + 5 jornadas + 8 clickflows + 9 state machines

## Fase 4 — Epics

- [ ] Epic E1: Plataforma Base
- [ ] Epic E2: Conexão WhatsApp + Inbox Live
- [ ] Epic E3: Customer 360° + Identity Resolution
- [ ] Epic E4: Pipeline Kanban + Atendimento Humano
- [ ] Epic E5: IA Conversacional + Handoff
- [ ] ~~Epic E6: Integração Nuvemshop + LGPD~~ — obsoleto (Nuvemshop descontinuado, 2026-09-04)
- [ ] Epic E7: Hardening + Observability + Deploy

## Fase 5 — Stories

- [ ] Detalhar stories de cada epic com ACs
- [ ] Estimativas relativas (T-shirt sizing)
- [ ] Priorizar por Now/Next/Later

## Fase 6 — Plano de Tasks

- [ ] Quebrar stories em tasks técnicas
- [ ] Sequenciar com dependências explícitas
- [ ] Cronograma e marcos
