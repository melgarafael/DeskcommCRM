import { PALAVRAS_DE_OPT_OUT, normalizarTexto } from "@/lib/opt-out/deteccao";

/**
 * A SAÍDA, escrita na primeira mensagem fria.
 *
 * ## Por que isto existe
 *
 * A abordagem de prospecção chega a quem nunca falou com a empresa. Sem uma
 * saída oferecida, a saída que a pessoa usa é **Denunciar spam** — e essa é
 * invisível ao sistema: não gera mensagem de volta, `is_blocked` nunca é
 * gravado, o candidato fica `sent`, e o número queimado é o do CLIENTE que
 * instalou, não o nosso. A doutrina anti-banimento inteira do produto existe
 * para evitar exatamente esse desfecho.
 *
 * Havia uma ironia no código antes disto: `agent-setup.ts` manda o agente
 * RESPEITAR quem pedir para parar. Ninguém pede uma saída que nunca lhe foi
 * oferecida.
 *
 * ## Por que determinístico, e não escrito pelo modelo
 *
 * Duas razões, e as duas são de produção:
 *
 *   1. O texto do modelo varia com temperatura. Uma promessa legal que muda de
 *      redação a cada envio não é auditável — e é a mesma família do erro de
 *      pedir ao modelo que produza um identificador estável.
 *   2. A regra de opt-out deste produto é **ISOLADA**: ela só bloqueia palavra
 *      sozinha (a mensagem inteira é a palavra) ou verbo com objeto de
 *      comunicação. Um rodapé que dissesse "é só me avisar" não seria
 *      reconhecido por `lib/opt-out/deteccao.ts`, e a pessoa teria pedido para
 *      sair sem sair. O rodapé instrui **a resposta exata que o detector
 *      reconhece**.
 *
 * ## O laço fechado
 *
 * A palavra usada aqui é verificada contra `PALAVRAS_DE_OPT_OUT` em tempo de
 * execução, não por convenção: se alguém remover `parar` do detector, este
 * módulo deixa de prometer uma saída que não funciona mais.
 */

/** A palavra que a pessoa responde, por idioma. */
const PALAVRA_POR_IDIOMA: Record<string, string> = {
  pt: "PARAR",
  // Medido no próprio detector: em espanhol a palavra que as plantillas
  // aprovadas pedem é BAJA, e ela está no conjunto por causa disso.
  es: "BAJA",
  en: "STOP",
};

const TEXTO_POR_IDIOMA: Record<string, (palavra: string) => string> = {
  pt: (p) => `Se não quiser mais receber mensagens, responda ${p}.`,
  es: (p) => `Si no quieres recibir más mensajes, responde ${p}.`,
  en: (p) => `If you'd rather not receive these messages, reply ${p}.`,
};

function raiz(locale: string | null | undefined): string {
  const r = (locale ?? "").toLowerCase().split(/[-_]/)[0] ?? "";
  // Idioma desconhecido cai em português — o padrão do produto — em vez de
  // ficar sem rodapé. Não oferecer saída é o defeito que este módulo conserta.
  return r in TEXTO_POR_IDIOMA ? r : "pt";
}

/**
 * A palavra de saída para este idioma, garantida como reconhecível.
 *
 * Se o detector deixar de reconhecê-la, isto LANÇA em vez de mandar uma
 * promessa falsa: prometer uma saída que não funciona é pior que não prometer,
 * porque a pessoa responde, nada acontece, e ela conclui que foi ignorada.
 */
export function palavraDeSaida(locale?: string | null): string {
  const idioma = raiz(locale);
  const palavra = PALAVRA_POR_IDIOMA[idioma] ?? "PARAR";
  if (!PALAVRAS_DE_OPT_OUT.has(palavra.toLowerCase())) {
    throw new Error(
      `A palavra de saída "${palavra}" não é reconhecida por lib/opt-out/deteccao.ts. ` +
        "Oferecer uma saída que o detector não entende faz a pessoa pedir para sair e continuar recebendo.",
    );
  }
  return palavra;
}

/** O rodapé pronto, sem quebra de linha inicial. */
export function rodapeDeSaida(locale?: string | null): string {
  const idioma = raiz(locale);
  const monta = TEXTO_POR_IDIOMA[idioma] ?? TEXTO_POR_IDIOMA.pt!;
  return monta(palavraDeSaida(locale));
}

