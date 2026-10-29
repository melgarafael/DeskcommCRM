/**
 * As duas regras que a tela de sugestão de resposta erra quando ficam soltas.
 *
 * Vivem aqui, fora da rota e fora do componente, porque as duas são decisões
 * puras — entra um valor, sai um valor — e porque as duas já falharam em
 * produção sem que nenhum teste pudesse alcançá-las de onde estavam.
 */

/** Os estados que uma sugestão pode ter, iguais aos de `ai_reply_drafts`. */
export type StatusDaSugestao =
  | "generating"
  | "pending"
  | "approved"
  | "sending"
  | "sent"
  | "dismissed"
  | "stale"
  | "failed";

/**
 * Uma sugestão nestes estados não tem mais nada a oferecer a quem atende.
 *
 * ## O defeito, medido em produção em 2026-09-12
 *
 * O painel pedia as cinco últimas sugestões da conversa (`order by created_at
 * desc limit 5`), mostrava a primeira e **não olhava o estado dela**. Rejeitar
 * não fecha nada: a sugestão rejeitada continua sendo a mais recente, então o
 * painel seguia exibindo o texto morto — com a caixa de edição desabilitada,
 * sem botão de aprovar, sem botão de fechar (não existe nenhum no componente).
 *
 * E o caso que travou de vez: quem rejeita costuma pedir outra em seguida. Se
 * essa geração falha, nada substitui a rejeitada, e a tela fica presa naquele
 * texto indefinidamente. Foi exatamente o que aconteceu.
 *
 * `sent` entra na lista porque o texto enviado já aparece na conversa, logo
 * acima — repeti-lo numa caixa desabilitada é dizer duas vezes a mesma coisa.
 *
 * `failed` NÃO entra, de propósito: ela ainda diz o que conferir, e essa frase
 * é a única pista que sobra para quem não sabe por que a sugestão não veio.
 */
const SEM_NADA_A_OFERECER: ReadonlySet<string> = new Set<StatusDaSugestao>([
  "dismissed",
  "stale",
  "sent",
]);

/**
 * Qual sugestão o painel mostra — ou nenhuma, e aí ele volta ao estado neutro
 * (o título genérico e o botão "Sugerir resposta").
 *
 * Olha **só a mais recente**, de propósito. A alternativa — procurar na lista a
 * primeira que ainda sirva — ressuscitaria uma sugestão antiga logo depois de a
 * atual ser rejeitada, e quem atende veria um texto que já tinha sumido voltar
 * sozinho à tela. Entre mostrar demais e mostrar de menos, aqui o erro barato é
 * mostrar de menos: o botão de gerar outra está sempre ali.
 */
export function sugestaoParaMostrar<T extends { status: string }>(
  sugestoes: readonly T[] | undefined,
): T | undefined {
  const maisRecente = sugestoes?.[0];
  if (!maisRecente) return undefined;
  return SEM_NADA_A_OFERECER.has(maisRecente.status) ? undefined : maisRecente;
}

/** O que a tela diz quando a geração falha, e com que código. */
export interface MotivoDaFalha {
  readonly codigo: string;
  /** Em português; quem chama passa pelo `t()` para o idioma de quem lê. */
  readonly texto: string;
  /**
   * `true` quando a causa é conhecida e acionável — quem lê sabe o que fazer.
   * `false` quando caímos no genérico, e aí só o registro no servidor ajuda.
   */
  readonly acionavel: boolean;
}

