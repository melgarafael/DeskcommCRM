---
title: 5 Jornadas Críticas
parent: README.md
fonte: docs/prd/01..06
version: 0.1
date: 2026-04-28
---

# 02 — Jornadas Críticas

> 5 fluxos onde cada minuto importa. Cada passo mapeia tela visitada, ação, estado da UI, componentes envolvidos. Cita PRDs ao referenciar capacidade.

---

## Jornada 1 — Operador BPO atende cliente final via WhatsApp + IA

**Persona.** P1 (Operador BPO).
**Gatilho.** Toast + bell badge: nova mensagem em uma conversation cross-tenant.
**Frequência.** ~50–100 vezes/dia por operador.
**Sucesso.** Cliente respondido em <5min, conversation marcada `resolved`, NPS ≥ 8.

| # | Tela | Ação | Estado UI | Componentes | Realtime |
|---|---|---|---|---|---|
| 1 | `/login` | digita email + senha | default | `<LoginForm>` | — |
| 2 | `/login/mfa` | insere TOTP 6 dígitos | default | `<TOTPInput>` | — |
| 3 | `/admin/inbox` (super-admin BPO) | landing automático | default + lista carregada | `<ConversationList cross-tenant>` | sim |
| 4 | `/admin/inbox` | toast "Nova msg de Maria — Loja Acme" | toast aparece bottom-right; bell badge `3` | `<ToastViewport>`, `<NotificationBell>` | sim (broadcast) |
| 5 | `/admin/inbox/[conversationId]` | clica no toast OU na conversa lista | thread carregando (skeleton 300ms) | `<ChatThread skeleton>`, `<CRMSidePanel skeleton>` | sim |
| 6 | idem | thread + side panel hidratam | default | `<ChatThread>`, `<CRMSidePanel>` com `<ContactSection>`, `<DealSection>`, `<TimelineSection>` | sim |
| 7 | idem | lê últimas 3 respostas do bot (badge "IA") | thread renderizada | `<MessageBubble role=ai>` | — |
| 8 | idem | vê `sentiment_score=0.4` no header | warning amber visível | `<SentimentBadge>` (Sub-PRD 05 §3.6) | — |
| 9 | idem | clica "Eu cuido" | botão vira spinner; depois `Você está atendendo` | `<ClaimButton>` (Sub-PRD 04 §3.8) | sim (broadcast claim) |
| 10 | idem | composer focado; digita resposta | `status=composing` | `<ComposerBar>`, auto-resize textarea | — |
| 11 | idem | Cmd+V cola imagem do clipboard | preview thumbnail no composer | `<MediaPreview>` | — |
| 12 | idem | clica "Enviar" (ou Cmd+Enter) | bubble aparece em <50ms com `status=sending` (cinza claro) | `useSendMessage` (Sub-PRD 04 §3.7) | — |
| 13 | idem | acks WAHA chegam | bubble: `sending → sent → delivered → read` (check duplo azul) | `<MessageStatus>` (Sub-PRD 03 §3.4) | sim |
| 14 | idem | cliente responde ("OK obrigado!") | bubble inbound aparece + auto-scroll (se no fim) | `<ChatThread>` | sim |
| 15 | idem | clica "Resolver" | confirm modal "Resolver agora?" | `<ResolveDialog>` | — |
| 16 | idem | confirma | conversation some da fila default; toast "Resolvida" | activity `conversation_status_changed` (Sub-PRD 04 §3.4) | sim |
| 17 | (background) | sistema dispara mensagem NPS automática (Sub-PRD master §8.1) | invisível | worker `event_log:conversation.resolved` | — |

**Pontos de fricção potenciais.**
- Toast some antes do operador clicar → notification persistente até dismiss explícito
- Skeleton de 300ms parece travado em rede ruim → progressbar topo se >800ms
- Claim concorrente: 409 do colega → toast amigável "João já está atendendo" + refetch lista
- Auto-scroll roubando contexto quando operador rola pra cima → desativar se scroll > 200px do fim

