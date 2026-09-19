import { PALAVRAS_DE_OPT_OUT } from "@/lib/opt-out/deteccao";

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
  es: (p) => `Si no querés recibir más mensajes, respondé ${p}.`,
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
 * O corpo final da abordagem: o texto do modelo + a saída.
 *
 * Idempotente de propósito — se o texto do modelo já terminar com o rodapé (por
 * exemplo porque alguém pôs a instrução no prompt também), não duplica. Repetir
 * a mesma frase duas vezes na primeira mensagem parece defeito e custa a
 * primeira impressão.
 */
export function comSaida(texto: string, locale?: string | null): string {
  const rodape = rodapeDeSaida(locale);
  const corpo = texto.trimEnd();
  if (corpo.toLowerCase().endsWith(rodape.toLowerCase())) return corpo;
  return `${corpo}\n\n${rodape}`;
}