/**
 * Traduz a exceção de `generateReplyDraft` na frase que quem atende lê.
 *
 * ## O defeito que isto conserta
 *
 * A rota fazia `} catch {` — **sem nome**. A causa era descartada ali mesmo, e
 * três situações sem nada em comum viravam a mesma frase: "Não foi possível
 * gerar a sugestão. Confira a publicação e a configuração do agente."
 *
 * Pior: a tela mostra o identificador da requisição junto, o que faz a mensagem
 * parecer rastreável. Não era — nada tinha sido registrado, em lugar nenhum,
 * então o identificador não levava a nada. Um número que promete e não entrega
 * é pior que nenhum número: manda a pessoa procurar onde não há o que achar.
 *
 * Medido: o dono da instalação levou o erro para o suporte com o identificador
 * em mãos, e não havia como descobrir a causa nem lendo o código — só sabotando
 * cada caminho para ver qual produzia aquela frase.
 *
 * As duas causas nomeadas são as que `generateReplyDraft` lança de propósito;
 * o resto (falha do provedor de IA, tempo esgotado, rede, erro de SQL) cai no
 * genérico — e aí a frase deixa de fingir que sabe, e diz que o motivo ficou
 * registrado.
 */
export function motivoDaFalha(erro: unknown): MotivoDaFalha {
  const marca = erro instanceof Error ? erro.message : String(erro ?? "");
  if (marca === "reply_no_agent")
    return {
      codigo: "reply_no_agent",
      texto:
        "Nenhum agente publicado atende este canal. Publique uma versão do agente em IA › Agentes.",
      acionavel: true,
    };
  if (marca === "reply_context_unavailable")
    return {
      codigo: "reply_context_unavailable",
      texto:
        "Não dá para sugerir nesta conversa: o contato pediu para não receber mensagens, foi anonimizado, ou o histórico não pôde ser lido.",
      acionavel: true,
    };
  return {
    codigo: "reply_unavailable",
    texto:
      "Não foi possível gerar a sugestão. O motivo ficou registrado no servidor com o identificador abaixo.",
    acionavel: false,
  };
}

/**
 * O que a tela diz quando um VETO da prévia barrou a sugestão (issue #2975).
 *
 * O rascunho assistido guarda só o CÓDIGO do primeiro impedimento
 * (`ai_reply_drafts.error_code`, gravado por `reply-drafts.ts` a partir de
 * `result.impediments[0].code`); a frase que o veto carregava morre no servidor.
 * Sem esta tradução, o painel de revisão mostrava a MESMA frase genérica para
 * todos os vetos — de "o contato está descadastrado" a "a janela de 24h
 * fechou" —, e quem atende não tinha como saber o caso nem o que fazer.
 *
 * Os códigos são contrato do motor (`guardrails/before-send.ts`, promessa,
 * afirmação de fato, mídia da prévia). A substância dos textos é a mesma de
 * `lib/inbox/retention-copy.ts`, que traduz os vetos do envio AUTÔNOMO; o
 * formato aqui é outro porque a superfície é outra: lá é um aviso de retenção
 * com título e os knobs do número; aqui é UM rascunho que falhou.
 *
 * `null` para código ausente ou desconhecido — quem chama mantém o texto
 * genérico, que continua verdadeiro.
 */
