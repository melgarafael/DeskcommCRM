/**
 * Tradução leiga (pt-br) dos itens da inbox do runtime do agente (Operação
 * Visível F1). `kind` é contrato do engine (agent_inbox_items.kind, migration
 * 0050) — a central de avisos mostra o que aconteceu sem jargão.
 */

import type { InboxKind } from "@/lib/agent-engine/db/repository";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

export type AgentInboxSeverity = "info" | "warn" | "critical";

/**
 * `satisfies Record<InboxKind, string>` é o que faz o compilador cobrar: kind
 * novo no tipo sem rótulo aqui = erro de build. Antes isto era
 * `Record<string, string>`, que aceita qualquer chave e **não exige nenhuma** —
 * uma anotação que parecia tipagem e era o oposto dela. Foi assim que
 * `next_action_ambiguous` chegou à tela caindo no genérico "Aviso do
 * assistente": o item existia para pedir uma escolha e se anunciava sem dizer
 * de quê.
 */
export const KIND_LABEL = {
  // Diz que ALGUÉM ESPERA, não que um registro envelheceu. "Caso parado há
  // 24h" descreve a tabela; do lado de lá existe uma pessoa que pediu algo e
  // não teve resposta, e é isso que faz quem lê a Central abrir o item.
  case_stale: "Um atendimento espera decisão da equipe",
  appointment_outcome_required:"Confirme a presença no compromisso",
  appointment_recovery_review:"A recuperação precisa de uma decisão da equipe",
  routing_unassigned: "Conversa aguardando responsável",
  qr_rescan: "Conexão do WhatsApp caiu — precisa escanear o QR de novo",
  job_dead: "Uma tarefa do assistente falhou e parou de tentar",
  event_dead: "Um evento recebido não pôde ser processado",
  budget_exceeded: "O orçamento de IA foi atingido",
  handoff: "O assistente passou um atendimento para um humano",
  promotion_review: "Proposta de melhoria do assistente aguardando sua revisão",
  judge_unaligned: "O avaliador de qualidade precisa de recalibragem",
  followup_dead: "Um fluxo de follow-up parou de tentar",
  snooze_expired: "O lead não respondeu no prazo que você definiu",
  next_action_ambiguous: "Próxima ação sem negócio definido — precisa da sua escolha",
  risk_backlog_seeded: "Negócios que já estavam parados — precisam de uma decisão",
  reactivation_expired: "A sugestão de retomar contato venceu — decida",
  // Diz o que ACONTECEU com o cliente, não o que falhou por dentro: o dono do
  // negócio precisa saber que um atendimento saiu capado, não que um token
  // colidiu. O motivo técnico fica no corpo do aviso, para quem for investigar.
  capabilities_missing: "Um atendimento saiu sem as ferramentas que você ligou",
  // Diz o que o CLIENTE viu, não o que o worker registrou: uma resposta que
  // ficou "enviando" para sempre é, do lado de lá, uma mensagem que nunca
  // chegou. O motivo técnico fica no corpo do aviso.
  message_send_stuck: "Uma resposta ficou presa e não chegou ao cliente",
  midia_nao_lida: "O agente não conseguiu ler uma foto ou áudio que o cliente enviou",
  // Diz o que o CLIENTE vive, não a configuração: do lado de lá as mensagens
  // chegam e ninguém responde. "Modo de teste sem número autorizado" descreve
  // o campo; "a IA não responde ninguém" é o que faz o operador agir.
  canal_mudo_sem_numero: "Um canal está em modo de teste — a IA não responde ninguém nele",
  // Diz o que ACONTECEU e a consequência para quem está do outro lado. "Pausado"
  // sozinho descreve o toggle que alguém clicou; "não recebe nem envia
  // mensagens" é o que muda para quem estava esperando mensagem neste canal —
  // e é a frase que faz quem lê no outro turno abrir o item.
  canal_pausado: "Um canal foi pausado — não recebe nem envia mensagens",
  // Diz o que o CLIENTE está esperando, não o que o sistema deixou de gravar.
  // "Promessa não cumprida" é a única frase que faz o dono do negócio agir: do
  // lado de lá existe uma pessoa que ouviu um compromisso e está aguardando.
  // O que a PLATAFORMA decidiu, não o assistente. O texto diz o que mudou e
  // por que importa agora — quem lê a Central quer saber se pode trabalhar, não
  // qual evento chegou.
  channel_template_review: "Um modelo de mensagem mudou de situação na revisão",
  channel_number_alert: "Seu número de WhatsApp precisa de atenção",
  // "ninguém cumpriu" é um veredito que NENHUMA linha de código apura — o
  // sistema não sabe se a promessa foi cumprida, e agendar um retorno não é
  // cumprir. "ninguém ficou responsável" é exatamente o que `apuraDonoDaPromessa`
  // mede: houve ferramenta neste turno? há retorno vivo? Se não, ninguém assumiu.
  promise_unfulfilled: "O assistente prometeu algo a um cliente e ninguém ficou responsável",
  contact_proposal_expired:
    "Uma informação que o assistente ouviu de um cliente venceu sem ninguém conferir",
  // Diz o que ACONTECEU, e nunca que algo parou — contraste deliberado com
  // `budget_exceeded` ("foi atingido"). Quem lê este aviso ainda tem a IA
  // respondendo; confundir os dois faria o dono do negócio correr atrás de uma
  // parada que não houve, ou ignorar a que houve.
  budget_warning: "O gasto de IA passou do aviso que você definiu",
  // Diz o que ACONTECEU com o material, e nunca "a indexação falhou": quem
  // subiu um PDF quer saber que o agente ainda não sabe o que está nele.
  conhecimento_nao_indexado: "Um material que você enviou não entrou na base de conhecimento",
  // Diz o que ficou por fazer, não o que o sistema registrou: "chamada perdida"
  // é o fato, e o que a pessoa precisa saber é que alguém tentou falar e não
  // conseguiu. O motivo cru do upstream (`user_ended`, `do_not_disturb`) nunca
  // chega à tela — vira frase de gente no corpo do aviso, escrito pelo worker.
  voice_call_missed: "Alguém ligou e ninguém atendeu",
  proposal_expired_notice: "Uma proposta venceu sem decisão",
  proposal_acceptance_rate_drop: "A taxa de aceite de propostas caiu",
  proposal_promised_not_created: "Uma proposta prometida não foi criada",
  // Diz o que NÃO aconteceu do ponto de vista de quem opera — "não chegou ao
  // WhatsApp da equipe" —, e nunca "a entrega falhou": quem lê precisa entender
  // que o caso continua aberto e que ninguém foi avisado por fora do CRM. O
  // código do erro (`canal_desconectado`, `teto_diario_do_numero`) vira frase no
  // CORPO do aviso, escrito pelo handler; aqui é só o título.
  aviso_de_caso_nao_entregue: "Um aviso de atendimento não chegou ao WhatsApp da equipe",
  // Diz o que o fluxo NÃO está fazendo, não o que falta no cadastro. "Sem
  // agente vinculado" descreve a linha do banco; do lado de lá existe gente que
  // devia estar recebendo mensagem e não recebe, e é isso que faz alguém abrir
  // o aviso. O passo que conserta fica no corpo.
  followup_sem_agente: "Um follow-up está publicado e não está disparando",
  // Diz QUEM percebeu: o pedido não foi visto pela regra de hoje, e o aviso é
  // uma leitura do Jev — quem abre precisa saber que a conversa não foi passada
  // nem o contato bloqueado. O que fazer vai no corpo.
  jev_pedido_de_humano: "Pedido para falar com uma pessoa, percebido pelo Jev",
  jev_parar_de_receber: "Pedido para parar de receber mensagens, percebido pelo Jev",
  proposta_travada: "Uma proposta ficou presa em envio e voltou a rascunho",
  proposta_pronta_para_revisao: "Uma proposta está pronta para revisão",
  // Rótulo do KIND, embaixo de todo item org_reativada. Desde a 0583 o `title`
  // que fn_reativar_organizacao grava varia ("há conversas para revisar" ou
  // "há agendamentos e follow-ups para revisar"), e o rótulo não promete nenhum
  // dos dois: o que parou está no corpo; o que fazer, na orientação.
  org_reativada: "A conta foi reativada — há o que revisar",
  // Régua de cobrança ou teto de IA do plano: quem resolve é o admin, em Plano e cobrança.
  cobranca: "Plano e cobrança da empresa precisam de atenção",
  email_de_login_trocado: "O e-mail de login de uma pessoa da equipe foi trocado",
  // Diz QUANDO o prazo está, não que "a tarefa vence": os dois avisos da mesma
  // família (#2529) têm de se ler diferentes num relance, e o que muda é se
  // ainda dá tempo de concluir ou se já é o vencimento que aconteceu.
  task_due: "Uma tarefa está perto do vencimento",
  task_overdue: "Uma tarefa venceu sem conclusão",
  // Diz o que a CONEXÃO fez e o que ficou para trás, não o mecanismo da
  // recuperação. O resultado (quantas mensagens, por que parou) fica no corpo.
  recuperacao_da_queda: "A conexão voltou de uma queda — recuperação das conversas",
  // Diz o que o CLIENTE viveu: escreveu, o número estava fora, e ninguém respondeu.
  cliente_sem_resposta_na_queda: "Um cliente escreveu enquanto o número estava fora e ainda não teve resposta",
  // Diz o que o CLIENTE vive: a conta que respondia por assinatura do ChatGPT
  // foi recusada e a IA parou. "Token expirado" é vocabulário de quem instalou;
  // "parou de responder" é o que faz quem lê a Central agir — e a ação é uma
  // só, reconectar em Credenciais.
  assinatura_desconectada: "A conta do ChatGPT desconectou — a IA parou de responder",
  other: "Aviso do assistente",
} as const satisfies Record<InboxKind, string>;

