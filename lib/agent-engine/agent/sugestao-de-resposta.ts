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
