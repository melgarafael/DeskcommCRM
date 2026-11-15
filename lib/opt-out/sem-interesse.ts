/**
 * "NÃO TENHO INTERESSE" — a frase, reconhecida num lugar só.
 *
 * ═══ Por que este arquivo NÃO é `deteccao.ts` ═══
 *
 * `lib/opt-out/deteccao.ts` decide o PARAR: o que grava `is_blocked`, um estado que
 * corta toda mensagem para a pessoa, inclusive a resposta da equipe. "Não tenho
 * interesse" é outra coisa, e misturar as duas listas transformaria a objeção mais
 * comum de uma venda em bloqueio total. Aqui a frase só alimenta uma RECUSA DE
 * MARKETING (`contacts.consent.marketing`, lida por `recusaRegistrada`): a pessoa sai
 * da prospecção e das Campanhas, e continua podendo conversar com a equipe.
 *
 * ═══ Quem usa, e onde ═══
 *
 * Só a conversa de PROSPECÇÃO (`conversations.metadata.prospecting_campaign_id`,
 * em `lib/channels/pos-entrada.ts`). Fora dela, a mesma frase não grava nada: num
 * atendimento comum, "não tenho interesse nesse plano" é cliente escolhendo, não
 * pedindo para sair. A regra do dono é sobre abordagem fria.
 *
 * ═══ O que fica de fora, de propósito ═══
 *
 * A régua erra para o lado de NÃO gravar. O falso positivo fecha como Perdido, sem
 * ninguém ver, o negócio de quem estava comprando; o falso negativo só deixa o "não"
 * para a equipe registrar pelo botão da ficha ou da conversa.
 *
 * - "não quero" sozinho: "não quero pagar caro" e "não quero perder a vaga" são
 *   cliente interessado.
 * - a CONDIÇÃO ("se eu não tiver interesse…", "se for caro, não tenho interesse") e a
 *   dupla negação ("não é que não tenho interesse");
 * - a NEGAÇÃO CITADA ("quem disse que não tenho interesse?", "eu não disse que não
 *   tenho interesse");
 * - o COMPLEMENTO que escolhe ("não tenho interesse no plano mensal", "não me
 *   interessa o preço"). Só vale o complemento que aponta para a oferta inteira
 *   ("nisso", "no serviço de vocês", "em contratar");
 * - o SINAL DE INTERESSE em qualquer ponto da mensagem ("quero", "quanto fica", "me
 *   manda o preço", "claro que");
 * - o CONTRASTE que aponta para outra coisa ("não tenho interesse nesse, mas tem
 *   outro?"). O contraste com agradecimento ("não tenho interesse, mas obrigado")
 *   continua sendo recusa;
 * - a PERGUNTA, em qualquer pessoa ("não tenho interesse? claro que tenho!",
 *   "vocês não têm interesse em…?"). A única pergunta que acompanha a recusa é a da
 *   origem do número ("não tenho interesse, quem te passou meu número?").
 *
 * O vocabulário fica num arquivo próprio para que mexer nele nunca mude o PARAR.
 */
import { ehPedidoDeOptOut, normalizarTexto } from "@/lib/opt-out/deteccao";

/** As formas da recusa, sobre o texto normalizado (minúsculas, sem acento). */
const FRASES_DE_SEM_INTERESSE: readonly RegExp[] = [
  // "não tenho interesse", "não temos mais interesse", "não tenho nenhum interesse"
  /\bnao\s+(?:tenho|temos)\s+(?:mais\s+)?(?:nenhum\s+)?interesse\b/u,
  // "aqui não tem interesse", "a empresa não tem interesse" (a pergunta sai abaixo)
  /\bnao\s+(?:tem|teria)\s+(?:mais\s+)?(?:nenhum\s+)?interesse\b/u,
  // "não me interessa", "não nos interessa"
  /\bnao\s+(?:me|nos)\s+interessa\b/u,
  // "não estou interessado", "não tô interessada", "não estamos interessados"
  /\bnao\s+(?:estou|to|tou|estamos|sou)\s+(?:mais\s+)?interessad[oa]s?\b/u,
  // "estou sem interesse", e a mensagem que começa com "sem interesse"
  /\b(?:estou|to|tou|estamos)\s+sem\s+interesse\b/u,
  /^\W*sem\s+interesse\b/u,
  // espanhol
  /\bno\s+(?:tengo|tenemos)\s+(?:mas\s+)?(?:ningun\s+)?interes\b/u,
  /\bno\s+(?:me|nos)\s+interesa\b/u,
  /\bno\s+(?:estoy|estamos)\s+interesad[oa]s?\b/u,
];