export function motivoDoVeto(codigo: string | null | undefined): MotivoDaFalha | null {
  switch (codigo) {
    case "contato_bloqueado":
      return {
        codigo,
        acionavel: false,
        texto:
          "O contato pediu para não receber mensagens (opt-out): o envio pelo automático fica bloqueado. Nada a enviar.",
      };
    case "atendimento_com_humano":
      // #3310: NÃO é opt-out. A conversa foi passada para a equipe (ou alguém a
      // pausou à mão) e o contato não pediu para sair — dizer "descadastrado"
      // aqui faz quem atende abandonar um cliente vivo. `acionavel: true`
      // porque há o que fazer, e o texto diz o quê.
      return {
        codigo,
        acionavel: true,
        texto:
          "A conversa está com a equipe: o atendimento automático está pausado. Use “Devolver ao automático” para a IA voltar a responder.",
      };
    case "lgpd_anonymized":
      return {
        codigo,
        acionavel: false,
        texto: "Este contato foi anonimizado (LGPD) — é proibido enviar mensagens a ele.",
      };
    case "lgpd_missing_legal_basis":
      return {
        codigo,
        acionavel: true,
        texto:
          "Não há base legal (LGPD) registrada para o primeiro contato com este lead. O time precisa regularizar o cadastro antes de abordar.",
      };
    case "promise_out_of_table":
      return {
        codigo,
        acionavel: true,
        texto:
          "A resposta prometia um preço ou condição fora da tabela aprovada. Ajuste a tabela de promessas ou gere de novo sem a promessa.",
      };
    case "promise_semantic":
      return {
        codigo,
        acionavel: true,
        texto:
          "A resposta continha uma promessa que o sistema não registrou (ex.: um retorno combinado). Marque o retorno ou gere de novo sem prometer.",
      };
    case "case_promise_without_case":
      return {
        codigo,
        acionavel: true,
        texto:
          "A resposta prometeu voltar a falar com o cliente, mas não deixou o retorno marcado no CRM. Agende o retorno ou gere de novo sem a promessa.",
      };
    case "internal_vocabulary_leak":
      return {
        codigo,
        acionavel: true,
        texto:
          "A resposta usava um termo interno que não pode chegar ao cliente. Gere de novo — se repetir, ajuste o texto do agente.",
      };
    case "clinical_claim":
      return {
        codigo,
        acionavel: true,
        texto:
          "A resposta fazia uma afirmação clínica, e a camada de afirmações clínicas está ligada nesta organização. Gere de novo sem o trecho.",
      };
    case "agenda_stall_sem_ferramenta":
      return {
        codigo,
        acionavel: true,
        texto:
          "A resposta ia depender de horário, mas o agente não tem ferramenta de agenda ligada. Ligue a agenda no agente ou gere de novo sem horário.",
      };
    case "disclosure_required":
      return {
        codigo,
        acionavel: true,
        texto:
          "A primeira mensagem a um contato novo precisa se apresentar como assistente virtual. Ajuste o modelo de apresentação e gere de novo.",
      };
    case "messaging_window_closed":
      return {
        codigo,
        acionavel: true,
        texto:
          "A janela de 24 horas com este contato fechou: o canal recusa texto livre. Responda com um modelo aprovado ou aguarde o contato escrever de novo.",
      };
    case "factual_claim_contradicted":
      return {
        codigo,
        acionavel: true,
        texto:
          "A resposta afirmava um fato que o material de referência CONTRADIZ. Nada foi enviado — confira a base de conhecimento e gere de novo.",
      };
    case "factual_claim_unsupported":
      return {
        codigo,
        acionavel: true,
        texto:
          "A resposta afirmava um fato sem apoio no material de referência. Nada foi enviado — confira a base de conhecimento e gere de novo.",
      };
    case "produto_nao_encontrado":
      return {
        codigo,
        acionavel: true,
        texto:
          "A resposta ia mostrar um produto que não foi encontrado no cadastro. Confira o produto e gere de novo.",
      };
    case "unknown_preview_tool":
      return {
        codigo,
        acionavel: true,
        texto:
          "A sugestão tentou usar uma ação que a prévia não reconhece. Gere de novo; se repetir, revise as ferramentas ligadas no agente.",
      };
    case "generation_failed":
      return {
        codigo,
        acionavel: true,
        texto:
          "A geração da sugestão falhou, ou o contexto da conversa não pôde ser montado. Tente de novo; se repetir, o motivo ficou registrado no servidor.",
      };
    case "max_steps_exhausted":
      return {
        codigo,
        acionavel: true,
        texto:
          "O agente gastou o teto de passos da configuração em consultas e terminou sem propor uma resposta. Nada foi enviado. Gere de novo; se repetir, aumente \"Ações por atendimento\" no agente ou reduza o que ele precisa consultar antes de responder.",
      };
    case "output_truncated":
      return {
        codigo,
        acionavel: true,
        texto:
          "A geração da sugestão foi cortada no limite de tamanho da resposta e parou antes de propor algo. Nada foi enviado ao cliente. Gere de novo; se repetir, reduza o que o agente precisa escrever de uma vez ou aumente o teto de tokens de saída do provedor.",
      };
    case "no_candidate":
      // A prévia terminou sem nenhum send_message aceito e SEM causa de parada
      // (#3093): truncamento, teto de passos e texto solto (este, depois da
      // correção do turno mudo) ganharam código próprio. O que sobra é a
      // DECISÃO — a saudação automática do WhatsApp Business de quem foi
      // abordado (o caso do #3092), ou o agente que só propôs uma ação e não
      // escreveu. Decisão não é defeito: o texto não culpa a configuração e
      // oferece gerar de novo caso a pessoa esperasse uma resposta.
      return {
        codigo,
        acionavel: true,
        texto:
          "O agente decidiu não responder: terminou sem propor uma resposta e sem nenhum impedimento no caminho. Se você esperava uma, gere de novo; senão, não há nada a enviar.",
      };
    default:
      return null;
  }
}

