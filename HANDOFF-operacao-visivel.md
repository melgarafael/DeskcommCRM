# HANDOFF — Épico "Operação Visível" (telas de transparência do agente)

> ⚠️ **INSTRUÇÃO PERMANENTE (não remover):** ler no INÍCIO de toda sessão que
> trabalhe neste épico; ATUALIZAR + COMMITAR ao final de CADA avanço. Regra do
> Rafael: progresso só conta com PROVA VISÍVEL (screenshot Playwright, output de
> teste). Cada feature provada DUAS vezes: localhost (dev) E VPS após publicar.
> Maker≠checker: cada feature reportada ao Maestro com evidência.

## Contexto fixo

- **Épico:** Operação Visível — dar tela ao que o motor do agente já faz no escuro.
  Ordem: F2(i) transparência anti-ban → F2(ii) knobs → F1 central de avisos → F3 propostas flywheel.
- **Dono das telas:** Terminal C (FRONTEND). **Backend:** Terminal B (knobs read/write, apply-proposal).
- **Onde:** branch `feat/operacao-visivel` (base main pós-fusão b1003cf).
- **VPS de prova:** http://129.121.45.100:18080 (compose `deskcomm-fusion`, deploy por git bundle — ver docs/vendaval-vps-deploy-comandos.md).
- **Dados do motor:** `before_send_traces` (vetos por tentativa), `channel_knobs` (+ `channel_sessions.daily_message_limit`), `agent_inbox_items`, `flywheel_distiller_proposals`.

## Estado atual

| Feature | Status | Prova |
|---|---|---|
| F2(i) motivo da retenção na conversa | ✅ local | endpoint GET `/api/v1/conversations/[id]/retention` + `lib/inbox/retention-copy.ts` (código→pt-br leigo) + `RetentionNotice` acima do composer. Typecheck+lint zero no diff. Playwright localhost: `.superpowers/evidence/operacao-visivel-f2i-localhost.png` (veto `outside_window` seedado → "Fora da janela de envio (7h–22h, sem domingo)…"). Falta: prova VPS. |
| F2(ii) knobs | ⏳ | contrato despachado ao Terminal B (GET/PATCH `/api/v1/channel-sessions/[id]/anti-ban`) |
| F1 central de avisos | ✅ local | GET `/api/v1/ai/inbox` (+open_count) e PATCH `/api/v1/ai/inbox/[id]` (agent+, audit `ai.inbox_item_updated`); página `/app/ai/inbox` (abas Abertos/Resolvidos, badge severidade, marcar resolvido/reabrir); sino `AlertsBell` no TopBar com contador. Playwright localhost: `.superpowers/evidence/operacao-visivel-f1-localhost.png` (3 avisos seedados → resolve 1 → sino 3→2 ao vivo). Falta: prova VPS. |
| F3 propostas flywheel | ⏳ | contrato despachado ao Terminal B (GET proposals + POST apply) |

## Decisões e problemas

- Tradução dos vetos é módulo puro (`lib/inbox/retention-copy.ts`): 3 famílias — proteção (pacing/spinning, tom âmbar), conformidade (stop/LGPD, tom destructive), qualidade (promise/disclosure, tom neutro; o assistente corrige sozinho).
- Endpoint de retenção é read-only via client de sessão (RLS cobre `before_send_traces`); knobs NULL resolvidos com `PACING_DEFAULTS` (import sancionado — doutrina lint-pacing).
- Polling 30s no hook (veto nasce no worker, fora do realtime de mensagens).
- Seed de prova local: linha `before_send_traces` com `payload.seed='operacao-visivel-f2i'` no job — limpar após o épico.
- 401 de `crm_leads` no console do inbox é pré-existente (CRMSidePanel), não deste épico.
