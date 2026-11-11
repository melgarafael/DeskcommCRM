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
 * devolvem `texto` — e a ÚLTIMA instrução explícita do turno vence, que é como
 * as pessoas se corrigem ("não consigo ler, mas prefiro texto"). A recusa vale
 * até quando o cliente MANDOU áudio: quem grava "prefiro texto" quer texto.
 *
 * Módulo puro, sem banco e sem rede: a decisão é função do texto do turno.
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
  /\b(?:audio|audios|nota de voz|notas de voz|mensagem de voz|mensagens de voz|resposta falada|mensagem falada|falad[oa]s?|falando|voz|gravacao|gravacoes|em audio|por audio|ouvir|escutar)\b/;

/** A família de construções com que se pede algo a quem responde. */
const VERBO_DE_PEDIDO =
  /\b(?:manda|mandas|mande|mandem|mandar|envia|envie|enviar|grava|grave|gravar|responde|responda|responder|explica|explique|explicar|prefiro|preferia|quero|queria|gostaria|pode|podem|poderia|consegue|conseguem|conseguiria|tem como|seria possivel|e possivel|melhor|da para)\b/;

/**
 * A oração fala do NEGÓCIO, não da resposta: "grava áudio na sua clínica?" é
 * pergunta sobre o atendimento dela, e responder com uma nota de voz não
 * atende a nada.
 */
const ESCOPO_DO_NEGOCIO =
  /\b(?:na sua clinica|no seu consultorio|no consultorio|na clinica|no seu atendimento|no atendimento|na empresa|na loja|no site|no seu negocio|de voces|que voces|voces (?:gravam|fazem|usam|vendem)|nos seus (?:atendimentos|servicos|consultas)|nas consultas|nas ligacoes)\b/;

/** O sujeito é OUTRA pessoa: "o cliente mandou um áudio" não é pedido a nós. */
const OUTRO_SUJEITO =
  /^(?:ele|ela|eles|elas|o cliente|a cliente|o contato|a pessoa|o paciente|a paciente|meu|minha)\b/;

/** Recusa explícita de áudio — vale mais que a menção à palavra. */
const RECUSA_DE_AUDIO = /\b(?:nao|sem)\b[^,]{0,18}\b(?:audio|audios|nota de voz|mensagem de voz)\b/;

/** Quem não pode OUVIR também quer texto (o espelho do caso da issue). */
const NAO_OUVE = /\b(?:nao (?:consigo|posso)|impossivel|nao da)\b[^,]{0,18}\b(?:ouvir|escutar)\b/;

/** Pedido explícito de texto, na mesma construção do pedido de áudio. */
const PEDIDO_DE_TEXTO =
  /\b(?:prefiro|preferia|quero|queria|gostaria|pode|poderia|consegue|conseguiria|manda|mande|envia|envie|responde|responda|melhor|seria melhor|da para|tem como|favor)\b[^,]{0,32}\b(?:texto|textos|escrit[oa]s?|escrever|escrevendo|por escrito|em texto|por texto)\b/;

/** Menção direta ao canal escrito, sem verbo: "por escrito, por favor". */
const MENCAO_AO_TEXTO = /\b(?:por escrito|em texto|por texto|mensagem escrita)\b/;

/** A pessoa diz que não consegue LER — a limitação é do meio, não do documento. */
const NAO_LE =
  /\b(?:nao (?:consigo|sei|posso|estou conseguindo)|dificuldade (?:para|de)|impossivel|sem condicoes de|nao da para)\b[^,]{0,18}\b(?:ler|lendo|enxergar|acompanhar (?:o texto|as mensagens))\b/;

/** Limitação visual declarada, sem o verbo "ler". */
const VISAO_LIMITADA = /\b(?:sou cego|sou cega|tenho baixa visao|baixa visao|deficiencia visual|nao enxergo)\b/;

/** Artigo + palavra, para saber se a incapacidade tem um OBJETO específico. */
const ARTIGO_E_PALAVRA =
  /^(?:o|a|os|as|um|uma|esse|essa|este|esta|aquele|aquela|meu|minha|seu|sua|teu|tua)\s+([a-z0-9]+)/;

/**
 * O que, depois de "não consigo ler", ainda fala do MEIO. "as mensagens" e "o
 * texto" mantêm a leitura; "o boleto" e "a fatura" derrubam.
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

/** A oração pede áudio? Objeto + verbo na mesma oração, e não é assunto de negócio. */
function pedeAudio(oracao: string): boolean {
  if (!OBJETO_DE_AUDIO.test(oracao)) return false;
  if (!VERBO_DE_PEDIDO.test(oracao)) return false;
  if (ESCOPO_DO_NEGOCIO.test(oracao)) return false;
  if (OUTRO_SUJEITO.test(oracao)) return false;
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
  if (PEDIDO_DE_TEXTO.test(oracao) || MENCAO_AO_TEXTO.test(oracao)) return "texto";
  return "nenhum";
}

/**
 * A leitura do turno. `nenhum` = o cliente não falou de canal (o modo novo
 * segue o espelho: áudio dele, áudio nosso; texto dele, texto nosso).
 */
export function lerPedidoDeAudio(texto: string | null | undefined): PedidoDeCanal {
  if (typeof texto !== "string" || texto.trim() === "") return "nenhum";

  let ultimaEscolha: PedidoDeCanal = "nenhum";
  let avisouQueNaoLeEmAlgumaOracao = false;

  for (const oracao of emOracoes(normalizar(texto))) {
    const leitura = lerOracao(oracao);
    // A última instrução explícita de canal vence — é assim que as pessoas se
    // corrigem no mesmo turno ("me manda áudio… ah, pode escrever").
    if (leitura !== "nenhum") ultimaEscolha = leitura;
    else if (avisaQueNaoLe(oracao)) avisouQueNaoLeEmAlgumaOracao = true;
  }

  if (ultimaEscolha !== "nenhum") return ultimaEscolha;
  return avisouQueNaoLeEmAlgumaOracao ? "audio" : "nenhum";
}