/**
 * Os códigos que `motivoDoVeto` conhece — exportado para o teste varrer TODOS
 * (um case novo sem par no teste deixa de ser silencioso) e para quem quiser
 * medir cobertura.
 */
export const CODIGOS_DE_VETO_CONHECIDOS: readonly string[] = [
  "contato_bloqueado",
  "atendimento_com_humano",
  "lgpd_anonymized",
  "lgpd_missing_legal_basis",
  "promise_out_of_table",
  "promise_semantic",
  "case_promise_without_case",
  "internal_vocabulary_leak",
  "clinical_claim",
  "agenda_stall_sem_ferramenta",
  "disclosure_required",
  "messaging_window_closed",
  "factual_claim_contradicted",
  "factual_claim_unsupported",
  "produto_nao_encontrado",
  "unknown_preview_tool",
  "generation_failed",
  // #3093 — a parada da geração deixou de se chamar `no_candidate`: estes dois
  // são o truncamento (`finish_reason = 'length'`) e o teto de `max_steps`.
  "output_truncated",
  "max_steps_exhausted",
  "no_candidate",
];

/**
 * O rascunho tem algo a OFERECER a quem atende?
 *
 * Decide o estado do `ai_reply_drafts` no fim da prévia (`reply-drafts.ts`), e
 * o defeito que isto conserta é o caso 2 da issue #3093: o rascunho ia para
 * `failed` sempre que o corpo ficava vazio — inclusive quando o agente tinha
 * proposto uma ação e só não escreveu (registrar a proposta, passar para a
 * equipe, etiquetar). O painel então dizia "Não foi possível concluir a
 * sugestão" para um desfecho que deu certo, e a proposta registrada aparecia
 * como falha da geração.
 *
 * `failed` continua sendo o desfecho certo quando NÃO há nada: nem resposta, nem
 * proposta. Aí a frase da tela é a única pista de que a geração não entregou.
 *
 * A regra é a MESMA que o SQL usa (`reply-drafts.ts` passa este booleano como o
 * parâmetro do `case`), para não haver duas versões dela em dois lugares.
 *
 * A proposta sozinha só conta quando o desfecho é a DECISÃO (`no_candidate`, ou
 * nenhum impedimento). Um veto (opt-out, LGPD, janela de 24h), o truncamento ou
 * o teto de passos seguidos de proposta continuam `failed`: o painel só mostra o
 * motivo (`motivoDoVeto`) em `failed`, e em `pending` quem atende veria a lista
 * de propostas sem saber por que não há resposta — o #2975 de volta.
 */
export function temOfertaAoAtendente(
  body: string,
  propostas: readonly unknown[] | null | undefined,
  codigoDoImpedimento: string | null | undefined,
): boolean {
  return (
    body.trim() !== "" ||
    ((propostas?.length ?? 0) > 0 &&
      (codigoDoImpedimento == null || codigoDoImpedimento === "no_candidate"))
  );
}
