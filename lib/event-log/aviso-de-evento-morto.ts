/**
 * O TEXTO DO AVISO `event_dead` — um texto, os DOIS drenos que desistem.
 *
 * Existem dois lugares que marcam um evento de `event_log` como `dead`:
 * `lib/event-log/drain.ts` (mídia, automações, integrações — todo tipo com
 * handler registrado) e `lib/agent-engine/edge/crm/drain.ts`, que drena só
 * `ai_agent.dispatch_requested`, o evento que faz a IA responder o cliente. O
 * aviso nasceu no primeiro e o segundo seguia morrendo calado. O texto mora aqui
 * para os dois dizerem a mesma coisa, e para a regra de escrita valer nos dois.
 *
 * ═══ A REGRA DE ESCRITA ═══
 *
 * O corpo só pede o que a tela oferece. A primeira versão mandava "conferir o
 * registro de eventos e reprocessar" — não existe tela de `event_log` nem botão
 * de reprocessar, e um evento `dead` não volta para a fila sozinho. O aviso
 * pedia a quem lê a Central uma ação que o produto não oferece.
 *
 * O que a tela DE FATO oferece, e por isso o que o corpo diz:
 *  - a orientação da política (`POLITICAS_DE_AVISO.event_dead`), renderizada
 *    pela Central logo abaixo — não se repete aqui;
 *  - o botão "Marcar resolvido", que é o que REARMA o aviso: enquanto este
 *    estiver aberto, as mortes seguintes DA MESMA FAMÍLIA na organização não
 *    abrem outro. Quem não souber disso resolve o primeiro problema e fica
 *    cego para o segundo;
 *  - quando o dreno sabe o que o evento ia fazer, o lugar onde a pessoa
 *    consegue fazer à mão o que o sistema não fez.
 *
 * ═══ QUEM LÊ NÃO PROGRAMA — O TÉCNICO VAI NO FIM, ROTULADO ═══
 *
 * A Central é lida pelo dono do negócio. A versão anterior abria o corpo com
 * `O evento "media.persist_requested" falhou 5 vezes… Motivo: <cru>` — e, no
 * aviso da IA, o motivo cru era uma frase do Postgres em inglês (`insert or
 * update on table "job_queue" violates foreign key constraint…`). Medido na QA
 * do lote 9 da triagem, pela tela.
 *
 * Então o corpo começa pelo que aconteceu e pelo que a pessoa pode fazer, e o
 * nome do evento e o motivo ficam no fim, depois de `DETALHE_TECNICO`, para
 * quem der suporte. O motivo NÃO é traduzido nem escondido: é a única pista de
 * quem investiga, e uma tradução nossa de mensagem de banco erraria em silêncio.
 *
 * O título também é para quem lê a Central: o nome do evento não entra nele
 * (ele está no detalhe técnico do corpo). O dedupe do dreno de handlers é por
 * `kind`, então tirar o nome do título não junta nem separa avisos.
 *
 * ═══ AS DUAS FAMÍLIAS, E POR QUE A CHAVE É O TÍTULO ═══
 *
 * Os dois drenos abrem o mesmo `kind` (`event_dead`). Com o dedupe só por
 * `kind`, um aviso de mídia aberto engolia a morte do despacho da IA — medido:
 * com um `event_dead` de mídia aberto, três despachos mortos não abriam nada, e
 * o aviso que dizia "a IA deixou de responder" nunca chegava à Central. É o
 * pior dos silêncios, porque o efeito perdido é a resposta ao cliente.
 *
 * Então há duas famílias, cada uma com no máximo um aviso aberto por
 * organização: a IA que deixou de responder (título fixo,
 * `IA_QUE_NAO_RESPONDEU.titulo`) e todos os outros processamentos. Um `kind`
 * próprio seria a chave mais limpa, mas `agent_inbox_items.kind` tem CHECK — o
 * kind novo pediria migration, apêndice, rótulo pt/es e política de destino
 * para separar dois textos do mesmo aviso. O título fixo já é o que a Central
 * mostra e o que distingue as famílias; se ele mudar de redação, o aviso aberto
 * com o texto antigo deixa de deduplicar UMA vez, e o efeito é um aviso a mais,
 * nunca um a menos.
 */

/**
 * O rótulo que separa o que a pessoa lê do que o suporte precisa. Um só, para
 * todo aviso que carrega detalhe técnico dizer isso do mesmo jeito.
 */
export const DETALHE_TECNICO = "Detalhe técnico, para quem der suporte:";

export interface EventoMorto {
  eventType: string;
  /** Quantas vezes o evento foi tentado, contando a que o matou. Zero: a entrada passou da janela sem ser tentada. */
  tentativas: number;
  motivo: string;
  /**
   * O que deixou de acontecer, dito por quem opera. Sem isto o título cai no
   * genérico — o dreno de handlers não sabe traduzir cada tipo que carrega.
   */
  efeito?: { titulo: string; consequencia: string; rearme: string };
}

export type EfeitoDoEvento = NonNullable<EventoMorto["efeito"]>;

/**
 * O despacho da IA que morreu — a família que nenhum outro aviso pode esconder.
 * O `titulo` é a chave do dedupe dos DOIS drenos: o do agent-engine deduplica
 * por ele, e o de handlers o exclui do seu.
 */
export const IA_QUE_NAO_RESPONDEU = {
  titulo: "A IA deixou de responder uma mensagem de cliente",
  consequencia:
    "Um cliente escreveu e a IA não respondeu; se ele não escrever de novo, a conversa fica sem resposta. " +
    "Abra o Inbox e responda as conversas que estão esperando.",
  rearme:
    "Enquanto este aviso estiver aberto, outras respostas da IA que pararem de tentar não abrem aviso novo: " +
    "depois de corrigida a causa, marque-o como resolvido para voltar a ser avisado.",
} as const;