/** O que vem COLADO antes e desfaz a recusa: condição, dupla negação e negação citada. */
const ANTES_QUE_DESFAZ = new RegExp(
  "(?:" +
  [
    // condição: "se eu não tenho interesse", "caso não tenha"
    String.raw`\b(?:se|caso|si)\s+(?:eu\s+|yo\s+|a\s+gente\s+)?`,
    // dupla negação: "não é que não tenho interesse"
    String.raw`\b(?:nao\s+e|no\s+es)\s+que\s+(?:eu\s+|yo\s+)?`,
    // negação citada: "quem disse que", "eu não disse que", "você acha que"
    String.raw`\b(?:quem\s+(?:te\s+|lhe\s+)?(?:disse|falou)|(?:nao|nunca)\s+(?:disse|falei|falou)|acha|acham|achou|pensa|pensam|pensou|quien\s+dijo|(?:no|nunca)\s+dije)\s+que\s+(?:eu\s+|yo\s+|a\s+gente\s+|nos\s+)?`,
  ]
    .map((p) => `(?:${p})`)
    .join("|") +
    ")$",
  "u",
);

/** A condição na mesma oração, antes da frase: "se for caro, não tenho interesse". */
const CONDICAO_NA_ORACAO =
  /\b(?:se|caso|si)\s+(?:for|forem|fosse|tiver|tivesse|custar|der|precisar|eu|a\s+gente|nao|es|fuera)\b[^.!?\n]*$/u;

/** O tempo da recusa não é complemento: "não tenho interesse no momento". */
const TEMPO_DA_RECUSA =
  /^\s*(?:mais\s+)?(?:no\s+momento|neste\s+momento|nesse\s+momento|por\s+enquanto|por\s+ora|agora|hoje|ainda|en\s+este\s+momento|por\s+ahora|ahora)\b/u;

/** Um complemento logo depois da frase: o QUE não interessa. */
const COMPLEMENTO =
  /^\s*(?:em|no|na|nos|nas|num|numa|nesse|nessa|neste|nesta|nesses|nessas|nisso|nisto|o|a|os|as|de|do|da|dos|das|desse|dessa|disso|disto|pelo|pela|por|pra|para|en|el|la|los|las|lo|ese|esa|eso|esto|esta|este|se|caso|si)\b/u;

/** O complemento que aponta para a oferta INTEIRA, não para uma escolha dentro dela. */
const COMPLEMENTO_DA_OFERTA = new RegExp(
  "^\\s*(?:" +
    [
      String.raw`(?:em\s+)?(?:nisso|nisto|disso|disto|nada|nenhum[a]?)\b`,
      String.raw`(?:no|na|nos|nas|do|da|dos|das|pelo|pela)\s+(?:(?:seu|sua|seus|suas|teu|tua|vosso)\s+)?(?:servicos?|produtos?|propostas?|ofertas?|trabalhos?|assunto|contato)\b`,
      String.raw`(?:nesse|nessa|neste|nesta|desse|dessa|deste|desta)\s+(?:servico|produto|proposta|oferta|assunto|tipo\s+de\s+servico)\b`,
      String.raw`em\s+(?:contratar|conhecer|saber\s+mais|receber|ouvir|falar|conversar|participar)\b`,
      String.raw`en\s+(?:eso|esto|nada)\b`,
      String.raw`(?:eso|esto)\b`,
    ].join("|") +
    ")",
  "u",
);

