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
  "contact.aniversario_emitido",
  /**
   * A varredura de data do funil (#989) emitiu o aviso de "faltam N dias". A
   * trilha guarda a RODADA (quantos negócios, quantos pulados), e não um evento
   * por negócio: a emissão já é a linha do `event_log`, e a pergunta que se faz
   * depois é "a varredura das 9h rodou e quanta coisa saiu dela".
   */
  "lead.data_do_funil_emitida",
  "lgpd.anonymize_executed",
  // A cascata retomando o que uma execução interrompida não terminou (#310).
  "lgpd.anonymize_catchup",
  "member.invited",
  "team.interface_changed",
  /**
   * A EMPRESA trocou as portas que mostra (issue #1341, migration 0367). É o
   * degrau acima do `team.interface_changed`: ali a pergunta é "quem tirou o
   * Inbox da Maria", aqui é "quem escondeu o Inbox da instalação inteira, e
   * quando" — pergunta que só tem resposta na trilha, porque a coluna guarda só
   * o valor de agora e a escolha anterior não se reconstrói.
   */
  "org.interface_changed",
  "member.accepted",
  "member.role_changed",
  "member.revoked",
  // O inverso de `member.revoked`. Auditável pelo mesmo motivo que ela: a
  // pergunta "quem devolveu o acesso desta pessoa, e quando?" só tem resposta
  // aqui — a coluna `revoked_at` volta a NULL e não guarda histórico.
  "member.reactivated",
  // Um convite PENDENTE cancelado na tela de Equipe (migration 0238). Distinto
  // de `member.revoked` (tira acesso de quem já entrou): aqui ninguém chegou a
  // ser membro. O REENVIO de um convite audita como `member.invited` — é uma
  // nova emissão do mesmo convite.
  "member.invite_revoked",
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
  // O arquivamento é terminal como o fechamento, e o evento é separado de
  // propósito: quem audita precisa distinguir "encerrou o atendimento" de
  // "mandou para o arquivo". Ver o corpo da issue #923.
  "conversation.archived",
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
  "message.edited",
  "message.revoked",
  "message.hidden_in_crm",
  "message.restored_in_crm",
  // Uma rodada do cron `recover-stuck-messages` que de fato marcou mensagem
  // como falha (rodada vazia não vira linha — varredura não é mutação).
  "message.recover_stuck_run",
  "contact.blocked",
  "phone_number.created",
  "phone_number.updated",
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
  // Uma rodada do cron `webhook-replay` que reprocessou ou desistiu de algum
  // arquivo de webhook do canal por QR (rodada vazia não vira linha).
  "webhook.replay_run",
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
  "ai.knowledge_reindex_all",
  "ai_agent.created",
  "ai_agent.updated",
  "ai_agent.archived",
  "ai_agent.duplicated",
  "ai_agent.paused",
  "ai_agent.published",
  "ai_agent.version_created",
  "ai_agent.version_updated",
  "ai_agent.tested",
  "ai_agent.reconciled",
  "ai_reply.generated",
  "ai_reply.approved",
  "ai_reply.rejected",
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
  "ai.org_default_updated",
  // Ligar/desligar uma das duas verificações que consultam modelo. Auditável
  // porque muda o que o sistema confere antes de falar com o cliente — e porque
  // custa dinheiro por mensagem.
  "ai.guardrail_layer_changed",
  "ai_agent.run_started",
  "ai_agent.run_completed",
  "ai_agent.run_failed",
  "channel.connected",
  "prospecting.changed",
  // A ABORDAGEM que SAIU (PR #963). Distinta de `prospecting.changed`, que é
  // configuração: esta é a única linha do produto que fala primeiro com quem
  // nunca falou com a empresa, e é a resposta a "por que vocês me escreveram?".
  // Emitida pelo worker quando houve EFEITO (tentativa de envio), nunca em
  // rodada de cron vazia.
  "prospecting.approach_sent",
  "channel.pairing_code_requested",
  "channel.social_configured",
  "channel.ai_access_updated",
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
  // Chamada de voz WhatsApp (WaCalls, spec 18) — pareamento do segundo
  // dispositivo vinculado, opt-in por org. Admin only.
  //
  // `voice.session_prepared` NÃO é mais emitida: era o passo "preparar" que
  // antecedia o `/pair` do upstream, e o `/pair` foi embora (ver
  // `app/api/v1/voice/sessions/pair/route.ts`). Fica na lista porque a trilha
  // de quem pareou entre 2026-09-14 e a remoção tem linhas com esse nome, e o
  // painel rotula a partir daqui.
  "voice.session_prepared",
  "voice.session_pair_started",
  // As mutações da chamada em si. Todas auditadas porque todas têm efeito no
  // mundo: uma ligação sai do CRM para o telefone de uma pessoa, alguém a
  // atende ou a recusa, e alguém a derruba. Um registro em `voice_calls` diz o
  // QUE aconteceu; a trilha diz QUEM mandou acontecer, e são perguntas
  // diferentes quando o time inteiro compartilha o mesmo número.
  "voice.call_started",
  "voice.call_accepted",
  "voice.call_rejected",
  "voice.call_ended",
  // Troca de SDP: é o que abre o ÁUDIO de uma ligação para um navegador. Sem
  // esta linha não há como responder "quem estava ouvindo esta conversa".
  "voice.call_media_attached",
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
  "demanda.encerrada",
  "routing.worker_run",
  "attendant.heartbeat_swept",
  // A PRIMEIRA batida de presença de um atendente: é ela que insere a linha e
  // acorda o roteamento (`trg_routing_availability_changed`), efeito que outra
  // pessoa sente. As batidas seguintes não auditam, pela mesma régua do cron
  // que não faz nada (CLAUDE.md, Audit log).
  "attendant.presence_started",
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
  // Edição pela tela (Fase 2 do PLANO-CONFIG-UI-AGENTE): nova versão + ponteiro
  // movido. O corpo é texto que o agente lê — mudar isso muda o comportamento,
  // então fica auditado.
  "ai.skill_saved",
  // Rollback para uma versão anterior (Fase 5): move o ponteiro sem criar versão.
  "ai.skill_restored",
  "ai.router_created",
  "ai.router_updated",
  "ai.router_deleted",
  "ai.router_members_updated",
  "followup_flow.created",
  "followup_flow.updated",
  "followup_flow.published",
  "followup_flow.disabled",
  "followup_flow.deleted",
  "followup_flow.duplicated",
  "followup_flow.rolled_back",
  "followup.worker_run",
  "followup.silence_sweep_run",
  // Roteiros de atendimento encerrados por prazo (0397) — só quando houve efeito.
  "followup.roteiros_expirados",
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
  "auth.signup_provision_recovery_failed",
  "auth.email_link_rejected",
  "auth.password_reset_requested",
  "auth.password_reset_request_failed",
  "auth.password_reset_completed",
  "auth.password_reset_failed",
  "tenant.created_by_signup",
  "tenant.created_by_recovery",
  "conversation.snoozed",
  "conversation.snooze_cancelled",
  "conversation.snooze_watcher_run",
  // Rodada do cron que devolve ao agente o handoff parado além do prazo da
  // organização — só quando devolveu (ou falhou) alguma.
  "conversation.handoff_auto_return_run",
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
  // A política de cadastro da INSTALAÇÃO trocada em `platform_settings`
  // (migration 0233) — mutação de plataforma, sem `organization_id`. Auditável
  // porque decide quem consegue ENTRAR no sistema inteiro, e "por que ninguém
  // mais cria conta?" só tem resposta aqui: não há event_log que cubra o tipo
  // (nenhum handler o consumiria — ver register-handlers.ts) e a troca não
  // deixa rastro em nenhuma outra tabela.
  "platform.signup_mode_updated",
  // Configuração da INSTALAÇÃO trocada pela tela (migration 0341): credencial de
  // e-mail, remetente, contatos. Auditável pelo mesmo motivo das vizinhas — é
  // mutação de plataforma, sem `organization_id`, e "por que parou de enviar
  // e-mail?" só tem resposta aqui.
  //
  // ⚠️ O VALOR NUNCA ENTRA NO metadata, e isto não é zelo: `api_audit_log` é
  // append-only por schema (nenhum papel tem GRANT de UPDATE/DELETE, nem o
  // `service_role`), então um segredo que caia ali fica cinco anos e não sai.
  // O emissor grava só a chave, a natureza e os últimos 4 caracteres.
  "platform.config_changed",
  "platform.config_reset",
  // O COMPORTAMENTO da instalação trocado em `platform_settings` pela tela
  // `/admin/sistema` (migration 0331, issue #1034) — irmã da linha de cima, e
  // mutação de plataforma. Auditável porque pergunta "por que a IA não parou no
  // teto?" / "por que a entrega do webhook foi recusada?" só tem resposta aqui:
  // é a única tabela que guarda quem desligou o bloqueio de gasto, mudou o
  // portão de divulgação ou passou a exigir assinatura nas entregas.
  "platform.comportamento_updated",
  // Um MÓDULO OPCIONAL da instalação ligado ou desligado em `/admin/sistema`
  // (linha em `platform_config`, migration 0384 — o banco externo, doc 37).
  // Auditável porque a linha guarda o estado e não o histórico: "desde quando
  // as empresas deste servidor podiam ligar um banco de outro sistema?" só tem
  // resposta aqui.
  "platform.modulo_updated",
  // A lista de endereços da rede INTERNA que a instalação pode alcançar
  // (`platform_settings.internal_destinations`, migration 0324, decisão 22-d).
  // Auditável pela mesma razão da linha acima e com alcance maior: cada entrada
  // é uma porta que o servidor passa a poder abrir para dentro da própria rede,
  // levando junto a credencial da instalação. "Desde quando isto estava
  // liberado?" não tem resposta em nenhuma outra tabela — a coluna guarda o
  // estado, não o histórico —, e não há event_log que cubra o tipo (nenhum
  // handler o consumiria; evento sem consumer é o anti-pattern nº 3).
  "platform.internal_destinations_updated",
  "platform_google_oauth.updated",
  "platform_smtp_settings.updated",
  // A credencial do APP da Meta da INSTALAÇÃO (migration 0257): o App Secret que
  // assina a entrega do webhook e o verify token que responde ao handshake.
  // Auditável pelo mesmo motivo da linha acima, e com alcance maior — quem tem o
  // App Secret assina uma entrega de webhook VÁLIDA com dados que ele inventar,
  // movendo contato e lead no funil de QUALQUER cliente daquela instalação.
  // Sem `organization_id`: não é credencial de tenant. `"platform_meta_app.
  // verify_token_rotated"` é uma ação separada porque a rotação derruba a
  // verificação de URL que estava valendo até alguém colar o valor novo na Meta.
  "platform_meta_app.updated",
  "platform_meta_app.verify_token_rotated",
  // A conexão da ORGANIZAÇÃO com a conta de anúncios (migration 0213).
  // Auditável porque o token gravado aqui escreve conversões na conta de
  // mídia do cliente: "quem apontou minhas vendas para este destino?" só tem
  // resposta nesta trilha. COM `organization_id`, diferente das duas linhas
  // acima — é mutação de tenant, e cada organização tem a sua conta.
  //
  // O `metadata` carrega o dataset (identificador, não segredo) e um booleano
  // dizendo se o token foi trocado. O token, nem em metadata.
  "ad_platform_connection.updated",
  // A conexão de LEITURA da organização com a conta de anúncios (0214).
  // Ação SEPARADA da de cima, e não um `metadata.purpose` na mesma: a pergunta
  // que cada trilha responde é diferente. "Quem apontou minhas vendas para este
  // destino?" é sobre dinheiro saindo; "quem deu a alguém acesso de leitura ao
  // meu orçamento de mídia?" é sobre dado comercial vazando. Fundi-las
  // obrigaria a ler o metadata para saber qual das duas aconteceu — o mesmo
  // motivo pelo qual `branding.updated` não virou `org.updated`.
  //
  // O `metadata` carrega o id da conta padrão (identificador, não segredo) e um
  // booleano dizendo se o token foi trocado. O token, nem em metadata.
  "ad_insights_connection.updated",
  // O ENDEREÇO DE CAPTURA da landing page (0381): para qual WhatsApp a rota
  // pública manda quem clicou no botão, e com que texto. Ação separada das duas
  // acima pelo mesmo critério delas — aqui não há credencial nenhuma, e a
  // pergunta que esta trilha responde é "quem apontou o tráfego pago da minha
  // organização para este número?". Trocar a linha não derruba nada: o
  // endereço continua respondendo, os anúncios continuam rodando, e os leads
  // simplesmente passam a chegar noutro WhatsApp — por isso o número vai no
  // `metadata`, que é o único lugar onde a troca fica visível depois.
  "captura_de_utm.updated",
  // Desconectar APAGA o token (a 0205 não tem `enabled`, e o porquê está no
  // cabeçalho dela). Auditada à parte de `.updated` porque some uma credencial:
  // a tela de Meta Ads para de funcionar para todo mundo da organização, e a
  // trilha precisa dizer quem fez isso e quando.
  "ad_insights_connection.deleted",
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
  // A porta recusou o provisionamento no signup, com `motivo` no metadata. Os
  // casos: convite que não valia (expirado, ou emitido para outro e-mail),
  // `somente_convite` (a instalação não abre organização para quem chega sem
  // convite) e `acesso_revogado` (a conta teve o acesso retirado — a consulta a
  // `acessoFoiRevogado` é feita ENTRE `vinculoAtivo` e `decidirConviteDoSignup`,
  // senão o motivo auditado sairia como convite inválido, que não é a verdade
  // sobre o que aconteceu com quem foi revogado). Não é falha de sistema: é a
  // recusa deliberada de abrir organização nova.
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
  // Ligar de volta um tipo que alguém desligou é ato de gestão e tem verbo
  // próprio: como `agenda.tipo_alterado { campos: ["is_active"] }` ele seria,
  // na trilha, indistinguível de "mudaram a duração".
  "agenda.tipo_reativado",
  // A opção da ORGANIZAÇÃO que decide se o Atendente mexe na agenda dos colegas
  // (issue #978, migration 0343). É ato de gestão como o dos tipos acima: muda o
  // que TODO Atendente pode fazer a partir dali, e sem esta linha a primeira
  // negativa de um colega não teria explicação na trilha — nem como responder
  // "quando foi que desligaram isso?".
  "agenda.colegas_podem_mexer_alterado",
  // A rodada que AVISOU alguém do próprio compromisso. Mensagem que saiu para o
  // telefone de um cliente é efeito, e efeito audita — mas só a rodada que
  // enviou: a que varreu e não achou ninguém a avisar não é mutação.
  "agenda.lembrete_enviado",
  // Fechar ou abrir um dia muda quem consegue marcar, e a pergunta que aparece
  // depois é sempre "quem fechou esse dia?". O bloqueio em si pode ser apagado
  // (é regra vigente, não fato histórico); estas linhas é que guardam a autoria.
  "agenda.dia_bloqueado",
  "agenda.dia_aberto",
  "agenda.bloqueio_removido",
  // A cobrança de um caso parado. Audita a RODADA que avisou, não cada caso:
  // o que se quer responder depois é "o sistema cobrou?", e uma linha por caso
  // faria do audit log a própria fila.
  "ai.caso_parado_cobrado",
  // Um pedido não confirmado soltou o horário que estava segurando. Audita
  // porque é CANCELAMENTO — o compromisso deixa de existir para quem o pediu —,
  // e sem esta linha a única explicação para o horário ter voltado a aparecer
  // seria "sumiu". Só a rodada que expirou alguma coisa; varredura vazia não é
  // mutação.
  "agenda.pendente_expirado",
  // O catálogo financeiro. Audita porque define PARA ONDE o dinheiro vai: a
  // forma de pagamento escolhe a conta em que a entrada cai, e mudar isso em
  // silêncio faria um mês inteiro cair na conta errada sem ninguém saber quem
  // mexeu.
  "financeiro.catalogo_criado",
  "financeiro.catalogo_alterado",
  "financeiro.catalogo_inativado",
  "comanda.aberta",
  "comanda.alterada",
  "comanda.cancelada",
  "comanda.item_incluido",
  "comanda.item_removido",
  "comanda.finalizada",
  "comanda.estornada",
  "financeiro.lancamento_criado",
  "financeiro.lancamento_pago",
  "financeiro.lancamento_removido",
  "fidelidade.ponto_dado",
  "fidelidade.ponto_resgatado",
  "financeiro.recorrencia_gerada",
  "comanda.faturada_em_lote",
  // A rodada de renovação — e ela só audita quando FEZ algo, como manda a regra
  // do cron desta base. Uma linha por rodada com efeito, carregando a contagem:
  // é o que permite responder "quantas agendas precisaram reconectar esta
  // semana" sem varrer log de worker.
  "agenda.google.renovacao_executada",
  // A rodada da VOLTA. Também só audita quando fez algo, e a contagem carrega
  // `nossos_ignorados` de propósito: é o número que prova o anti-eco
  // funcionando — sem ele, esses eventos teriam virado compromisso fantasma.
  "agenda.google.sync_executado",
  "agenda.google_selection_updated",
  "agenda.google_catalog_updated",
  "agenda.meet_action_requested",
  "agenda.google_resolution_requested",

  // ── O compromisso em si (frentes 1 e 5 do Calendário Vivo) ──────────────
  // Marcar, remarcar e cancelar são mutações de um compromisso com hora e
  // pessoa. Cancelar em especial: é a única das três que alguém pode querer
  // negar ter feito.
  //
  "agenda.appointment_created",
  "agenda.appointment_outcome_recorded",
  "agenda.appointment_updated",
  "agenda.confirmation_sweep_run",
  "agenda.settings_updated",
  "agenda.endereco_salvo",
  "agenda.appointment_rescheduled",
  "agenda.appointment_cancelled",
  // Relógio HTTP (Hobby / sem contêiner scheduler): uma batida que alguém
  // de fora chama. Só audita quando alguma tarefa mexeu em dado.
  "relogio.tick_run",

  // Zona de perigo de Configurações › Organização: o admin zera os dados de
  // atendimento da própria organização para recomeçar os testes. Um DELETE não
  // deixa rastro sozinho — esta linha é o único registro de que a organização
  // foi esvaziada, por quem, e de quanto (as contagens vão no metadata).
  "org.dados_operacionais_apagados",

  // O catálogo da loja (migration 0204). Preço de venda é dado que a equipe
  // disputa — quem mudou e quando precisa ficar registrado.
  "catalog_product.created",
  "catalog_product.updated",
  "catalog_product.deleted",
  "catalog_product.imported",
  // As fotos do produto (migration 0390): subir uma, e reordenar/remover.
  "catalog_product.photo_added",
  "catalog_product.photos_updated",

  // As tarefas do CRM (migration 0210). Tarefa é combinado de trabalho entre
  // pessoas do time — quem a criou, quem mudou o prazo e quem a apagou é
  // exatamente o que se disputa depois de um cliente ficar sem retorno.
  "crm_task.created",
  "crm_task.updated",
  "crm_task.deleted",
  "organization.switched",
  // Chamada originada via /api/v1/calls (módulo VoIP, migration 0347).
  // Só o CREATE é auditado aqui — status/transcript são atualizados pelo
  // worker via admin client, fora do caminho de sessão que este audit cobre.
  "call.created",
  "voip_trunk.created",
  "voip_trunk.updated",

  // Chamada de voz WhatsApp (spec 18, migration 0234). Ligá-la vincula um
  // SEGUNDO aparelho ao número que já atende, por um caminho que não é o
  // oficial — o risco é a conta ser bloqueada. Estas duas linhas são a resposta
  // a "quem autorizou isso" e a "quando isso foi desfeito"; sem elas, depois de
  // um bloqueio não há como saber nem uma coisa nem outra.
  "voice.opt_in_changed",
  "voice.session_unpaired",

  // A exclusão de contato que NÃO completou (issue #752). A ausência de
  // `contact.deleted` não distinguia "ninguém excluiu" de "tentei, um vínculo
  // RESTRICT barrou e o contato ficou de pé" — e as duas coisas contam a mesma
  // história incompleta quando a única linha que o painel tem para olhar é a do
  // sucesso. `metadata.motivo` separa `vinculo_restrict` de `falha_ao_apagar` e
  // `metadata.apagados` diz o que já tinha saído quando parou — que é
  // exatamente o que faltou no incidente: o histórico foi destruído ANTES do
  // erro, sem rastro de nada.
  "contact.delete_blocked",
  // Visão de plataforma sobre o agente de um cliente (fase A da spec 19). Entra
  // porque toda leitura de `admin/` é auditada neste repo — e porque aqui o
  // operador enxerga o agente publicado na organização de outra pessoa.
  "platform_admin.tenant_agents_viewed",
  "extension.catalog_admitted",
  "extension.installed",
  "extension.install_failed",
  "extension.configured",
  "extension.deactivated",
  "extension.preparation_cancelled",
  // Troca de versão, desfazer a última troca e remoção da instalação. A remoção grava, além
  // da linha da instância, um `extension.deactivated_by_removal` por organização desligada, com
  // `metadata.reason = "installation_removed"`.
  "extension.updated",
  "extension.update_failed",
  "extension.reverted",
  "extension.removed",
  // Nome próprio, e não `extension.deactivated`: na auditoria da organização, "nós desligamos" e
  // "o responsável pela instalação removeu" precisam ser distinguíveis sem abrir os metadados.
  "extension.deactivated_by_removal",
  // "Cliente pela agenda" ligada ou desligada (migration 0262). Ligar reescreve
  // etiquetas de toda a organização; metadata leva as contagens.
  "crm.cliente_pela_agenda_alterado",
  // A etiqueta da ORGANIZAÇÃO renomeada, juntada ou excluída na tela de Tags
  // (issue #852, fatia S4). É um código só porque a linha já carrega
  // `metadata.acao` (renomear/juntar/excluir) e o alcance da operação (contatos,
  // leads, conversas, regras). Três códigos para a mesma decisão deixariam o
  // filtro do painel com três opções onde houve UMA escolha do operador.
  "tag_vocabulary.changed",
  // Mover um card para OUTRO funil (issue #922) clona o negócio no destino e
  // encerra o original: é a escrita que mexe em DOIS funis de uma vez.
  "lead.moved_to_pipeline",
  /**
   * A equipe perguntou à IA sobre um caso (migration 0281). Uma linha por
   * PERGUNTA, respondida ou não — `respondeu:false` com `error_code` é o que
   * torna contável "a IA parou de responder à equipe", que sem isto só
   * apareceria como casos parados na fila.
   *
   * ⚠️ SEM O TEXTO. Nem a pergunta, nem a resposta: `api_audit_log` é
   * append-only, sem UPDATE nem DELETE para papel nenhum — o que entra ali não
   * sai pela cascata de LGPD.
   */
  "ai.case_chat_asked",
  /**
   * O aviso de caso no WhatsApp da equipe (migration 0292).
   *
   * Três códigos e não um: "saiu", "não saiu em definitivo" e "alguém mudou a
   * configuração" são perguntas diferentes, feitas por gente diferente. Um
   * código só obrigaria a abrir o metadata para saber qual dos três aconteceu —
   * e o painel de auditoria filtra por `action`, não por metadata.
   *
   * `ai.case_alert_sent` só quando a entrega virou `enviado`; `ai.case_alert_failed`
   * só na falha DEFINITIVA (retry não é fato auditável, é o sistema tentando).
   *
   * ⚠️ SEM O TEXTO e SEM O NÚMERO INTEIRO. O corpo do aviso nunca entra (ele
   * carrega o relato do cliente) e o destino entra MASCARADO: `api_audit_log` é
   * append-only, sem UPDATE nem DELETE para papel nenhum — o que entra ali não
   * sai pela cascata de LGPD.
   */
  "ai.case_alert_sent",
  "ai.case_alert_failed",
  "ai.case_alert_settings_changed",
  /**
   * O botão "enviar aviso de teste" (onda 8) — e ele é um QUARTO código, não
   * `ai.case_alert_sent` com um `teste: true` no metadata.
   *
   * A razão é de conta, não de gosto: o teste manda uma mensagem de verdade
   * pelo número da organização e gasta uma do teto diário. Se ele entrasse como
   * `sent`, quem auditasse "quantos avisos saíram este mês" contaria as
   * conferências junto — e o painel de auditoria filtra por `action`, nunca por
   * metadata. Auditado tenha ele saído ou não: o gasto e a tentativa são o
   * fato, e a razão da recusa é o que responde depois "por que não sai".
   */
  "ai.case_alert_test_sent",
  /**
   * A cobrança da PASSAGEM que ninguém assumiu (onda 11).
   *
   * Código próprio, e não `ai.caso_parado_cobrado` com um campo no metadata:
   * são duas populações diferentes e a pergunta que se faz depois é diferente.
   * O caso parado é a IA esperando uma DECISÃO; a passagem esquecida é um
   * cliente esperando uma RESPOSTA, e ninguém sabe que ele existe. Dos treze
   * caminhos que passam conversa para uma pessoa, só um nasce de caso — o vigia
   * de casos não alcançava os outros doze nem por acidente, e um metadata
   * compartilhado esconderia justamente essa diferença (o painel de auditoria
   * filtra por `action`, nunca por metadata).
   *
   * Audita a RODADA que cobrou, nunca a que varreu e não achou ninguém: rodada
   * sem efeito não é mutação (`tests/unit/cron-audita-so-quando-ha-efeito.test.ts`).
   */
  "ai.passagem_parada_cobrada",
  // A chave de IA girada NO LUGAR (PATCH /ai/credentials/:id). Distinto de
  // `ai.credential_created` e `ai.credential_revalidated`: aqui o id não muda, e
  // "quando esta chave foi trocada, e por quem" é a pergunta que só esta linha
  // responde — a coluna `updated_at` se move por qualquer motivo.
  "ai.credential_updated",
  // Rodada do canal-mudo-watcher que ABRIU ou FECHOU aviso (doc 11, decisão B).
  // Só com efeito: varredura diária que não achou nada não é mutação.
  "channel.canal_mudo_watcher_run",
  // A rodada do cron `followup-sem-agente` que MEXEU em alguma coisa: abriu
  // aviso de fluxo publicado que nenhum agente arma, fechou aviso cujo vínculo
  // apareceu, ou os dois. Rodada sem efeito não audita (CLAUDE.md §Audit log),
  // então esta linha existe quando `abertos + fechados > 0` — e `metadata` leva
  // as duas contagens mais `examinados`, que é o que diferencia "ninguém tinha
  // fluxo desarmado" de "a varredura não rodou".
  "ai.followup_sem_agente_reconciliado",
  // Ajustes determinísticos de estilo da ORGANIZAÇÃO ligados, desligados ou com
  // item trocado (PATCH /ai/style-adjustments). O `metadata.ajuste` nomeia o
  // item; a linha registra a decisão sem expor o prompt do agente.
  "ai.style_adjustment_changed",
  /** POST /api/v1/tenants/provision — organização criada por um sistema externo (doc 38 b). */
  "tenant.created_by_provisioning",
  /**
   * A repetição do provisionamento completou o que a tentativa anterior não
   * chegou a gravar — hoje, o vínculo de admin do dono. Sai SÓ quando houve
   * efeito, e é o único registro que a organização nascida de uma tentativa
   * partida tem: a `tenant.created_by_provisioning` dela nunca saiu, porque a
   * primeira tentativa morreu antes de chegar nessa linha.
   */
  "tenant.provisioning_completed",
  // O funil que VOLTOU do arquivo (#979). Espelha `pipeline.archived`: sem um
  // código próprio, tirar do arquivo cairia em `pipeline.updated` e sumiria no
  // meio dos renames — e "quem trouxe este funil de volta, e quando" é a
  // pergunta que o painel de auditoria só responde filtrando por `action`.
  "pipeline.unarchived",

  // O banco de dados externo do agente (migration 0372). Dado de terceiro pode
  // ter PII: a configuração da conexão é auditada, e a LEITURA também — mas o
  // metadata de `read` carrega só o QUE foi lido (schema/tabela), nunca os
  // valores de filtro, que viajariam como PII para o log.
  "external_db_connection.created",
  "external_db_connection.updated",
  "external_db_connection.deleted",
  "external_db_connection.tested",
  "external_db_connection.read",
  // Campanhas (migration 0375). Toda mudança de ESTADO da campanha audita: são
  // as ações que fazem mensagem sair para gente que não pediu, e "quem mandou
  // isso, e quando?" precisa de resposta. Edição de rascunho não audita — não
  // saiu nada dela.
  "campaign.created",
  "campaign.prepared",
  "campaign.test_sent",
  "campaign.scheduled",
  "campaign.started",
  "campaign.paused",
  "campaign.resumed",
  "campaign.cancelled",
  "campaign.duplicated",
  // Rodada do cron que MEXEU em alguma campanha (enviou, pulou, concluiu,
  // promoveu agendada). Rodada vazia não audita — o critério do `CLAUDE.md`.
  "cron.campaign_worker",
  // Lista de exclusão da operação (migration 0376). Audita porque é decisão que
  // tira alguém de todo envio futuro — "quem tirou este número, e quando?"
  // precisa de resposta. O telefone NÃO entra no payload: só os últimos dígitos.
  "campaign.suppression_added",
  "campaign.suppression_removed",
  // Padrões de campanha da organização (janela de atribuição de resposta e o
  // ritmo que campanha nova herda). Auditável porque muda o comportamento de
  // TODA campanha futura, e a de atribuição muda a métrica das já enviadas.
  "campaign.settings_updated",

  // ── Entrada com Google (issue #1388) ────────────────────────────────────
  // UM código para as recusas do OAuth, com `motivo` no metadata. Da partida
  // (`signInWithGoogle`): `provedor_indisponivel` (ninguém ligou o provedor
  // Google no projeto) e `url_ausente`. Da volta (`/auth/callback`, já depois
  // do gate): `troca_do_code_falhou` (o verificador de PKCE não voltou, o code
  // já foi gasto, o relógio do GoTrue passou) e `leitura_do_vinculo_falhou` (a
  // sessão fechou, mas a leitura do vínculo não respondeu — falha fechada).
  //
  // As duas recusas que acontecem ANTES do gate — `error` na URL e chegada sem
  // `code` — não escrevem auditoria, de propósito: quem chega assim ainda não
  // provou ser dono do verificador de PKCE, e `error` é texto cru de quem
  // chama. A doutrina é a do irmão desta rota — `app/api/v1/agenda/google/
  // callback/route.ts` audita DEPOIS do gate, nunca antes. A tela de login diz
  // o que aconteceu a quem chega por esses dois caminhos.
  //
  // A pergunta de triagem é sempre a mesma — "por que a entrada com Google não
  // fechou para esta pessoa?" —, e ela não precisa de quatro filtros no painel
  // para ser respondida; o que precisa estar separado é a causa, e ela está.
  "auth.google_signin_failed",

  // ── Cadastro com aprovação (migration 0383, recorte do PR #714) ─────────
  // O pedido de empresa nova numa instalação em `com_aprovacao`, e a decisão
  // do administrador da instalação. `approved` leva o `organization_id` da
  // empresa que nasceu da aprovação — é a única ligação entre o pedido e ela.
  "registration.requested",
  "registration.approved",
  "registration.rejected",
  // O interruptor do Jev (PATCH /api/v1/ai/jev). Ligar manda cada mensagem
  // recebida dos clientes, uma de cada vez e sem o histórico da conversa, para
  // um fornecedor nos EUA: "quem ligou, quando, e se o aceite foi dado ali" é a
  // pergunta de LGPD que só estas linhas respondem.
  // `desligado` também sai quando a exclusão da última chave apta dele o
  // desliga (`DELETE /api/v1/ai/credentials/:id`, metadata.motivo "chave_excluida").
  "ai.jev.ligado",
  "ai.jev.desligado",
  "ai.jev.modo_alterado",
  // O pedido de descadastro é do cliente e o padrão é irreversível — mas a
  // regra W-02 do catálogo de negócio prevê o override: admin desbloqueia à
  // mão. Sem esta linha, a ação existiria sem rastro de QUEM a desfez, que é
  // o dado que importa quando alguém pergunta "por que este cliente voltou a
  // receber?".
  "contact.unblocked",
] as const;

/** Um código de auditoria. Derivado de `AUDIT_ACTIONS` — não redigite a lista. */
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
