/**
 * O CLIENTE PEDIU PARA OUVIR? — a leitura do turno do `voz_quando='quando_pede'` (#4345).
 *
 * A issue é sobre quem **escreve** pedindo áudio (ou avisa que não consegue ler):
 * até aqui `espelhar` olhava só o CANAL — o cliente mandou áudio? falo em áudio —
 * e essa pessoa recebia texto que não consegue consumir.
 *
 * ## Por que uma leitura, e não uma lista de palavras
 *
 * "áudio", "voz" e "nota de voz" aparecem o tempo todo em frase que NÃO é
 * pedido — "grava áudio na sua clínica?", "o áudio do vídeo ficou ruim", "o
 * cliente mandou um áudio". Casar a palavra ligaria a voz em conversa errada e
 * gastaria a síntese (dinheiro por turno) sem ninguém ter pedido nada.
 *
 * O que esta função lê é a CONSTRUÇÃO do pedido, em duas partes:
 *
 *  1. o OBJETO — o que o cliente quer receber: áudio, nota/mensagem de voz,
 *     a resposta falada, ouvir;
 *  2. o VERBO do pedido dirigido a quem responde — imperativo ("manda",
 *     "grava"), permissão ("pode", "consegue", "tem como"), preferência
 *     ("prefiro", "queria", "gostaria") ou comparação ("melhor").
 *
 * Os dois precisam estar na MESMA oração, e a oração não pode estar falando do
 * negócio ("na sua clínica") nem de outra pessoa ("o cliente mandou"). É essa
 * estrutura — não um dicionário de sinônimos — que separa pedido de assunto.
 *
 * ## Os quatro casos que o autor da issue fixou como critério
 *
 * | frase                                   | leitura |
 * |-----------------------------------------|---------|
 * | "não consigo ler, me manda áudio"       | áudio   |
 * | "não consigo ler o boleto"              | nenhum  |
 * | "grava áudio na sua clínica?"           | nenhum  |
 * | "pode escrever" / "prefiro texto"       | texto   |
 *
 * ## O aviso de que não lê
 *
 * "não consigo ler" sozinho já vale: é a pessoa dizendo que o canal de TEXTO
 * não serve para ela. O que não vale é a incapacidade sobre um documento
 * ("não consigo ler o boleto") — ali o problema é o boleto, não o texto. Por
 * isso a frase só conta quando o que vem depois dela é o MEIO (mensagens,
 * texto, tela, celular) ou nada.
 *
 * ## Quem pede texto
 *
 * "pode escrever", "prefiro texto", "não quero áudio" e "não consigo ouvir"
 * devolvem `texto` — e a ÚLTIMA instrução explícita vence, que é como as pessoas
 * se corrigem ("não consigo ler, mas prefiro texto"). A recusa vale até quando
 * o cliente MANDOU áudio: quem grava "prefiro texto" quer texto.
 *
 * ## A CONVERSA, não só o turno (o arremate do #4345)
 *
 * O pedido não morre na mensagem seguinte. Quem escreve "não sei ler, manda
 * áudio" e depois "e quanto custa?" precisa continuar ouvindo: a segunda
 * mensagem não fala de canal nenhum, e ler só ela devolveria texto justamente
 * para a pessoa para quem o modo existe. Por isso a função aceita a LISTA de
 * textos do cliente — do mais antigo ao mais recente — e o pedido explícito
 * MAIS RECENTE vence. Um "prefiro texto"/"pode escrever"/"não consigo ouvir"
 * posterior DERRUBA o pedido.
 *
 * A janela é a que o turno já carrega (`openingContext.context.messages`):
 * nada de consulta nova ao banco. O recorte e a ordem ficam em
 * `textosDoClienteNoHistorico`, que também é pura — I/O só no turno.
 *
 * Módulo puro, sem banco e sem rede: a decisão é função dos textos do cliente.
 */

/** O que o cliente pediu para o canal da RESPOSTA. */
export type PedidoDeCanal = "audio" | "texto" | "nenhum";