/** Sinal de que a pessoa quer comprar, em qualquer ponto da mensagem. */
const SINAL_DE_INTERESSE = new RegExp(
  String.raw`\b(?:` +
    [
      "quero|queria|gostaria|prefiro|preferia|quiero|quisiera|prefiero",
      String.raw`me\s+(?:manda|mande|passa|passe|envia|envie|fala|diz)`,
      String.raw`quanto|quantos|cuanto|qual\s+(?:o|a|e|seria|sao)|cual`,
      "precos?|valor|valores|orcamento|precio|presupuesto",
      String.raw`claro\s+que|tem\s+(?:outr[oa]s?|algum[a]?)|vou\s+(?:querer|pagar|levar|fechar|contratar|pegar|ficar)`,
    ].join("|") +
    String.raw`)\b`,
  "u",
);

/** "não quero" é recusa, não sinal de interesse: sai antes de procurar o sinal. */
const NEGACAO_DO_QUERER = /\b(?:nao|no)\s+(?:quero|queria|gostaria|quiero|quisiera)\b/gu;

/** A pergunta que acompanha a recusa: de onde veio o número. */
const PERGUNTA_DA_ORIGEM =
  /\b(?:quem\s+(?:te\s+|lhe\s+|vos\s+)?(?:passou|deu|indicou|forneceu)|de\s+onde|como\s+(?:voce|vc|voces|vcs)\s+(?:conseguiu|conseguiram|pegou|pegaram|achou|tem|teve)|onde\s+(?:voce|vc|voces|vcs)\s+(?:conseguiu|pegou|achou)|quien\s+te\s+(?:dio|paso)|de\s+donde)\b[^?]*\b(?:numero|contato|telefone|whats(?:app)?|zap)\b/u;

/** O contraste que aponta para outra oferta. */
const CONTRASTE = /\b(?:mas|porem|so\s+que|contudo|entretanto|pero|sino)\b/u;
/** O contraste que só agradece não desfaz a recusa. */
const CONTRASTE_DE_AGRADECIMENTO =
  /\b(?:mas|porem|pero)\s+(?:muito\s+|muchas\s+)?(?:obrigad[oa]s?|valeu|agradeco|grat[oa]|gracias|brigad[oa])\b/u;

/**
 * A mensagem diz que a pessoa não tem interesse?
 *
 * Só a frase: QUEM decide o que fazer com ela (e em que conversa) é quem chama.
 */
export function ehFraseDeSemInteresse(texto: string | null | undefined): boolean {
  if (!texto) return false;
  const normalizado = normalizarTexto(texto).replace(/\s+/gu, " ").trim();
  if (!normalizado) return false;

  // O sinal de interesse vale em qualquer ponto: "quero o anual. não tenho interesse no
  // mensal" é escolha, não recusa.
  if (SINAL_DE_INTERESSE.test(normalizado.replace(NEGACAO_DO_QUERER, " "))) return false;

  for (const padrao of FRASES_DE_SEM_INTERESSE) {
    const achado = padrao.exec(normalizado);
    if (!achado) continue;
    const antes = normalizado.slice(0, achado.index);
    if (ANTES_QUE_DESFAZ.test(antes) || CONDICAO_NA_ORACAO.test(antes)) continue;

    const depois = normalizado.slice(achado.index + achado[0].length);
    if (CONTRASTE.test(depois) && !CONTRASTE_DE_AGRADECIMENTO.test(depois)) continue;

    // A pergunta, em qualquer pessoa, desfaz — menos a da origem do número.
    if (depois.includes("?") && !PERGUNTA_DA_ORIGEM.test(depois)) continue;

    // O complemento decide: o tempo ("no momento") não é complemento; o que aponta para
    // a oferta inteira ("nisso", "no serviço") é recusa; qualquer outro é escolha.
    const semTempo = depois.replace(TEMPO_DA_RECUSA, "");
    if (COMPLEMENTO.test(semTempo) && !COMPLEMENTO_DA_OFERTA.test(semTempo)) continue;
    return true;
  }
  return false;
}

