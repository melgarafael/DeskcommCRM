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
 * - "não quero" sozinho: "não quero pagar caro" e "não quero perder a vaga" são
 *   cliente interessado.
 * - a CONDIÇÃO ("se eu não tiver interesse…", "caso não tenha interesse") e a dupla
 *   negação ("não é que não tenho interesse");
 * - o CONTRASTE que aponta para outra coisa ("não tenho interesse nesse, mas tem
 *   outro?"). O contraste com agradecimento ("não tenho interesse, mas obrigado")
 *   continua sendo recusa;
 * - a PERGUNTA na terceira pessoa ("vocês não têm interesse em…?").
 *
 * O vocabulário fica num arquivo próprio para que mexer nele nunca mude o PARAR.
 */
import { normalizarTexto } from "@/lib/opt-out/deteccao";

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

/** O que vem ANTES e desfaz a recusa: condição e dupla negação. */
const ANTES_QUE_DESFAZ = /(?:\b(?:se|caso|si)\s+(?:eu\s+|yo\s+|a\s+gente\s+)?|\b(?:nao\s+e|no\s+es)\s+que\s+(?:eu\s+|yo\s+)?)$/u;

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

  for (const padrao of FRASES_DE_SEM_INTERESSE) {
    const achado = padrao.exec(normalizado);
    if (!achado) continue;
    const antes = normalizado.slice(0, achado.index);
    if (ANTES_QUE_DESFAZ.test(antes)) continue;

    const depois = normalizado.slice(achado.index + achado[0].length);
    if (CONTRASTE.test(depois) && !CONTRASTE_DE_AGRADECIMENTO.test(depois)) continue;

    // A pergunta só desfaz na terceira pessoa ("vocês não têm interesse em…?"): quem
    // escreve "não tenho interesse, quem te passou meu número?" recusou e perguntou.
    if (/\bnao\s+(?:tem|teria)\b/u.test(achado[0])) {
      const frase = depois.split(/[.!\n]/u)[0] ?? "";
      if (frase.includes("?")) continue;
    }
    return true;
  }
  return false;
}