export const SEVERITY_LABEL: Record<AgentInboxSeverity, string> = {
  info: "informativo",
  warn: "atenção",
  critical: "crítico",
};

/**
 * O parâmetro segue `string` (não `InboxKind`) de propósito: o kind chega do
 * banco em runtime, e um clone com engine mais novo pode trazer um valor que
 * este build não conhece. O genérico é a defesa para ESSE caso — não para
 * cobrir esquecimento, que agora o compilador pega acima.
 */
export function kindLabel(kind: string, t: (texto: string) => string = (texto) => texto): string {
  return t((KIND_LABEL as Record<string, string>)[kind] ?? "Aviso do assistente");
}

/** Por que ninguém ficou responsável — o que muda é a AÇÃO que cabe a quem lê. */
export type PromessaSemDono =
  | "operador_sem_ferramentas"
  | "operador_nao_agiu"
  | "operador_nao_rodou";

/**
 * O texto do aviso de promessa sem responsável.
 *
 * ═══ A REGRA DE ESCRITA, E POR QUE ELA É ESTREITA ═══
 *
 * Nenhuma frase daqui afirma que a promessa foi ou não foi CUMPRIDA. O sistema
 * não sabe: agendar um retorno não é cumprir, e mandar uma mensagem depois
 * também não. O que ele apura é se **alguém ficou responsável**, e é só isso que
 * o texto pode dizer. A versão anterior afirmava "o sistema ainda não registrou
 * o cumprimento" — um veredito que nenhuma linha de código tinha apurado, no
 * único item que esta feature mostra ao dono do negócio.
 *
 * As três variantes dizem o MESMO fato e mudam só a ação: sem capacidade
 * marcada, o caminho é a tela do assistente; com capacidade e sem ação, é
 * decidir sobre este cliente. Um texto único mandaria metade das pessoas para o
 * lugar errado.
 */
