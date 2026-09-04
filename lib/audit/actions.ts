/**
 * Vocabulário canônico de ações de auditoria — a ÚNICA lista.
 *
 * Acrescente código novo no fim; nunca renomeie. Cada código casa 1:1 com uma
 * linha de `api_audit_log.action`.
 *
 * ─── Por que isto é um ARRAY, e o tipo é derivado dele ──────────────────────
 *
 * Até 2026-08-14 este arquivo declarava um union de tipo e
 * `components/admin/audit/action-codes.ts` declarava, à mão, a cópia em runtime
 * que virava o filtro do painel de auditoria — com o comentário "keep in sync
 * manually" e nenhum gate cobrando. Medido no SHA 66924aad: **209 códigos aqui,
 * 89 lá, 120 emitidos e não-filtráveis na tela** (o inverso era 0). Auditoria
 * cega exatamente sobre o que foi acrescentado depois, e o modo de falha é mudo
 * dos dois lados: o typecheck passa, a linha entra no banco, e a ausência de uma
 * opção no filtro lê-se como "isso não acontece" em vez de "isso não está lá".
 *
 * A cópia foi APAGADA. O array é o valor em runtime, `AuditAction` é derivado
 * dele, e o painel mapeia o array. Código novo aqui aparece no filtro sem
 * ninguém lembrar de nada — que é a única forma de sincronia que não depende de
 * memória humana.
 *
 * ─── PROIBIDO importar qualquer coisa neste arquivo ────────────────────────
 *
 * `AuditFiltersAdmin.tsx` é `"use client"` e importa este módulo. Enquanto ele
 * não tiver `import`/`require`, o que vai para o bundle do browser são só as 209
 * strings. Um `import { env } from "@/lib/env"` aqui arrastaria a validação de
 * env — e o que ela lê — para dentro do JavaScript entregue ao cliente.
 * `tests/unit/audit-lista-do-painel-e-derivada.test.tsx` reprova quem tentar.
 */
