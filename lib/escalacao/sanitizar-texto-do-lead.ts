/**
 * O TEXTO QUE O MODELO ESCREVEU A PARTIR DO QUE O LEAD DISSE — LIMPO ANTES DE SAIR.
 *
 * ## Por que existe
 *
 * `agent_cases.title`, `.summary` e `.blocker` são escritos pelo MODELO a partir
 * da conversa. Eles saem daqui para dois lugares que não são a tela do CRM:
 *
 *   1. o aviso de caso no WhatsApp do suporte (`lib/escalacao/texto-do-aviso.ts`);
 *   2. o briefing da passagem para uma pessoa (`registrarPassagem`, que aplica
 *      esta mesma função a `title`, `notes` e `content` antes do insert).
 *
 * Uma função, dois consumidores: artefato espelho se DERIVA, não se copia. Se
 * um dia só um dos dois sanear, o outro vira a porta.
 *
 * ## O que ela tira, e por quê — cada regra fecha um caminho concreto
 *
 * - **URL** (`https://…`, `www.…`, domínio nu): o ÚNICO link do aviso é o que o
 *   servidor montou. Um lead que escreve "acesse banco.example/pague" consegue,
 *   sem esta regra, pôr um link de phishing dentro de uma mensagem que chega
 *   assinada com a marca da empresa, no WhatsApp de quem atende.
 * - **Sequência longa de dígitos** (8 ou mais, com ou sem pontuação): é onde
 *   moram CPF e telefone. A decisão do dono é explícita — o aviso leva tipo,
 *   título, PRIMEIRO nome, o que precisa e por que travou, e **nunca** telefone
 *   ou CPF. Um lead que digita o próprio CPF no meio da frase o veria reaparecer
 *   no aviso sem esta regra. Valor com até 7 dígitos fica (`10%`, `R$ 1.500,00`,
 *   `2026`): o corte está no ponto em que o número deixa de ser quantidade e
 *   passa a ser identificador.
 * - **Marcadores do WhatsApp** (`*`, `_`, `~`, crase): eles permitiriam imitar
 *   uma linha do sistema — `*Abrir:*` em negrito no meio de um texto do lead é
 *   indistinguível da linha que o servidor escreveu.
 * - **Controles, inclusive U+2028/U+2029**: são terminadores de linha em JS e já
 *   quebraram script neste projeto; num texto de saída, quebram o formato.
 *
 * ## O que ela NÃO promete, declarado
 *
 * Não é um detector de PII. E-mail, endereço e nome de terceiro passam. O que
 * ela garante são as quatro classes acima — e o desenho do aviso é o que impede
 * o resto: ele nunca carrega `context_snapshot.last_messages` nem o corpo de
 * mensagem nenhuma, só campos que o modelo resumiu.
 */

/**
 * Os tetos por campo — os mesmos que o schema de `openHumanCaseInputSchema`
 * aceita na entrada, encurtados para caber numa mensagem que se lê no celular.
 *
 * Moram aqui e não no chamador porque os DOIS consumidores usam os mesmos
 * números: um teto por campo, uma fonte.
 */
export const TETOS_DO_TEXTO_DO_LEAD = {
  title: 90,
  summary: 160,
  blocker: 160,
} as const;

/** `http(s)://…` até o primeiro espaço. */
const URL_COM_ESQUEMA = /\bhttps?:\/\/\S+/gi;
/** `www.alguma.coisa…` — o mesmo alvo sem o esquema. */
const URL_COM_WWW = /\bwww\.\S+/gi;
/**
 * Domínio nu (`banco.example.com/paga`). O último rótulo tem de ser
 * ALFABÉTICO com 2+ letras: sem isso, `1.500` e `529.982` casariam e a regra
 * comeria dinheiro e quantidade — over-removal que muda o significado do texto.
 */
const DOMINIO_NU = /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/\S*)?/gi;
/**
 * Corrida de dígitos com pontuação de telefone/CPF. O filtro final é a CONTAGEM
 * de dígitos (≥ 8), feita no `replace` — um regex que tentasse contar sozinho
 * ficaria ilegível e erraria nas bordas.
 */
const CORRIDA_DE_DIGITOS = /\+?\d[\d().\-\s]{5,}\d/g;
/** Os marcadores de formatação do WhatsApp. */
const MARCADORES = /[*_~`]/g;
/**
 * Controles C0/C1 e os dois separadores Unicode de linha. `\u2028`/`\u2029`
 * estão fora de `\p{Cc}` — eles são `Zl`/`Zp` — e é justamente por isso que
 * precisam estar escritos aqui.
 */
const CONTROLES = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

function contaDigitos(trecho: string): number {
  let n = 0;
  for (const c of trecho) if (c >= "0" && c <= "9") n += 1;
  return n;
}

/**
 * SÓ a retirada de URL — sem truncar e sem mexer no resto.
 *
 * Extraída porque a mesma régua de link vale em dois escopos: por CAMPO
 * (abaixo, em `sanitizarTextoDoLead`) e no TEXTO INTEIRO já montado
 * (`lib/automation/sanitizar-resumo-para-a-equipe.ts`, a última porta antes da
 * mensagem). Um regex de URL escrito duas vezes vira duas réguas no dia em que
 * alguém consertar só uma — e é justamente o link que não pode escapar.
 *
 * As três classes: `http(s)://…`, `www.…` e domínio nu (`banco.example/paga`).
 */
export function semUrls(texto: string): string {
  return texto.replace(URL_COM_ESQUEMA, " ").replace(URL_COM_WWW, " ").replace(DOMINIO_NU, " ");
}

/**
 * Limpa e trunca. `null` quando nada sobrevive — nunca string vazia.
 *
 * A diferença importa na saída: uma linha `Assunto: ` AFIRMA que há um assunto e
 * que ele é nada. A ausência da linha é a verdade disponível.
 *
 * O truncamento conta por CARACTERE Unicode (`[...texto]`), não por unidade de
 * código: um resumo com emoji cortado no meio de um par substituto sai como
 * caractere quebrado na tela de quem lê.
 */
export function sanitizarTextoDoLead(
  bruto: string | null | undefined,
  max: number,
): string | null {
  if (typeof bruto !== "string") return null;

  const limpo = semUrls(bruto)
    .replace(CORRIDA_DE_DIGITOS, (trecho) => (contaDigitos(trecho) >= 8 ? " " : trecho))
    .replace(MARCADORES, "")
    .replace(CONTROLES, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (limpo === "") return null;

  const chars = [...limpo];
  if (chars.length <= max) return limpo;
  // O `…` ocupa um caractere do orçamento: o resultado NUNCA passa do teto, que
  // é o que a coluna e a mensagem esperam.
  return chars.slice(0, Math.max(0, max - 1)).join("").trimEnd() + "…";
}