**Métricas de sucesso.**
- TTI inbox < 1s p95
- Tempo entre clique no toast e composer focado < 500ms
- Claim → 1ª resposta < 2min (medido)
- Taxa de quick reply usada > 40%

---

## Jornada 2 — Super-admin BPO faz triagem cross-tenant

**Persona.** P2.
**Gatilho.** Início do turno OU alerta "Tenant X com 12 conversas pendentes >10min".
**Frequência.** 3–5 vezes/dia.
**Sucesso.** Identificar gargalo e redistribuir em <5min.

| # | Tela | Ação | Estado UI | Componentes | Realtime |
|---|---|---|---|---|---|
| 1 | `/login` + `/login/mfa` | login | default | idem J1 | — |
| 2 | `/admin/dashboard` | landing alternativo (escolha em `/admin`) | KPIs carregando + alerts banner | `<KPICards>`, `<AlertsBanner>` | sim |
| 3 | idem | banner vermelho: "Acme Loja • 12 pendentes >10min" | alerta clicável | `<AlertItem severity=critical>` | sim |
| 4 | `/admin/tenants/[acme-id]/health` | clica alerta | health page com WAHA + IA + Nuvemshop status | `<HealthGrid>` | sim |
| 5 | idem | identifica: "Atendente João offline há 2h" | seção atendentes destacada | `<TeamPresence>` | sim |
| 6 | `/admin/tenants/[acme-id]/team` | clica "Ver time" | lista atendentes com status presence | `<TeamList>` | sim |
| 7 | idem | clica em outra atendente "Ana — online" | drawer com botão "Reassign 12 conversas pendentes pra Ana" | `<ReassignBatchDrawer>` | — |
| 8 | idem | confirma | toast progresso "Reassinando 12/12" + lock otimista | `<ProgressToast>` | sim (cada reassign emite event) |
| 9 | `/admin/dashboard` | volta | banner de Acme some; KPI "pendentes >10min" cai pra 0 | idem | sim |

**Pontos de fricção potenciais.**
- Reassign em massa estourar 50 cards → fallback "ver lista pra reassign individual"
- Audit log enorme → query indexada por `tenant_id + action + created_at`
- Operador BPO clica em alerta que já foi resolvido → estado "Resolvido por Beatriz há 2min"

**Métricas.**
- Tempo do alerta até reassign concluído < 2min
- Banner some em <2s após resolução
- Audit log filtrado < 2s p95

---

## Jornada 3 — Atendente recebe handoff de IA

**Persona.** P1 ou P4.
**Gatilho.** IA detecta `sentiment_score=0.15` (< threshold 0.3) → `event_log:handoff_triggered` (Sub-PRD 05 §3.7).
**Frequência.** 5–15 vezes/dia.
**Sucesso.** Atendente assume conversa em <30s sem perder contexto.

| # | Tela | Ação | Estado UI | Componentes | Realtime |
|---|---|---|---|---|---|
| 1 | `/app/inbox` | trabalhando em outra conversa | default | idem | sim |
| 2 | idem | push browser + toast amber "Bot escalou • Maria Santos • Sentiment baixo" | toast persistente + bell+1 | `<HandoffToast>` (acionável) | sim (broadcast `handoff_triggered`) |
| 3 | `/app/inbox/[conversationId]` | clica toast | thread carregando | skeleton | sim |
| 4 | idem | thread renderiza com banner amber sticky topo: "Bot escalou — motivo: sentiment_score=0.15 • há 12s" | `<HandoffBanner trigger="low_sentiment">` | `<HandoffBanner>`, `<SentimentTimeline>` | — |
| 5 | idem | rola até início do handoff (autoscroll-to-handoff) | divisor visual "↑ histórico do bot / ↓ você assume" | `<HandoffDivider>` | — |
| 6 | idem | lê últimos 20 turns + sentiment timeline lateral | sentiment chart visível | `<SentimentChart>` | — |
| 7 | idem | clica "Eu cuido" (claim implícito) OU já está claimed automaticamente em handoff | botão vira `Você está atendendo` | `<ClaimButton>` | sim |
| 8 | idem | digita resposta empática | composer | `<ComposerBar>` | — |
| 9 | idem | envia | bubble outbound `status=sending → sent` | idem J1 | — |
| 10 | (decisão) | depois de 3 trocas, situação acalma | atendente clica menu "Mais → Passar pra IA" | `<ReactivateBotMenuItem>` | — |
| 11 | idem | confirm dialog "Reativar bot?" | dialog | `<ReactivateBotDialog>` | — |
| 12 | idem | confirma | banner verde "Bot reativado" 3s; activity `ai_reactivated_by_agent` | `<Toast>` | sim |
| 13 | idem | (alternativa) clica "Resolver" direto | resolve sem reativar bot | idem J1 step 15 | sim |