export function copyDaPromessaSemDono(
  quantas: number,
  porque: PromessaSemDono,
  /**
   * O idioma da ORGANIZAÇÃO. O aviso é LINHA gravada — a Central mostra como
   * veio, sem passar por `t()` —, então é na escrita que ele ganha o idioma de
   * quem vai ler, como o aviso de passagem para pessoa já fazia.
   */
  idioma: Idioma = "pt-BR",
): { title: string; body: string } {
  const title =
    quantas === 1
      ? traduzir("O assistente prometeu algo ao cliente e ninguém ficou responsável", idioma)
      : `${quantas} ${traduzir("promessas ao cliente sem ninguém responsável", idioma)}`;

  const CORPO: Record<PromessaSemDono, string> = {
    operador_sem_ferramentas:
      "Nesta conversa o assistente combinou algo com o cliente. Ele ainda não tem nenhuma " +
      "capacidade marcada para registrar isso no sistema, então nada foi agendado nem anotado. " +
      "Abra a conversa para ver o que foi combinado — e, na tela do assistente, marque o que ele " +
      "pode fazer.",
    operador_nao_agiu:
      "Nesta conversa o assistente combinou algo com o cliente e não registrou nenhum próximo " +
      "passo para isso — não há retorno agendado. Abra a conversa, veja o que foi combinado e " +
      "decida quem faz.",
    operador_nao_rodou:
      "Nesta conversa o assistente combinou algo com o cliente, e a parte que organiza o sistema " +
      "não rodou neste atendimento. Nada foi agendado. Abra a conversa para ver o que foi " +
      "combinado e decida quem faz.",
  };

  return { title, body: traduzir(CORPO[porque], idioma) };
}

