/**
 * Códigos de erro canônicos da API DeskcommCRM.
 *
 * Adicionar novo código:
 *  1. Adicionar à enum/constante abaixo
 *  2. Documentar em docs/specs/<spec>.md
 *  3. Sem renomear código existente — versionar em /api/v2/ se precisar quebrar
 */

export const ApiErrorCodes = {
  // 400 — body / params
  invalid_request: "invalid_request",
  validation_failed: "validation_failed", // Zod retornou erros de schema (422 também aceita)
  invalid_cursor: "invalid_cursor",

  // Configuração de agentes: validação/estado ou indisponibilidade do provedor.
  prospecting_agent_session_failed: "prospecting_agent_session_failed",
  prospecting_agent_prepare_failed: "prospecting_agent_prepare_failed",
  prospecting_agent_chat_failed: "prospecting_agent_chat_failed",
  prospecting_agent_setup_failed: "prospecting_agent_setup_failed",
  voice_assistant_unavailable: "voice_assistant_unavailable",

  // 401 — auth
  unauthorized: "unauthorized", // segredo interno inválido/ausente (rotas host↔app, ex. system/agent)
  unauthenticated: "unauthenticated",
  token_expired: "token_expired",
  token_revoked: "token_revoked",
  invalid_credentials: "invalid_credentials",
  mfa_required: "mfa_required",
  auth_in_query_forbidden: "auth_in_query_forbidden",

  // 403 — authz
  forbidden: "forbidden",
  forbidden_role: "forbidden_role",
  forbidden_tenant: "forbidden_tenant",
  lgpd_anonymization_irreversible: "lgpd_anonymization_irreversible",

  // 404
  not_found: "not_found",

  // ⚠️ AGENDA — declarados AQUI, e não no `fail()`, porque `fail()` NÃO protege.
  //
  // A assinatura é `code: ApiErrorCode | (string & {})`, e o segundo ramo aceita
  // qualquer string: um `"slot_taken"` inventado no call site vira contrato de
  // wire sem passar por lista nenhuma, e o consumidor do outro lado nunca sabe
  // que ele existe. Quem confia que a união protege está lendo o arquivo errado.
  agenda_horario_indisponivel: "agenda_horario_indisponivel",
  agenda_fora_da_jornada: "agenda_fora_da_jornada",
  agenda_tipo_desativado: "agenda_tipo_desativado",
  agenda_sem_responsavel: "agenda_sem_responsavel",
  agenda_disponibilidade_invalida: "agenda_disponibilidade_invalida",
  agenda_ja_cancelado: "agenda_ja_cancelado",
  agenda_listagem_sem_recorte: "agenda_listagem_sem_recorte",
  // Código PRÓPRIO, e não o `unprocessable_entity` genérico: quem recebe isto
  // precisa saber que o `lead_id` mandado não é um negócio do funil (é quase
  // sempre um id de CONTATO — ver #509/#540) e que a correção é trocar o
  // parâmetro, não tratar como indisponibilidade.
  //
  // Quem recebe é a TELA da agenda: a rota só aceita sessão (`requireRole`), e
  // nenhum Bearer a alcança — o proxy devolve 401 antes. Se um dia ela passar a
  // aceitar token, este comentário ganha o integrador de volta.
  agenda_listagem_alvo_nao_e_lead: "agenda_listagem_alvo_nao_e_lead",

  // 409 — conflito
  idempotency_conflict: "idempotency_conflict",
  // Mesma chave, MESMO corpo, e a primeira execução ainda está em curso: o
  // recibo/encurso está gravado (reserva, migration 0321) mas o efeito não
  // terminou. Código próprio e não o `idempotency_conflict` acima porque a ação
  // de quem recebe é outra: aqui a chave está CERTA e o pedido é o mesmo —
  // retentar depois resolve, enquanto conflito manda trocar a chave.
  idempotency_in_progress: "idempotency_in_progress",
  state_conflict: "state_conflict",
  invalid_state: "invalid_state", // resposta a um agent_case que saiu de awaiting_human (spec 15 §7)
  tenant_already_exists: "tenant_already_exists",
  // POST /api/v1/settings/api-tokens quando a organização já está no teto de
  // tokens ATIVOS (migration 0415, issue #1448). O corpo devolve a MESMA
  // mensagem que o gatilho levantou — com o limite e a instrução de revogar um
  // token para liberar espaço —, então quem lê sabe o que fazer sem perguntar.
  api_token_teto_atingido: "api_token_teto_atingido",
  // POST /api/v1/contacts com telefone já cadastrado na mesma organização
  // (índice uniq_contacts_org_phone). O corpo traz `details.contact_id` para a
  // tela oferecer o contato existente em vez de só mostrar que deu erro.
  contact_exists: "contact_exists",
  duplicate_external_id: "duplicate_external_id",
  event_gone: "event_gone", // resend de run cujo event_log original foi apagado (on delete set null)
  no_actions_to_resend: "no_actions_to_resend", // resend de regra que não tem mais nenhuma ação de webhook — reenviar nada não é sucesso
  next_action_absent: "next_action_absent", // decisão sobre proposta que não existe (mais) [wave 4]
  next_action_changed: "next_action_changed", // o agente reescreveu a proposta entre o render e o clique
  channel_archived: "channel_archived", // ação sobre canal que o usuário excluiu (a linha só sobrevive como âncora das FKs)
  knowledge_source_type_in_use: "knowledge_source_type_in_use", // fonte ATIVA do mesmo tipo no agente — era o índice ai_knowledge_sources_unique_per_agent, que a 0181 derrubou; nenhuma rota emite mais este código
  voice_already_paired: "voice_already_paired", // POST /voice/sessions/pair com aparelho já vinculado — a saída é DELETE /voice/sessions, nunca re-parear por cima (ver a rota)

  // 422 — semântica
  unprocessable_entity: "unprocessable_entity",
  channel_without_session: "channel_without_session", // operação de sessão (reiniciar, parear) pedida a canal que não tem sessão no transporte — o oficial
  janela_fechada: "janela_fechada", // POST /messages por token/agente com texto livre fora das 24h em canal com restrição (131047) — a saída é modelo aprovado (#1614)
  invalid_state_transition: "invalid_state_transition",
  invalid_owner: "invalid_owner", // novo dono não é membro ativo agent+ da org (bulk assign, G3-04)
  trigger_kind_not_implemented: "trigger_kind_not_implemented", // publish de followup-flow com kind sem motor de enrollment (stage_change/conversation_end)
  // PATCH /api/v1/ai/jev ao ligar. Dois códigos porque são duas ações de quem lê:
  // colar e testar a chave, ou marcar o aceite de mandar a mensagem para fora.
  jev_exige_chave_validada: "jev_exige_chave_validada",
  jev_exige_aceite: "jev_exige_aceite",

  // 415 — tipo de mídia
  unsupported_media_type: "unsupported_media_type",
  // SVG recusado como logo. Código PRÓPRIO e não o genérico acima porque a pessoa
  // que sobe um SVG fez a coisa mais natural do mundo (é o formato em que um
  // designer entrega logo) e precisa ler "mande PNG ou JPG", não "tipo de mídia
  // não suportado". A razão da recusa está em lib/branding/logo-arquivo.ts.
  logo_svg_recusado: "logo_svg_recusado",

  // 413
  payload_too_large: "payload_too_large",

  // 429
  rate_limited: "rate_limited",

  // ─── ANÚNCIOS, eixo de LEITURA (0214) ───
  //
  // Declarados aqui pelo mesmo motivo que os da Agenda: `fail()` aceita
  // `(string & {})`, então um código inventado no call site vira contrato de
  // wire sem passar por lista nenhuma. E estes precisam ser distinguíveis pelo
  // cliente — a tela mostra uma frase DIFERENTE para cada um, porque cada um
  // pede uma ação diferente de quem lê (colar token novo, refazer o token com
  // `ads_read`, esperar a cota, ou avisar quem mantém o sistema).
  ads_sem_conexao: "ads_sem_conexao",
  ads_token_invalido: "ads_token_invalido",
  ads_permissao_insuficiente: "ads_permissao_insuficiente",
  ads_limite_de_chamadas: "ads_limite_de_chamadas",
  ads_campo_invalido: "ads_campo_invalido",
  ads_cifra_indisponivel: "ads_cifra_indisponivel",

  // ─── BANCO DE DADOS EXTERNO DO AGENTE (migration 0372) ───
  //
  // Declarados aqui pelo mesmo motivo dos da Agenda/Anúncios: `fail()` aceita
  // qualquer string, então o código só é contrato se estiver nesta lista. A tela
  // distingue "destino bloqueado pela política de rede" de "senha cifrada não
  // pôde ser lida" — cada um pede uma ação diferente de quem lê.
  external_db_destino_bloqueado: "external_db_destino_bloqueado",
  external_db_label_em_uso: "external_db_label_em_uso",
  external_db_desativada: "external_db_desativada",
  external_db_sem_chave: "external_db_sem_chave",

  // ─── CHAMADA DE VOZ (spec 18, migration 0234) ───
  //
  // Três recusas que pedem TRÊS ações diferentes de quem lê, e por isso não
  // podem colapsar num genérico. A tela e a IA precisam distinguir:
  //
  //   • a organização não ligou a feature      → um admin liga em Segurança;
  //   • o admin tentou ligar sem aceitar o risco → ler o aviso e confirmar;
  //   • a instalação não oferece o serviço      → falar com quem administra a
  //     VPS; nenhum clique na tela resolve.
  //
  // O terceiro é 503 (dependência de instalação, como `waha_not_configured`);
  // os dois primeiros são 422 (recurso desligado por configuração da própria
  // organização, como `agenda_tipo_desativado`).
  voice_desligada_na_organizacao: "voice_desligada_na_organizacao",
  voice_risco_nao_aceito: "voice_risco_nao_aceito",
  voice_indisponivel_na_instalacao: "voice_indisponivel_na_instalacao",
  // 503: a leitura do estado não voltou. Separado dos dois acima de propósito —
  // "não sei" não pode se disfarçar de "está desligada", que mandaria a pessoa
  // procurar um interruptor quando o problema é o banco.
  voice_estado_indeterminado: "voice_estado_indeterminado",

  // ─── NEGÓCIOS E FUNIL (issues #917 e #922) ───
  //
  // Onze códigos de wire que a família de `/api/v1/leads` já emitia — alguns há
  // meses — sem passar por esta lista. Pelo mesmo motivo dos blocos acima:
  // `fail()` aceita `(string & {})`, então o código nasce no call site e vira
  // contrato sem ninguém decidir que virou. `grep` de cada um contra este
  // arquivo devolvia zero, inclusive para `lead_stage_changed_concurrent` e
  // `pipeline_immutable_use_clone`, que são contrato de wire em produção.
  //
  // Registrados JUNTOS, e não só os dois que o lote acrescentou, porque corrigir
  // por instância deixa as irmãs de fora — e elas não se parecem por fora.
  //
  // 409: a trava otimista do arrasto (`expected_updated_at` não bate).
  lead_stage_changed_concurrent: "lead_stage_changed_concurrent",
  // 422, o motivo da perda: exigido quando a escrita fecharia o negócio como
  // perdido, e recusado quando não está no vocabulário do funil. Um pede
  // informar, o outro pede escolher da lista — colapsá-los mandaria quem já
  // informou um motivo digitar outra vez.
  lost_reason_required: "lost_reason_required",
  lost_reason_invalid: "lost_reason_invalid",
  // 422, a fronteira do funil (P-01): a etapa é de outro funil, e o caminho para
  // levar o negócio até lá é o clone, não o arrasto.
  pipeline_immutable_use_clone: "pipeline_immutable_use_clone",
  stage_pipeline_mismatch: "stage_pipeline_mismatch",
  // 422, as recusas do clone — cada uma pede uma ação diferente de quem lê:
  // escolher outro funil, reabrir o negócio, escolher outra etapa, configurar
  // uma etapa de entrada, ou configurar uma etapa de perda no funil de origem.
  pipeline_unchanged: "pipeline_unchanged",
  lead_not_open: "lead_not_open",
  stage_destino_terminal: "stage_destino_terminal",
  pipeline_without_initial_stage: "pipeline_without_initial_stage",
  pipeline_no_lost_stage: "pipeline_no_lost_stage",
  // 404: o funil de destino não existe (ou não é desta organização).
  pipeline_not_found: "pipeline_not_found",
  // ─── CAMPOS OBRIGATÓRIOS E MOTIVO DE GANHO (issue #1536) ───
  //
  // As duas recusas do núcleo novo, cada uma com a sua demanda: a primeira pede
  // PREENCHER (o `details.faltando` nomeia chave e rótulo de cada campo — e
  // quando o que falta é o motivo de ganho a chave é `won_reason`, um caso do
  // mesmo contrato, não um código à parte), a segunda pede ESCOLHER da lista
  // cadastrada (`settings.won_reasons`). Colapsá-las mandaria quem já informou
  // escolher sem lista, e quem não informou digitar sem caminho.
  required_fields_missing: "required_fields_missing",
  won_reason_invalid: "won_reason_invalid",

  // ─── AVISO DE CASO NO WHATSAPP (migration 0292, onda 8) ───
  //
  // Declarados aqui pelo mesmo motivo dos blocos acima: `fail()` aceita
  // `(string & {})`, e um código que nasce no call site vira contrato de wire
  // sem ninguém decidir que virou. Estes quatro precisam ser distinguíveis
  // porque a TELA faz uma coisa diferente com cada um:
  //
  //   • `aviso_numero_de_cliente` NÃO é uma recusa final — é uma PERGUNTA. O
  //     número digitado já é um cliente desta organização, e confirmar
  //     significa que as mensagens dessa pessoa param de chegar ao CRM. A tela
  //     mostra o aviso e reenvia com `confirma_contato: true`;
  //   • `aviso_numero_da_propria_org` é final: é o laço robô↔robô, e não há
  //     confirmação que o torne aceitável;
  //   • `aviso_canal_invalido` manda escolher outra conexão;
  //   • `aviso_nao_configurado` é do botão de teste, e manda salvar antes.
  //
  // Os quatro são 422 — recusa semântica sobre um corpo bem formado.
  aviso_numero_de_cliente: "aviso_numero_de_cliente",
  aviso_numero_da_propria_org: "aviso_numero_da_propria_org",
  aviso_canal_invalido: "aviso_canal_invalido",
  aviso_nao_configurado: "aviso_nao_configurado",

  // ─── Módulo CAMPANHAS (migration 0264, Spec 12 §17) ───
  campanha_nao_encontrada: "campanha_nao_encontrada", // 404
  // 409: a ação não cabe no estado atual. A mensagem diz os DOIS estados, porque
  // "estado inválido" sem dizer qual manda o operador adivinhar.
  campanha_estado_invalido: "campanha_estado_invalido",
  campanha_nao_editavel: "campanha_nao_editavel", // 409: só rascunho aceita edição
  campanha_preparando: "campanha_preparando", // 409: preparação em andamento
  campanha_sem_audiencia: "campanha_sem_audiencia", // 422: o recorte não achou ninguém
  // 422: achou gente, e nenhuma pode receber (todos bloqueados/sem telefone). É
  // diferente de audiência vazia: o filtro está certo e a lista é que não presta.
  campanha_sem_elegiveis: "campanha_sem_elegiveis",
  campanha_canal_indisponivel: "campanha_canal_indisponivel", // 409: conexão fora do ar ou de outra org
  campanha_agenda_invalida: "campanha_agenda_invalida", // 422: data no passado
  campanha_conteudo_invalido: "campanha_conteudo_invalido", // 422: texto vazio ou variável que não existe
  campanha_base_legal_invalida: "campanha_base_legal_invalida", // 422: interesse legítimo sem referência da LIA

  // 500 / upstream
  internal_error: "internal_error",
  upstream_unavailable: "upstream_unavailable",
  unavailable: "unavailable", // 503: dependência de config ausente (ex.: pool do engine sem SUPABASE_DB_URL)
  waha_error: "waha_error",
  wacalls_error: "wacalls_error", // 502: o serviço de chamada de voz recusou ou não respondeu
  wacalls_not_connected: "wacalls_not_connected", // 503 + Retry-After: sessão pareada cujo socket com o WhatsApp caiu por um instante (ver `wacallsSemConexao`)
  ai_provider_error: "ai_provider_error",
  nuvemshop_error: "nuvemshop_error",
} as const;

export type ApiErrorCode = (typeof ApiErrorCodes)[keyof typeof ApiErrorCodes];