/**
 * ─── O TEXTO PRÓPRIO DA CAMPANHA (#4370) ─────────────────────────────────────
 *
 * O dono da campanha pode escrever a saída dele em `config.texto_da_saida`. O
 * que NÃO muda, e é a razão de este módulo existir:
 *
 *   - o texto continua vindo da CONFIGURAÇÃO, nunca do modelo: mesma redação em
 *     todos os envios, auditável (ver o cabeçalho, item 1);
 *   - ele continua tendo de conter a palavra que `lib/opt-out/deteccao.ts`
 *     reconhece SOZINHA, no idioma da instalação — "é só me avisar" é simpático e
 *     não é detectado; a pessoa pediria para sair e seguiria recebendo;
 *   - e ela tem de estar LEGÍVEL: riscada (`~PARAR~`), atrás de spoiler ou dentro
 *     de código, a palavra está no texto e some na tela — a pessoa não copia o
 *     que o canal desenha como apagado. Ver `MARCACAO_QUE_ESCONDE`;
 *   - vazio = a frase padrão de sempre, byte por byte: quem não mexer não vê
 *     diferença.
 *
 * As funções abaixo separam "este texto serve?" (validação) de "qual texto sai?"
 * (envio). A segunda NUNCA devolve um texto que a primeira recusaria: se a
 * configuração chegar inválida (gravada por fora, idioma da organização mudou
 * depois), o envio cai na frase padrão em vez de prometer uma saída que não
 * funciona. Oferecer saída quebrada é pior que oferecer a de sempre.
 */

/**
 * Teto do texto próprio. 160 é o número do pedido: a saída é um parágrafo curto
 * no fim de uma abordagem fria, não um segundo argumento de venda — e ela entra
 * numa bolha que já foi fatiada.
 */
export const TAMANHO_MAXIMO_DO_TEXTO_DA_SAIDA = 160;

/** Por que o texto do dono não pode ser usado; `null` quando pode. */
export type ProblemaDoTextoDaSaida = "longo" | "link" | "sem_palavra" | "palavra_escondida";

/**
 * Link dentro da saída não passa. A saída existe para a pessoa ter como SAIR, não
 * para levar tráfego; num texto que já nasce com cara de disparo, um endereço é o
 * que mais parece spam — e o número queimado é o do cliente que instalou.
 */
const LINK_NO_TEXTO = /(?:https?:\/\/|www\.|\b[\w-]+\.(?:com|com\.br|net|org|io|app|link)\b)/iu;

/** A palavra aparece como palavra no texto (minúscula, sem acento — a régua do detector). */
function contemPalavra(texto: string, palavra: string): boolean {
  return new RegExp(`\\b${normalizarTexto(palavra)}\\b`, "u").test(normalizarTexto(texto));
}

/**
 * ─── A PALAVRA QUE ESTÁ LÁ, MAS NÃO SE LÊ ───────────────────────────────────
 *
 * A régua de `contemPalavra` olha o texto CRU: `~PARAR~` tem a palavra, e passa.
 * No aparelho, `~…~` é riscado no WhatsApp, `||…||` é spoiler e o que está entre
 * crases sai como código — o dono escreve "responda ~PARAR~", a campanha inicia,
 * e a instrução que chega pede para a pessoa responder algo que o cliente do
 * canal desenha como APAGADO (ou esconde até ela tocar). É a mesma classe de
 * defeito que este módulo existe para impedir: prometer uma saída que não se
 * consegue usar. Aqui ela entra pela FORMA, não pela ausência da palavra.
 *
 * Só a marcação que ESCONDE entra. `*negrito*` e `_itálico_` deixam a palavra
 * legível, e são o jeito normal de destacar a instrução — recusá-los seria
 * brigar com quem está tentando fazer a coisa certa.
 *
 * O `~` de "cerca de" (`~R$ 50`) não é riscado: o padrão exige o par fechando.
 * Um til solto no meio de uma frase não casa, e a palavra fora do par continua
 * visível — o teste de aceitação mede os dois lados.
 *
 * Dois tis de "cerca de" na mesma frase também não formam par: o riscado do
 * WhatsApp só fecha numa letra (`~PARAR~`, nunca ` ~3 dias`) e não atravessa
 * linha. Sem essa borda, "Planos de ~R$ 50. Responda PARAR. Entrega em ~3
 * dias." era recusado — e a campanha já salva com ele perdia o texto do dono
 * para a frase padrão, em silêncio (`textoDaSaidaEfetivo`).
 */