/**
 * Os textos da recuperação das conversas da queda (Spec 32, seção 4).
 *
 * Um motivo por texto, e o motivo é o que o administrador precisa saber para
 * agir: a conta recuperou, parou no meio, ou nem começou e por quê. O título vai
 * para a linha do aviso; o corpo, com os números e as datas já formatados pelo
 * chamador (é lá que mora o fuso), vai para a coluna `body`.
 *
 * Como os avisos de `canal_pausado`, o texto é gravado em português e lido como
 * veio: não passa por `t()` na escrita. A tradução de rótulo mora em `KIND_LABEL`.
 */
export type MotivoDoResumoDaRecuperacao =
  | "concluida"
  | "erro"
  | "numero_mudou"
  | "numero_nao_confirmado"
  | "acervo_desligado";

export interface DadosDoResumoDaRecuperacao {
  mensagens?: number;
  conversas?: number;
  /** Início da janela, já formatado (ex.: "20/10/2026 08:00"). */
  desde?: string;
  /** Fim da janela, já formatado. */
  ate?: string;
  /** O erro já resumido para uma frase (`resumirErroDaImportacao`). */
  erro?: string;
}

const TITULO_DO_RESUMO: Record<MotivoDoResumoDaRecuperacao, string> = {
  concluida: "Conversas da queda recuperadas",
  erro: "A recuperação das conversas da queda parou",
  // Os três motivos que não recuperaram nada dizem o mesmo fato ao administrador.
  // O que muda é o porquê, e esse vai no corpo.
  numero_mudou: "As conversas da queda não foram recuperadas",
  numero_nao_confirmado: "As conversas da queda não foram recuperadas",
  acervo_desligado: "As conversas da queda não foram recuperadas",
};

/**
 * O título e o corpo do resumo da recuperação, por motivo.
 *
 * Os motivos "número mudou" e "número não confirmado" existem para o mesmo
 * cuidado: a recuperação traria mensagens de OUTRO aparelho, ou de um número que
 * ninguém conferiu. Por isso o texto diz o motivo e não promete nada do conteúdo.
 */
export function copyDoResumoDaRecuperacao(
  motivo: MotivoDoResumoDaRecuperacao,
  dados: DadosDoResumoDaRecuperacao,
): { title: string; body: string } {
  const CORPO: Record<MotivoDoResumoDaRecuperacao, string> = {
    concluida:
      `Recuperamos ${dados.mensagens ?? 0} mensagens de ${dados.conversas ?? 0} conversas do período em que o número ficou fora (${dados.desde ?? ""} a ${dados.ate ?? ""}).`,
    erro:
      `A recuperação das conversas da queda parou: ${dados.erro ?? "motivo não registrado"}. Veja em Conexões.`,
    numero_mudou:
      "O número da conexão mudou na reconexão. As conversas do período fora do ar não foram recuperadas, para não trazer mensagens de outro aparelho.",
    numero_nao_confirmado:
      "Não conseguimos confirmar o número da conexão depois da volta. As conversas do período fora do ar não foram recuperadas.",
    acervo_desligado:
      "A conexão voltou, mas \"Guardar o histórico\" está desligado nela: não há como recuperar as conversas do período fora do ar.",
  };
  return { title: TITULO_DO_RESUMO[motivo], body: CORPO[motivo] };
}

/** O título do aviso por cliente sem resposta: a conversa é a referência, e o nome do cliente não entra (sem PII). */
export const TITULO_DO_CLIENTE_SEM_RESPOSTA_NA_QUEDA =
  "Cliente escreveu na queda e ainda não teve resposta";

/** O corpo do mesmo aviso. Não traz nome, número nem trecho de mensagem. */
export const CORPO_DO_CLIENTE_SEM_RESPOSTA_NA_QUEDA =
  "Este cliente escreveu enquanto o número estava fora do ar e ainda não teve resposta.";