**Pontos de fricção.**
- Banner amber bloqueia scroll → sticky mas dismissable após leitura
- Atendente reativa bot por engano → undo de 5s no toast
- Múltiplos handoffs simultâneos → fila ordenada por `sentiment_score asc` no toast stack

**Métricas.**
- Tempo entre handoff_triggered e claim humano < 30s p95
- Taxa de reativação de bot < 20% (caso normal: humano resolve)

---

## Jornada 4 — Tenant admin onboarding (1º login)

**Persona.** P3 (admin).
**Gatilho.** Email de convite recebido após criação manual do tenant (Sub-PRD 01 §3.7).
**Frequência.** 1× por tenant.
**Sucesso.** Tenant operacional (WhatsApp WORKING + Nuvemshop conectado + IA configurada + 1 atendente convidado) em <30min.

| # | Tela | Ação | Estado UI | Componentes |
|---|---|---|---|---|
| 1 | email | clica link assinado (TTL 24h) | — | — |
| 2 | `/login/recovery?token=...` ou `/onboarding/welcome?token=...` | aceita termos + define senha | form com força-de-senha indicator | `<SetPasswordForm>`, `<TermsCheckbox>` |
| 3 | `/onboarding/mfa-setup` | escaneia QR TOTP no Authy/1Password | QR + input 6 dígitos | `<TOTPSetup>`, `<QRCanvas>` |
| 4 | idem | confirma TOTP + recebe **10 códigos de recuperação** (mostrados ONCE) | recovery codes + botão "Baixar PDF / Copiar" | `<RecoveryCodesPanel>` (Sub-PRD 01 §7) |
| 5 | `/onboarding/welcome` | overview do wizard — 5 steps | progress stepper | `<OnboardingStepper steps=5 current=1>` |
| 6 | `/onboarding/connect-whatsapp` | clica "Conectar número" | sessão criada `STARTING` | `<ChannelSessionCard>` (Sub-PRD 03 §3.1) |
| 7 | idem | QR aparece (refresh 30s) | countdown + QR Image | `<QRCodePanel autoRefresh=30s>` |
| 8 | idem | escaneia no celular | webhook `session.status=WORKING` chega | banner "Conectado! +5511999..." |
| 9 | `/onboarding/connect-nuvemshop` | clica "Conectar loja" | redirect Nuvemshop OAuth | `<NuvemshopConnectButton>` (Sub-PRD 06 §3.3) |
| 10 | (Nuvemshop) | autoriza scopes | redirect callback | — |
| 11 | `/onboarding/connect-nuvemshop?status=success` | callback | banner "Conectado • sync iniciado" + barra progresso | `<SyncProgressBar>` |
| 12 | `/onboarding/configure-ai` | escolhe template prompt ("Atendimento e-commerce padrão") | seleção radio + preview | `<PromptTemplateSelector>` (Sub-PRD 05 §3.1) |
| 13 | idem | upload PDF "Política de troca" | drop zone | `<KnowledgeUploader>` |
| 14 | idem | salva | banner "Bot pronto • 1 fonte ingerida" | — |
| 15 | `/onboarding/invite-team` | digita 2 emails de atendentes + role | tabela de pendentes | `<InviteForm>`, `<InviteList>` |
| 16 | idem | envia convites | toast "2 convites enviados" | — |
| 17 | `/onboarding/done` | resumo + CTA "Ir pra Inbox" | confetti opcional + checklist | `<OnboardingDone>` |
| 18 | `/app/inbox` | landing pós-onboarding | inbox vazio com empty state friendly | `<EmptyState type=first_inbox>` |