const MARCACAO_QUE_ESCONDE = /(~{1,2})(?=\S)[^~\n]*?\S\1|\|\|[\s\S]*?\|\||```[\s\S]*?```|`[^`\n]*`/gu;

/** O texto SEM os trechos que o cliente do canal mostra riscados, escondidos ou como código. */
function semMarcacaoQueEsconde(texto: string): string {
  return texto.replace(MARCACAO_QUE_ESCONDE, " ");
}

/** O texto contém a palavra que ESTE idioma oferece (`palavraDeSaida`)? */
export function contemPalavraDeSaida(texto: string, locale?: string | null): boolean {
  return contemPalavra(texto, palavraDeSaida(locale));
}

/** O texto contém ALGUMA das palavras que a saída oferece — a régua de quem não sabe o idioma. */
export function contemAlgumaPalavraDeSaida(texto: string): boolean {
  return Object.values(PALAVRA_POR_IDIOMA).some((palavra) => contemPalavra(texto, palavra));
}

function problemaNoTexto(
  texto: string,
  temPalavra: (texto: string) => boolean,
): ProblemaDoTextoDaSaida | null {
  if (texto.length > TAMANHO_MAXIMO_DO_TEXTO_DA_SAIDA) return "longo";
  if (LINK_NO_TEXTO.test(texto)) return "link";
  if (!temPalavra(texto)) return "sem_palavra";
  // A palavra existe — mas só dentro de marcação que o cliente do canal
  // desenha riscada, escondida ou como código. Ver `MARCACAO_QUE_ESCONDE`.
  if (!temPalavra(semMarcacaoQueEsconde(texto))) return "palavra_escondida";
  return null;
}

/**
 * O problema do texto do dono SEM olhar o idioma — a régua do schema, que valida
 * a configuração antes de saber de qual organização ela é (o locale mora em
 * `organizations`, não no `config` da campanha).
 *
 * Vazio é válido em todas as réguas: significa "usa a frase padrão".
 */
export function problemaNoTextoDaSaida(
  texto: string | null | undefined,
): ProblemaDoTextoDaSaida | null {
  const proprio = (texto ?? "").trim();
  if (proprio === "") return null;
  return problemaNoTexto(proprio, contemAlgumaPalavraDeSaida);
}

/**
 * O problema do texto do dono NO IDIOMA da instalação. É esta a régua que a tela
 * e o servidor aplicam: um texto com PARAR numa instalação em espanhol passaria
 * na régua genérica e ofereceria uma palavra que ninguém ali responde.
 */
export function problemaNoTextoDaSaidaNoIdioma(
  texto: string | null | undefined,
  locale?: string | null,
): ProblemaDoTextoDaSaida | null {
  const proprio = (texto ?? "").trim();
  if (proprio === "") return null;
  return problemaNoTexto(proprio, (t) => contemPalavraDeSaida(t, locale));
}

/**
 * O texto que ESTE envio leva: o do dono quando ele serve para este idioma, a
 * frase padrão em qualquer outro caso. Determinístico de ponta a ponta — não há
 * chamada de modelo nem sorteio aqui.
 */
export function textoDaSaidaEfetivo(
  configurado?: string | null,
  locale?: string | null,
): string {
  const proprio = (configurado ?? "").trim();
  if (proprio === "" || problemaNoTextoDaSaidaNoIdioma(proprio, locale) !== null) {
    return rodapeDeSaida(locale);
  }
  return proprio;
}

/**
 * O corpo final da abordagem: o texto do modelo + a saída.
 *
 * `textoDaCampanha` é o `config.texto_da_saida` da campanha (opcional). Sem ele,
 * o comportamento é EXATAMENTE o de antes — a assinatura antiga segue valendo.
 *
 * Idempotente de propósito — se o texto do modelo já terminar com a saída (por
 * exemplo porque alguém pôs a instrução no prompt também), não duplica. Repetir
 * a mesma frase duas vezes na primeira mensagem parece defeito e custa a
 * primeira impressão. O critério é o texto EFETIVO: com texto do dono, é ele que
 * não pode sair duas vezes.
 */
export function comSaida(
  texto: string,
  locale?: string | null,
  textoDaCampanha?: string | null,
): string {
  const corpo = texto.trimEnd();
  if (temSaida(corpo, locale, textoDaCampanha)) return corpo;
  return `${corpo}\n\n${textoDaSaidaEfetivo(textoDaCampanha, locale)}`;
}

/** O texto já termina com a saída efetiva deste idioma (o mesmo critério do `comSaida`). */
export function temSaida(
  texto: string,
  locale?: string | null,
  textoDaCampanha?: string | null,
): boolean {
  return texto
    .trimEnd()
    .toLowerCase()
    .endsWith(textoDaSaidaEfetivo(textoDaCampanha, locale).toLowerCase());
}
