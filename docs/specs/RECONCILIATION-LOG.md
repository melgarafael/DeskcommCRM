---
title: Specs Reconciliation Log
version: 1.1
status: ativo
date: 2026-04-28
owner: Songhai, Lda
---

# Specs Reconciliation Log

> Registro canônico das reconciliações entre Specs/Epics quando conflitos são detectados durante consolidation passes. Decisões aqui **sobrescrevem** texto em arquivos individuais que conflite — texto antigo permanece pra histórico mas as edições foram aplicadas in-place.

## R-01 — Nomenclatura de canal Realtime: plural

**Conflito**: Spec 04 §4.2 usava `useChannelSession` com canal nomeado `org-{orgId}-channel-session` (singular). Spec 09 §6 padronizou plural alinhado ao nome da tabela.

**Decisão canônica**: canal é `channel-sessions-{orgId}` (plural).

**Aplicação**: Spec 04 §4.2 atualizado in-place.

---

## R-02 — Error code canônico para "sem credencial válida"

**Conflito**: Spec 01 §7.5 catalogou `auth_required` (401). Specs informais usaram `unauthenticated`.

**Decisão canônica**: **`auth_required`** é o único error code aceito pra HTTP 401. `unauthenticated` é proibido como código.

**Aplicação**: Spec 01 §7.5 — nota canônica adicionada.

---

## R-03 — Error codes ausentes em Spec 01 §7.5

**Conflito**: Specs 02, 04 e 09 referenciavam codes que não estavam no catálogo canônico.

**Decisão canônica**: 6 novos error codes adicionados a Spec 01 §7.5: `conversation_already_claimed`, `pipeline_immutable_use_clone`, `lost_reason_required`, `lost_reason_invalid`, `phone_must_be_e164`, `merge_irreversible`.

**Aplicação**: Spec 01 §7.5 — tabela ampliada.

---

## R-04 — OCC com `expected_updated_at` em mutations de leads

**Conflito**: Spec 02 sugeriu OCC via `If-Unmodified-Since` ou body `expected_updated_at`. Pergunta: a coluna existe e é confiável?

**Decisão canônica**: **CONFIRMADO**. `crm_leads.updated_at` existe via migration 0003 com trigger `fn_set_updated_at`. Pode ser usada como token OCC. Em conflito, retorna 409 com error code `concurrent_update`.

**Aplicação**: sem mudança em código/spec — comportamento já correto.

---

## R-05 — `connectNuvemshop` como Server Action

**Conflito**: Spec 06 §4.2 documentou OAuth start como rota REST. Spec 09 ADR-02 prescreveu Server Actions.

**Decisão canônica**: **Server Action `connectNuvemshop()` é o caminho default da UI**. A rota REST permanece como fallback legacy.

**Aplicação**: Spec 06 §4.2 atualizado + Spec 09 §11 listou Server Actions catalog.

---

## R-06 — Ciclo de dependência EPIC-09 ↔ EPIC-10

**Conflito**: Durante o consolidation pass dos epics (2026-04-28), EPIC-09 (Team) e EPIC-10 (Audit + Settings) declararam um o outro como `depends_on`, criando ciclo:
- EPIC-09 declarava `depends_on: [EPIC-00, EPIC-01, EPIC-10]` justificando que precisava do helper `auditLog()`
- EPIC-10 declarava `depends_on: [EPIC-01, EPIC-09]` (sem justificativa estrutural — viewer de audit log não depende de Team)

**Causa raiz**: o helper `auditLog()` é um utilitário de baixo nível (INSERT em `api_audit_log`). Não é uma capacidade de Settings — é uma camada de **foundation** que vários epics consomem.

**Decisão canônica**: helper `auditLog()` (SQL + TS wrapper) é exposto pelo **EPIC-01 Auth & App Shell** (faz sentido — é onde a infra de auth + audit fica wired) e fica disponível pra todos a partir daí.

**Aplicação**:
- ✅ EPIC-09 — `depends_on: [EPIC-00, EPIC-01]` (removeu EPIC-10)
- ✅ EPIC-10 — `depends_on: [EPIC-00, EPIC-01]` (removeu EPIC-09)
- 🔁 EPIC-01 deve expor `lib/audit/auditLog.ts` como utilitário (cobrir em uma das suas 12 stories — provavelmente na S-01.06 ao desenhar `useAuth` + audit context, ou story dedicada se necessário)

**Justificativa**: quebra o ciclo, mantém topological order, permite EPIC-09 e EPIC-10 rodarem em paralelo após EPIC-01.

---

## Política pra próximas reconciliações

1. Conflitos detectados durante implementação devem ser logados aqui com IDs sequenciais (R-07, R-08, ...)
2. Decisões canônicas **sobrescrevem** texto em arquivos individuais — edição in-place + nota cruzada
3. Wave de implementação que tocar uma área conflitada **deve** ler este log antes de codar
4. Reconciliações que mudam contratos públicos versionam o changelog em `CHANGELOG.md`

## Próximas reconciliações esperadas (a verificar)

- Naming de hooks (`useFoo` vs `useFooQuery` vs `useFooMutation`) — ADR a registrar
- Convenção de slug pra rotas dinâmicas (`[id]` vs `[fooId]`) — registrar quando primeira tela for implementada
- Política de cache TanStack Query (`staleTime`, `gcTime`) por tipo de recurso