/** Sem acento e em caixa baixa: o cliente escreve "áudio", "audio" e "ÁUDIO". */
function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\bvc\b/g, "voce")
    // "pra" vira "para" para uma grafia só ("da pra" ⇒ "da para").
    .replace(/\bpra\b/g, "para")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Quebra o turno em orações. O pedido mora numa oração: "não consigo ler, me
 * manda áudio" são dois fatos, e o segundo é o que decide.
 */
const CORTE_DE_ORACAO = /\s*(?:[.!?;:,]|\bmas\b|\bporem\b|\bso que\b|\bcontudo\b|\bentretanto\b)\s*/;

function emOracoes(texto: string): string[] {
  return texto
    .split(CORTE_DE_ORACAO)
    .map((parte) => parte.trim())
    .filter((parte) => parte !== "");
}

/** O que o cliente quer RECEBER — o objeto do pedido. */
const OBJETO_DE_AUDIO =
  /\b(?:audio|audios|audiozinh[oa]s?|nota de voz|notas de voz|mensagem de voz|mensagens de voz|resposta falada|mensagem falada|falad[oa]s?|falando|voz|gravacao|gravacoes|em audio|por audio|ouvir|escutar)\b/;

/** A família de construções com que se pede algo a quem responde. */
const VERBO_DE_PEDIDO =
  /\b(?:manda|mandas|mande|mandem|mandar|envia|envie|enviar|grava|grave|gravar|fala|fale|falar|responde|responda|responder|explica|explique|explicar|prefiro|preferia|quero|queria|gostaria|pode|podem|poderia|consegue|conseguem|conseguiria|tem como|seria possivel|e possivel|melhor|da para)\b/;

/**
 * A oração fala do NEGÓCIO, não da resposta: "grava áudio na sua clínica?" é
 * pergunta sobre o atendimento dela, e responder com uma nota de voz não
 * atende a nada. "quero marcar consulta pra ouvir o resultado do exame" é o
 * mesmo caso com outro verbo: o "ouvir" é do exame, não da nossa resposta.
 */
const ESCOPO_DO_NEGOCIO =
  /\b(?:na sua clinica|no seu consultorio|no consultorio|na clinica|no seu atendimento|no atendimento|na empresa|na loja|no site|no seu negocio|de voces|que voces|voces (?:gravam|fazem|usam|vendem)|nos seus (?:atendimentos|servicos|consultas)|nas consultas|nas ligacoes|marcar (?:uma )?(?:consulta|reavaliacao|retorno)|agendar (?:uma )?(?:consulta|reavaliacao|retorno)|resultado d[oa] exame|resultado de exame)\b/;

/**
 * O cliente é quem vai mandar o áudio, então não é pedido: "vou te mandar um
 * áudio" e "posso mandar um áudio?" falam do que ELE fará, não do que nós
 * devemos responder.
 */
const CLIENTE_E_QUEM_ENVIA =
  /\b(?:vou|vamos|irei|pretendo|deixa eu|posso)\b[^,]{0,24}\b(?:mandar|mando|enviar|envio|gravar|gravo)\b/;

/**
 * O áudio é do CLIENTE ("consegue ouvir meu áudio?"): a pergunta é se ele
 * chegou, não um pedido para a resposta sair falada.
 */
const AUDIO_DO_CLIENTE = /\b(?:meu|minha|meus|minhas)\s+(?:audio|audios|audiozinh[oa]s?|nota de voz|mensagem de voz|gravacao|gravacoes)\b/;

/** O sujeito é OUTRA pessoa: "o cliente mandou um áudio" não é pedido a nós. */
const OUTRO_SUJEITO =
  /^(?:ele|ela|eles|elas|o cliente|a cliente|o contato|a pessoa|o paciente|a paciente|meu|minha)\b/;

/** Recusa explícita de áudio — vale mais que a menção à palavra. */
const RECUSA_DE_AUDIO = /\b(?:nao|sem)\b[^,]{0,18}\b(?:audio|audios|nota de voz|mensagem de voz)\b/;

/** Quem não pode OUVIR também quer texto (o espelho do caso da issue). */
const NAO_OUVE =
  /\b(?:nao (?:consigo|posso|estou conseguindo|estou podendo)|impossivel|nao da)\b[^,]{0,18}\b(?:ouvir|escutar)\b/;