/**
 * A mensagem do cliente que o banco não conseguiu gravar — a terceira família.
 * O cron `webhook-replay` reprocessa o arquivo do webhook enquanto o banco falha
 * de forma transitória; quando desiste, a mensagem não existe no CRM e ninguém
 * a verá pela tela. É o mesmo tamanho de dano da IA que não respondeu (o cliente
 * falou e ninguém ouviu), e por isso tem título próprio: o dreno de handlers o
 * exclui do seu dedupe, como exclui o da IA.
 */
export const MENSAGEM_QUE_NAO_ENTROU = {
  titulo: "Uma mensagem de WhatsApp não entrou no CRM",
  consequencia:
    "Um cliente mandou mensagem, mas o banco de dados estava indisponível e ela não pôde ser gravada, mesmo depois de várias tentativas. " +
    "Ela não aparece no Inbox e a IA não a respondeu: confira no celular do número as conversas recebidas nesse horário e responda por lá.",
  rearme:
    "Enquanto este aviso estiver aberto, outras mensagens que também não entrarem não abrem aviso novo: " +
    "depois de conferir, marque-o como resolvido para voltar a ser avisado.",
} as const;

/**
 * A mensagem do NÚMERO OFICIAL que o reprocessamento não conseguiu gravar — a
 * quarta família, irmã da terceira.
 *
 * O canal intermediado responde ao provedor antes de processar
 * (`lib/channels/entrada-aceita.ts`), então quem desiste dela é o cron
 * `webhook-replay`, depois do teto de tentativas. O texto da terceira não serve:
 * ela culpa o banco (aqui a causa pode ser outra) e manda olhar "o celular do
 * número", que o número oficial não tem — as conversas ficam no painel do
 * provedor.
 *
 * Título próprio pela mesma razão da terceira: o dreno de handlers o exclui do
 * seu dedupe — senão um aviso destes aberto calaria as outras tarefas que param
 * de tentar.
 */
export const MENSAGEM_DO_NUMERO_OFICIAL_QUE_NAO_ENTROU = {
  titulo: "Uma mensagem do número oficial não entrou no CRM",
  consequencia:
    "Um cliente escreveu para o número oficial, mas a mensagem não pôde ser gravada, mesmo depois de várias tentativas. " +
    "Ela não aparece no Inbox e a IA não a respondeu: confira no painel do provedor do número as conversas desse horário e responda por lá.",
  rearme:
    "Enquanto este aviso estiver aberto, outras mensagens do número oficial que também não entrarem não abrem aviso novo: " +
    "depois de conferir, marque-o como resolvido para voltar a ser avisado.",
} as const;

/**
 * A mensagem do NÚMERO OFICIAL que entrou, mas cuja ingestão parou no meio e passou
 * da janela de retomada: a quinta família. O reprocessamento roda os efeitos sem a
 * IA, então o texto da quarta seria falso: a mensagem ESTÁ no Inbox. Título próprio
 * pela mesma razão das outras: o dreno de handlers o exclui do seu dedupe.
 */
export const MENSAGEM_DO_NUMERO_OFICIAL_SEM_ATENDIMENTO = {
  titulo: "Uma mensagem do número oficial ficou sem atendimento",
  consequencia:
    "Um cliente escreveu para o número oficial e a mensagem está no Inbox, mas o processamento dela parou no meio e o prazo para retomá-lo passou. " +
    "A IA não vai responder essa mensagem e nenhum negócio nasce dela: confira as conversas desse horário e responda por lá.",
  rearme:
    "Enquanto este aviso estiver aberto, outras mensagens na mesma situação não abrem aviso novo: " +
    "depois de conferir, marque-o como resolvido para voltar a ser avisado.",
} as const;

/** O aviso da quarta ou da quinta família: o que aconteceu e o que fazer primeiro, o técnico no fim. */
export function avisoDaMensagemDoNumeroOficial(
  evento: { eventType: string; tentativas: number; motivo: string },
  efeito: EfeitoDoEvento = MENSAGEM_DO_NUMERO_OFICIAL_QUE_NAO_ENTROU,
): { title: string; body: string } {
  return avisoDeEventoMorto({ ...evento, efeito });
}

export const TITULO_GENERICO = "Uma tarefa automática parou de tentar";

const CONSEQUENCIA_GENERICA =
  "Uma tarefa automática do sistema falhou e parou de tentar: o que ela ia fazer não aconteceu, " +
  "e não será tentado de novo.";

const REARME_GENERICO =
  "Enquanto este aviso estiver aberto, outras tarefas automáticas que pararem de tentar não abrem aviso novo " +
  "(a IA que deixa de responder um cliente abre o seu próprio): " +
  "depois de corrigida a causa, marque-o como resolvido para voltar a ser avisado.";

function contagemDeTentativas(n: number): string {
  if (n === 0) return "nenhuma tentativa";
  return n === 1 ? "1 tentativa" : `${n} tentativas`;
}

export function avisoDeEventoMorto(evento: EventoMorto): { title: string; body: string } {
  return {
    title: evento.efeito?.titulo ?? TITULO_GENERICO,
    body:
      `${evento.efeito?.consequencia ?? CONSEQUENCIA_GENERICA} ` +
      `${evento.efeito?.rearme ?? REARME_GENERICO} ` +
      `${DETALHE_TECNICO} evento ${evento.eventType}, ${contagemDeTentativas(evento.tentativas)}; ` +
      `motivo: ${evento.motivo.slice(0, 400)}`,
  };
}