/**
 * ADIAMENTO NÃO É RECUSA (decisão do dono, 15/11, doc 360 · 2A).
 *
 * "Não tenho interesse agora, me chama mês que vem" pede para voltar depois: gravar
 * recusa permanente e mandar o negócio para Perdido perdia a venda que o cliente
 * acabou de marcar para o mês seguinte. Com um marcador de tempo, a frase vira
 * TAREFA para o vendedor retomar (`lib/prospecting/resposta-da-prospeccao.ts`).
 *
 * "agora" sozinho é ambíguo ("não tenho interesse, agora me tira da lista"): ele só
 * conta colado à recusa ("interesse agora") ou como "agora não".
 */
const MARCADOR_DE_ADIAMENTO = new RegExp(
  String.raw`\b(?:` +
    [
      String.raw`por\s+(?:enquanto|ora|agora|ahora)`,
      String.raw`(?:no|neste|nesse|de|en\s+este)\s+momento`,
      String.raw`(?:mes|semana|ano)\s+que\s+(?:vem|viene)`,
      String.raw`(?:proximo|proxima)\s+(?:mes|semana|ano)`,
      String.raw`mais\s+(?:pra|para)\s+frente|mais\s+adiante|mais\s+tarde|mas\s+adelante|mas\s+tarde`,
      String.raw`(?:talvez|quem\s+sabe|tal\s+vez|quizas?)\s+(?:depois|despues|mais\s+tarde|no\s+futuro|futuramente)`,
      String.raw`futuramente|no\s+futuro|outra\s+hora|outro\s+momento|otro\s+momento`,
      String.raw`interess(?:e|a|ad[oa]s?)\s+agora|interes\s+ahora|agora\s+nao|ahora\s+no`,
    ].join("|") +
    String.raw`)\b`,
  "u",
);

/** O "não" que fecha a porta para o futuro também: "nem agora nem nunca". */
const RECUSA_DEFINITIVA =
  /\b(?:nunca|jamais|jamas|nem\s+agora|nem\s+depois|ni\s+ahora|de\s+jeito\s+nenhum|em\s+hipotese\s+alguma)\b/u;

/** O "não" de agora sem a frase do interesse: "agora não, me chama mês que vem". */
const NAO_DE_AGORA = /\b(?:agora|ahora|por\s+enquanto|no\s+momento|neste\s+momento)\s+(?:nao|no)\b/u;

export type RespostaDeSemInteresse = "recusa" | "adiamento";

/**
 * Recusa, adiamento, ou nada. Pedido de saída (`ehPedidoDeOptOut`) nunca é adiamento:
 * "não tenho interesse, agora me tira da lista" é o PARAR, que tem regra própria.
 */
export function classificarSemInteresse(texto: string | null | undefined): RespostaDeSemInteresse | null {
  if (!texto) return null;
  const normalizado = normalizarTexto(texto).replace(/\s+/gu, " ").trim();
  const podeSerAdiamento = !RECUSA_DEFINITIVA.test(normalizado) && !ehPedidoDeOptOut(texto);
  if (ehFraseDeSemInteresse(texto))
    return podeSerAdiamento && MARCADOR_DE_ADIAMENTO.test(normalizado) ? "adiamento" : "recusa";
  // Sem a frase, "agora não" sozinho é conversa ("agora não posso falar"): só vira
  // adiamento quando a mensagem também diz QUANDO voltar.
  if (!podeSerAdiamento || !NAO_DE_AGORA.test(normalizado)) return null;
  return MARCADOR_DE_ADIAMENTO.test(normalizado.replace(NAO_DE_AGORA, " ")) ? "adiamento" : null;
}