/** Pedido explícito de texto, na mesma construção do pedido de áudio. */
const PEDIDO_DE_TEXTO =
  /\b(?:prefiro|preferia|quero|queria|gostaria|pode|poderia|consegue|conseguiria|manda|mande|envia|envie|responde|responda|melhor|seria melhor|da para|tem como|favor)\b[^,]{0,32}\b(?:texto|textos|escrit[oa]s?|escrever|escrevendo|por escrito|em texto|por texto)\b/;

/**
 * O imperativo do canal escrito: "não estou conseguindo ouvir agora, escreve".
 * Ancorado no começo da oração para não pegar a 3ª pessoa ("ela escreve bem"),
 * que fala de outra pessoa, não do canal.
 */
const IMPERATIVO_DE_TEXTO = /^(?:(?:e|so|por favor)\s+)?(?:escreve|escreva|escrevam|digita|digite|digitam)\b/;

/** Menção direta ao canal escrito, sem verbo: "por escrito, por favor". */
const MENCAO_AO_TEXTO = /\b(?:por escrito|em texto|por texto|mensagem escrita)\b/;

/** A pessoa diz que não consegue LER — a limitação é do meio, não do documento. */
const NAO_LE =
  /\b(?:nao (?:consigo|sei|posso|estou conseguindo)|dificuldade (?:para|de)|impossivel|sem condicoes de|nao da para)\b[^,]{0,18}\b(?:ler|lendo|enxergar|acompanhar (?:o texto|as mensagens))\b/;

/** Limitação visual declarada, sem o verbo "ler". */
const VISAO_LIMITADA =
  /\b(?:sou cego|sou cega|tenho baixa visao|baixa visao|deficiencia visual|nao enxergo|sou analfabet[oa]|somos analfabet[oa]s|analfabet[oa] funcional)\b/;

/** Artigo + palavra, para saber se a incapacidade tem um OBJETO específico. */
const ARTIGO_E_PALAVRA =
  /^(?:o|a|os|as|um|uma|esse|essa|este|esta|aquele|aquela|meu|minha|seu|sua|teu|tua)\s+([a-z0-9]+)/;

/**
 * O que, depois de "não consigo ler", ainda fala do MEIO. "as mensagens", "o
 * texto" e "essa letra pequena" mantêm a leitura; "o boleto" e "a fatura"
 * derrubam — ali o problema é o documento, não o canal.
 */
const PALAVRAS_DO_MEIO = new Set([
  "texto",
  "textos",
  "mensagem",
  "mensagens",
  "conversa",
  "conversas",
  "audio",
  "audios",
  "voz",
  "celular",
  "telefone",
  "tela",
  "aparelho",
  "letra",
  "letras",
  "fonte",
  "tamanho",
  "whatsapp",
  "aqui",
  "isso",
  "isto",
  "nada",
  "tudo",
  "coisa",
  "coisas",
  "que",
  "direito",
  "bem",
  "nada",
]);

/** A oração pede áudio? Objeto + verbo na mesma oração, e não é assunto de negócio nem áudio do próprio cliente. */
function pedeAudio(oracao: string): boolean {
  if (!OBJETO_DE_AUDIO.test(oracao)) return false;
  if (!VERBO_DE_PEDIDO.test(oracao)) return false;
  if (ESCOPO_DO_NEGOCIO.test(oracao)) return false;
  if (OUTRO_SUJEITO.test(oracao)) return false;
  if (CLIENTE_E_QUEM_ENVIA.test(oracao)) return false;
  if (AUDIO_DO_CLIENTE.test(oracao)) return false;
  return true;
}

/**
 * A oração avisa que a pessoa não consegue ler, e a limitação é do MEIO?
 * Só vale quando o que vem depois de "não consigo ler" não é um objeto
 * específico — senão "não consigo ler o boleto" viraria pedido de voz.
 */
function avisaQueNaoLe(oracao: string): boolean {
  const achado = NAO_LE.exec(oracao) ?? VISAO_LIMITADA.exec(oracao);
  if (achado === null) return false;
  const depois = oracao.slice(achado.index + achado[0].length).trim();
  if (depois === "") return true;
  const objeto = ARTIGO_E_PALAVRA.exec(depois);
  if (objeto !== null && !PALAVRAS_DO_MEIO.has(objeto[1] ?? "")) return false;
  return true;
}