export const AUDIT_ACTIONS = [
  "auth.login_success",
  "auth.login_failed",
  /** Teto de tentativas barrou antes de chegar ao provedor (issue #64). */
  "auth.login_rate_limited",
  "auth.logout",
  "auth.mfa_enrolled",
  "auth.mfa_success",
  "auth.mfa_failed",
  "auth.recovery_code_used",
  "nuvemshop.connected",
  "nuvemshop.disconnected",
  "nuvemshop.oauth_failed",
  "nuvemshop.webhook_received",
  "nuvemshop.webhook_invalid_signature",
  "lead.created",
  "lead.updated",
  "lead.deleted",
  "lead.moved",
  "lead.won",
  "lead.lost",
  "lead.bulk_action",
  // A importação de planilha (extração do PR #418). O GESTO é auditado além dos
  // N `lead.created`: "quem despejou 300 negócios neste funil, e quando" é a
  // pergunta que se faz depois, e ela não se responde contando linhas soltas.
  "lead.imported",
  "contact.created",
  "contact.updated",
  "contacts.imported",
  "contact.anonymized",
  "contact.merge_pending",
  "contact.merged",
  "lgpd.anonymize_executed",
  "member.invited",
  "member.accepted",
  "member.role_changed",
  "member.revoked",
  "token.created",
  "token.revoked",
  "profile.updated",
  "org.updated",
  "pipeline.config_updated",
  "mfa.recovery_codes_regenerated",
  "notification_prefs.changed",
  "onboarding.welcome_completed",
  "onboarding.whatsapp_configured",
  "onboarding.whatsapp_skipped",
  "onboarding.nuvemshop_skipped",
  "onboarding.ai_configured",
  "onboarding.team_invited",
  "onboarding.completed",
  "tenant.onboarded",
  "conversation.created",
  "conversation.claimed",
  "conversation.transferred",
  "conversation.released",
  "conversation.closed",
  // O par que faltava do `ai.reactivated_by_agent`: pausar o atendimento
  // automático numa conversa não tinha rota e, portanto, não tinha ação de
  // auditoria. Desligar uma automação é decisão auditável tanto quanto religá-la.
  "conversation.ai_paused",
  "conversation.tags_changed",
  "contact.tags_changed",
  // Fila de confirmação (spec 17 §4b): a IA PROPÕE, uma pessoa decide. As três
  // entram porque a proposta é intenção auditável mesmo quando nunca vira
  // escrita — e "ninguém confirmou" é informação, não ausência dela.
  "contact.field_proposed",
  "contact.field_confirmed",
  "contact.field_rejected",
  "lead.tags_changed",
  "message.sent",
  "message.received",
  // Uma rodada do cron `recover-stuck-messages` que de fato marcou mensagem
  // como falha (rodada vazia não vira linha — varredura não é mutação).
  "message.recover_stuck_run",
  "contact.blocked",
  "ai.handoff_triggered",
  "ai.reactivated_by_agent",
  "conversation.usable_for_rag_toggled",
  "rag.conversations_batch_run",
  "lgpd.redact_received",
  "lgpd.data_request_received",
  "lgpd.store_redact_received",
  "lgpd.export_generated",
  "lgpd.export_delivered",
  "lgpd.export_failed",
  "lgpd.redact_executed",
  "lgpd.redact_skipped_already_anonymized",
  "lgpd.redact_no_local_footprint",
  "lgpd.redact_completed",
  "lgpd.redact_failed",
  "lgpd.tenant_redacted",
  "lgpd.consent_changed",
  "lgpd.manually_approved",
  "webhook.hmac_invalid",
  "lgpd.sla_alarm_triggered",
  "lgpd.sla_watcher_run",
  "platform_admin.inbox_listed",
  "platform_admin.conversation_viewed",
  "platform_admin.tenants_listed",
  "platform_admin.tenant_viewed",
  "tenant.created_by_platform_admin",
  "platform_admin.tenant_health_viewed",
  "platform_admin.impersonate_started",
  "platform_admin.impersonate_ended",
  "platform_admin.impersonate_misconfigured",
  "tenant.suspended",
  "tenant.reactivated",
  "platform_admin.audit_listed",
  "platform_admin.audit_entry_viewed",
  "platform_admin.lgpd_listed",
  "platform_admin.lgpd_request_viewed",
  "platform_admin.incidents_listed",
  "platform_admin.incident_viewed",
  "incident.resolved",
  "platform_admin.usage_viewed",
  "platform_admin.users_listed",
  "platform_admin.user_viewed",
  "platform_admin.platform_admins_listed",
  "mcp.tool_called",
  "ai.credential_created",
  "ai.credential_deleted",
  "ai.credential_revalidated",
  "ai_agent.created",
  "ai_agent.updated",
  "ai_agent.archived",
  "ai_agent.duplicated",
  "ai_agent.paused",
  "ai_agent.published",
  "ai_agent.version_created",
  "ai_agent.version_updated",
  "ai_agent.tested",
  "ai_agent.reverted",
  "ai.dispatcher_run",
  "ai.pacing_knobs_updated",
  "ai.inbox_item_status_changed",
  "ai.flywheel_proposal_applied",
  "ai.org_memory_published",
  "ai.org_memory_entry_created",
  "ai.org_memory_entry_updated",
  /** Provedor/modelo de um ponto do sistema que usa IA foi trocado no painel. */
  "ai.purpose_binding_updated",
  // Ligar/desligar uma das duas verificações que consultam modelo. Auditável
  // porque muda o que o sistema confere antes de falar com o cliente — e porque
  // custa dinheiro por mensagem.
  "ai.guardrail_layer_changed",
  "ai_agent.run_started",
  "ai_agent.run_completed",
  "ai_agent.run_failed",
  "channel.connected",
  "channel.reconnected",
  // Duas ações distintas de propósito: `deleted` apagou a linha (canal virgem),
  // `archived` só a escondeu porque conversas/mensagens ainda a referenciam.
  // A auditoria precisa distinguir o que sumiu do que continua no banco.
  "channel.deleted",
  "channel.archived",
  // Contraparte de `archived`: a linha escondida voltou à vida (reconexão do
  // canal oficial, retomada do pareamento). Sem ela o histórico registra a
  // exclusão e cala sobre o canal ter voltado a receber e enviar. Emitida por
  // `lib/channels/reactivate.ts` — o único caminho de volta, e é o que faz a
  // frase acima valer para os DOIS casos em vez de para o que lembraram.
  "channel.reactivated",
  "authz.denied",
  "team.role_changed",
  "leads.bulk_assigned",
  "attendant.availability_changed",
  "routing.config_changed",
  // Mudar a régua do abandono (spec 16 §5.2) muda como TODO período passa a ser
  // lido — é mutação relevante, não preferência de exibição.
  "metrics.atrito_regua_changed",
  // O invariante 4 deixando de ser só leitura: quem marcou o próximo passo de
  // uma demanda, e qual. Sem isto, a única mutação que fecha o vazamento seria
  // a única sem rastro.
  "demanda.proximo_passo_definido",
  "routing.worker_run",
  "attendant.heartbeat_swept",
  "webhook.source_created",
  "webhook.source_updated",
  "webhook.source_deleted",
  "webhook.lead_received",
  "webhook.inbound_invalid_signature",
  "automation.rule_created",
  "automation.rule_updated",
  "automation.rule_deleted",
  "automation.rule_executed",
  "automation.run_resent",
  "ai.skill_imported",
  "ai.skill_installed",
  "ai.skill_uninstalled",
  "ai.router_created",
  "ai.router_updated",
  "ai.router_deleted",
  "ai.router_members_updated",
  "followup_flow.created",
  "followup_flow.updated",
  "followup_flow.published",
  "followup_flow.disabled",
  "followup_flow.deleted",
  "followup_flow.rolled_back",
  "followup.worker_run",
  "followup.silence_sweep_run",
  "followup_enrollment.created",
  "followup_enrollment.cancelled",
  // As quatro intervenções humanas num follow-up em andamento (0145). São
  // mutações, e mutação sem audit é decisão sem dono: "quem segurou este fluxo
  // por dois dias?" é pergunta que se faz depois, quando a linha do tempo já
  // não basta.
  "followup_enrollment.paused",
  "followup_enrollment.resumed",
  "followup_enrollment.snoozed",
  "followup_enrollment.step_skipped",
  "template.created",
  "template.updated",
  "template.deleted",
  "auth.signup_requested",
  "auth.signup_failed",
  "auth.signup_confirmed",
  "auth.signup_provision_failed",
  "auth.email_link_rejected",
  "auth.password_reset_requested",
  "auth.password_reset_request_failed",
  "auth.password_reset_completed",
  "auth.password_reset_failed",
  "tenant.created_by_signup",
  "conversation.snoozed",
  "conversation.snooze_cancelled",
  "conversation.snooze_watcher_run",
  "conversation.note_added",
  "conversation.note_deleted",
  "ai.case_replied",
  // O agente participando do chamado — separado de `ai.case_replied` (a pessoa
  // respondendo) porque juntar os dois apagaria justamente quem agiu.
  "ai.case_noted_by_agent",
  "ai.case_closed_by_agent",
  "pipeline.agent_mapping_updated",
  "pipeline.stage_created",
  "pipeline.stage_updated",
  "pipeline.stage_archived",
  "pipeline.created",
  "pipeline.updated",
  "pipeline.archived",
  // Só existe para o funil que nunca recebeu negócio: com histórico, a operação
  // vira `pipeline.archived` e a linha continua no banco.
  "pipeline.deleted",
  "system.update_requested",
  "system.update_finished",
  // IA 360 · wave 2 — o retorno agendado deixou de ser exclusividade do motor e
  // virou capacidade configurável. `followup_enrollment.*` é o motor de FLUXOS;
  // estas duas são a PROMESSA avulsa (cron_jobs), que é outra coisa e precisava
  // de código próprio para não somar duas grandezas no mesmo relatório.
  "followup.scheduled",
  "followup.cancelled",
  "lead.reactivation_proposed",
  // A marca da INSTALAÇÃO (nome, logo, cor, selo) trocada em `platform_branding`
  // — mutação de plataforma, não de tenant, e por isso sem `organization_id`.
  // Auditável porque muda a fachada que TODOS os clientes daquela instalação
  // veem, e a pergunta "quem repintou isto?" só tem resposta aqui: não há
  // event_log (nenhum handler consumiria o tipo — ver register-handlers.ts).
  "platform_branding.updated",
  "platform_google_oauth.updated",
  // A marca da ORGANIZAÇÃO (nome + cor) trocada em `organizations.settings.branding`
  // — mutação de TENANT, e por isso COM `organization_id` e com `resource_id` =
  // o uuid da org. É outra ação, e não `org.updated`, porque a pergunta que a
  // trilha responde é diferente: "quem repintou a marca desta empresa?" contra
  // "quem mexeu no cadastro dela?". Fundir as duas obrigaria a ler o metadata
  // para saber qual das duas coisas aconteceu.
  "org.branding_updated",

  // ── Vindos da `main` durante a continuação do épico ──────────────────
  // Chegaram pelo painel (`action-codes.ts`) no mesmo intervalo em que este
  // arquivo virou a fonte única. O merge pediu COMBINAÇÃO, não escolha de
  // lado: `ours` perderia estes oito; `theirs` perderia a derivação.
  "onboarding.quadro_montado",
  "onboarding.quadro_pulado",
  // O passo de ver o funcionário responder antes de terminar o wizard.
  "onboarding.agente_testado",
  "onboarding.agente_teste_pulado",
  "security.mfa_exigida",
  "security.mfa_dispensada",
  "security.mfa_desativada",
  // Havia convite no signup e ele não valia (expirado, ou emitido para outro
  // e-mail). Não é falha de sistema: é a recusa deliberada de abrir organização
  // nova para quem estava tentando entrar numa existente.
  "auth.signup_provision_recusado",

  // ── O teto de gasto de IA (migration 0159) ──────────────────────────────
  // Até aqui `PATCH /api/v1/ai/budget` não emitia NENHUMA linha de auditoria —
  // `grep -c "lib/audit" app/api/v1/ai/budget/route.ts` devolvia 0, e nenhum
  // dos códigos acima falava de orçamento. Um endpoint que mexe em dinheiro e
  // decide se a IA para de responder não deixava rastro de quem mexeu.
  //
  // São TRÊS e não um: "quem armou a parada" e "quem a desarmou" viram filtro
  // único e permanente no painel de auditoria. Efeito colateral que fecha uma
  // porta para sempre: a partir daqui, "este teto foi escolhido por um humano?"
  // é uma query em `api_audit_log` — nenhuma sessão futura precisa inventar um
  // `limit_set_at` para adivinhar intenção a partir do valor.
  //
  // Uma mutação = UMA linha: a transição para/de `bloquear` escolhe entre
  // `armed`/`disarmed`, e todo o resto (teto, limiar, off↔avisar) cai em
  // `limit_changed`. O metadata carrega antes/depois dos três campos, então o
  // que mudou está sempre na linha, qualquer que seja o código.
  "ai.budget_limit_changed",
  "ai.budget_enforcement_armed",
  "ai.budget_enforcement_disarmed",
  "contact.deleted",

  // A poda do histórico (issue #261). UMA linha por rodada que de fato
  // apagou algo — rodada que não apagou nada não é mutação e não ocupa
  // trilha (o mesmo critério do snooze-watcher e do recover-stuck-messages).
  //
  // Esta linha é o que impede o expurgo de virar apagamento silencioso de
  // auditoria: ela guarda quantas linhas saíram, sob que retenção, e é NOVA
  // demais para a chamada seguinte do expurgo alcançar — a trilha registra
  // a própria erosão em vez de encolher sem deixar marca.
  "retention.sweep_run",

  // ── A agenda conectada do Google (frente 3 do Calendário Vivo) ───────────
  // TRÊS e não uma, e a razão é a mesma das três do teto de gasto: cada uma
  // responde a uma pergunta diferente que alguém vai fazer ao painel meses
  // depois.
  //
  // `conexao_iniciada` é o único registro de que a pessoa CHEGOU a ir ao
  // Google — sem ela, uma conexão que morre no meio do caminho não deixa
  // rastro nenhum e o relato que chega é "cliquei e não aconteceu nada".
  //
  // `conexao_falhou` carrega o motivo em `metadata.reason`, e ele é o que
  // separa causas com desfechos opostos: `state_invalido` é retorno que não
  // dá para verificar, `scope_missing` é a pessoa tendo desmarcado permissão
  // na tela do Google, `cifra_indisponivel` é a instalação sem chave. As três
  // aparecem iguais para quem clicou; só a trilha distingue.
  //
  // ⚠️ Desistir NÃO é falha e não entra aqui: quem clica "Cancelar" na tela do
  // Google volta pelo callback, e auditar isso encheria a trilha de gente que
  // apenas mudou de ideia — o mesmo critério do cron que não fez nada.
  "agenda.google.conexao_iniciada",
  "agenda.google.conexao_falhou",
  "agenda.google.conexao_concluida",
  "agenda.google.conexao_desconectada",
  // Tipos de agendamento: mudar duração, categoria ou responsável muda o que a
  // IA oferece ao cliente, então é mutação de configuração e audita.
  "agenda.tipo_criado",
  "agenda.tipo_alterado",
  "agenda.tipo_desativado",
  // A rodada de renovação — e ela só audita quando FEZ algo, como manda a regra
  // do cron desta base. Uma linha por rodada com efeito, carregando a contagem:
  // é o que permite responder "quantas agendas precisaram reconectar esta
  // semana" sem varrer log de worker.
  "agenda.google.renovacao_executada",
  // A rodada da VOLTA. Também só audita quando fez algo, e a contagem carrega
  // `nossos_ignorados` de propósito: é o número que prova o anti-eco
  // funcionando — sem ele, esses eventos teriam virado compromisso fantasma.
  "agenda.google.sync_executado",

  // ── O compromisso em si (frentes 1 e 5 do Calendário Vivo) ──────────────
  // Marcar, remarcar e cancelar são mutações de um compromisso com hora e
  // pessoa. Cancelar em especial: é a única das três que alguém pode querer
  // negar ter feito.
  //
  // Não há `agenda.appointment_completed` nem `_no_show` aqui de propósito.
  // Esses dois não são mutação de intenção — são o registro de um fato que já
  // aconteceu no mundo, e vivem na timeline do lead (`ATIVIDADES_DA_AGENDA`,
  // em `lib/agenda/tipos.ts`), não na trilha de quem-fez-o-quê.
  "agenda.appointment_created",
  "agenda.appointment_rescheduled",
  "agenda.appointment_cancelled",
  // Relógio HTTP (Hobby / sem contêiner scheduler): uma batida que alguém
  // de fora chama. Só audita quando alguma tarefa mexeu em dado.
  "relogio.tick_run",

  // O catálogo da loja (migration 0204). Preço de venda é dado que a equipe
  // disputa — quem mudou e quando precisa ficar registrado.
  "catalog_product.created",
  "catalog_product.updated",
  "catalog_product.deleted",
  "catalog_product.imported",
] as const;

/** Um código de auditoria. Derivado de `AUDIT_ACTIONS` — não redigite a lista. */
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