**Pontos de fricção.**
- Usuário sai no meio → estado salvo em `tenant.onboarding_state` jsonb; volta no step
- QR expira durante step 6 → auto-refresh sem reload
- Nuvemshop OAuth falha → erro acionável + botão "Tentar novamente"
- Recovery codes não baixados → só permite avançar após "Confirmo que salvei" check

**Métricas.**
- Onboarding completo < 30min p95
- Drop-off rate por step monitorado
- WhatsApp conectado em <2min após scan

---

## Jornada 5 — LGPD `customer/data_request` via webhook Nuvemshop

**Persona.** P3 (admin) executa; P5 (cliente final) é o titular.
**Gatilho.** Cliente final solicita export no portal Nuvemshop → webhook `customer/data_request` chega (Sub-PRD 06 §3.9).
**Frequência.** 1–5 por mês por tenant.
**Sucesso.** Export entregue ao titular em ≤D+7 com 100% dos dados pessoais.

| # | Tela | Ação | Estado UI | Componentes |
|---|---|---|---|---|
| 1 | (background) | webhook chega; HMAC válido; log raw | invisível | handler `/api/v1/webhooks/nuvemshop/customer-data-request` |
| 2 | (background) | sistema cria `lgpd_request` em `received` — nada é montado nem enviado ao titular antes do passo 9 | invisível | handler (o worker só roda com a aprovação) |
| 3 | `/app/inbox` (admin) | toast persistente roxo "Pedido LGPD recebido — D+7" | toast clicável | `<LGPDToast>` |
| 4 | `/app/lgpd/requests` | clica toast OU acessa via menu | tabela com status `received` | `<LGPDRequestList>` |
| 5 | `/app/lgpd/requests/[id]` | clica row | detalhe: dados do titular + preview do que será exportado | `<LGPDRequestDetail>` |
| 6 | idem | seção "O que será incluído": checklist (`contacts`, `conversations`, `messages`, `activities`, `orders`) | preview accordion | `<ExportPreview>` |
| 7 | idem | seção "SLA": "Recebido D+0 • alarme em D+5 • prazo D+7" | timeline horizontal | `<SLATimeline>` |
| 8 | idem | clica "Aprovar export" | confirm dialog com o nome do titular e o e-mail de destino ("Titular: Maria Silva · Envio para: maria@…") | `ApproveButton` |
| 9 | idem | confirma | row vira `processing`; spinner | worker async gera JSON + PDF |
| 10 | idem | quando worker termina (≤30min): row vira `completed`; campo "Link assinado válido por 7 dias" | success banner | `<ExportReadyPanel>` |
| 11 | (background) | email automático ao titular com link assinado (TTL 7d) | invisível | — |
| 12 | (audit) | `audit_log:lgpd.export_generated` registra `who, which_contact, items_count, delivered_at` | invisível | Sub-PRD 01 §3.5 |
| 13 | idem | admin clica "Reenviar email ao titular" se cliente não recebeu | toast | `<ResendButton>` |

**Regra (doc 134, opção A).** O pedido que chega pela Nuvemshop **espera a aprovação**: o dado pessoal só sai da empresa depois que um admin confere, na confirmação, o nome do titular e o e-mail de destino. O webhook só cria o pedido; quem dispara a exportação é a aprovação (`app/api/v1/lgpd/requests/[id]/approve/route.ts`), e o worker ignora evento sem essa marca. O prazo D+7 continua cobrado pelo `cron/lgpd-sla-watcher` enquanto o pedido espera.

**Pontos de fricção.**
- Admin não vê toast (estava offline) → email + bell badge persistente até clicar
- Worker falha → row vira `failed` + alarme operacional pro super-admin (Sub-PRD 06 §7 N5)
- D+5 sem ação → notificação escalada pro super-admin
- Tentativa de approve em request `expired` (>D+7 sem ação) → 422 + escalation

**Métricas.**
- SLA D+7 cumprido ≥99%
- Tempo médio admin → approve < 24h
- Taxa de re-envio < 5%