/** A leitura de UMA oração — a ordem aqui é a precedência dentro da oração. */
function lerOracao(oracao: string): PedidoDeCanal {
  // Recusa vale mais que a palavra "áudio" solta: "não manda áudio, manda texto".
  if (RECUSA_DE_AUDIO.test(oracao) || NAO_OUVE.test(oracao)) return "texto";
  if (pedeAudio(oracao)) return "audio";
  if (PEDIDO_DE_TEXTO.test(oracao) || MENCAO_AO_TEXTO.test(oracao) || IMPERATIVO_DE_TEXTO.test(oracao)) {
    return "texto";
  }
  return "nenhum";
}

/** Uma mensagem do histórico, no mínimo que a leitura precisa. */
export interface MensagemDoHistorico {
  direction: "inbound" | "outbound";
  body: string | null;
}

/**
 * Quantas mensagens do cliente entram na leitura. O pedido vale enquanto ele
 * couber na janela que o turno já carrega — a issue registra que ele deixa de
 * valer quando sai do histórico, e não se guarda preferência no contato.
 */
export const JANELA_DE_PEDIDOS = 20;

/**
 * Os textos do CLIENTE na conversa, do mais antigo ao mais recente — só o
 * recorte, sem decisão.
 *
 * `atual` é o `currentInboundText` do turno: ele pode não estar na lista (prévia,
 * rajada coalescida, follow-up). Quando não for a última mensagem do cliente, é
 * anexado como a mais recente — o que o cliente acabou de escrever nunca perde
 * para o histórico.
 */
export function textosDoClienteNoHistorico(
  mensagens: readonly MensagemDoHistorico[],
  atual?: string | null,
  limite: number = JANELA_DE_PEDIDOS,
): string[] {
  const textos: string[] = [];
  for (let i = mensagens.length - 1; i >= 0 && textos.length < limite; i -= 1) {
    const m = mensagens[i];
    if (m === undefined || m.direction !== "inbound") continue;
    const corpo = typeof m.body === "string" ? m.body.trim() : "";
    if (corpo !== "") textos.unshift(corpo);
  }
  const agora = typeof atual === "string" ? atual.trim() : "";
  if (agora !== "" && textos[textos.length - 1] !== agora) textos.push(agora);
  return textos;
}

/**
 * A leitura da CONVERSA. Aceita um texto (o caso de uma mensagem) ou a lista
 * dos textos do cliente em ordem — do mais antigo ao mais recente — como
 * `textosDoClienteNoHistorico` devolve. `nenhum` = o cliente não falou de
 * canal (o modo novo segue o espelho: áudio dele, áudio nosso; texto dele,
 * texto nosso).
 *
 * A decisão é a ÚLTIMA coisa dita sobre o canal em toda a janela: o pedido mais
 * recente vence, e uma correção posterior ("prefiro texto") derruba o pedido
 * anterior — o mesmo critério que já valia dentro de uma mensagem, agora entre
 * mensagens.
 */
export function lerPedidoDeAudio(
  entrada: string | null | undefined | readonly (string | null | undefined)[],
): PedidoDeCanal {
  const textos = typeof entrada === "string" || entrada === null || entrada === undefined ? [entrada] : entrada;

  let ultimaEscolha: PedidoDeCanal = "nenhum";
  for (const texto of textos) {
    if (typeof texto !== "string" || texto.trim() === "") continue;
    for (const oracao of emOracoes(normalizar(texto))) {
      const leitura = lerOracao(oracao);
      // A última instrução de canal vence — é assim que as pessoas se corrigem
      // ("me manda áudio… ah, pode escrever"), na mensagem e entre mensagens.
      if (leitura !== "nenhum") ultimaEscolha = leitura;
      // "não consigo ler" é a mesma escolha, dita pelo outro lado: vale no ponto
      // em que aparece, e um "prefiro texto" posterior também a derruba.
      else if (avisaQueNaoLe(oracao)) ultimaEscolha = "audio";
    }
  }
  return ultimaEscolha;
}

