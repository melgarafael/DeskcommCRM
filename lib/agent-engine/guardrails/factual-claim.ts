/**
 * A CONFERÊNCIA DE FATO (#2231) — a TERCEIRA camada do `before_send`, depois
 * da F4-01 (promessa em tabela) e da F4-02 (promessa semântica).
 *
 * A F4-01/F4-02 proíbe o agente de PROMETER (retorno humano, prazo, gratuidade)
 * para não criar expectativa que o atendimento não cumpre. Esta camada é de
 * outra natureza: a afirmação de FATO sobre o negócio ("abrimos às 8h",
 * "check-in às 12h", "temos piscina") conferida contra a EVIDÊNCIA consultada
 * NESTE turno (`evidenciasComerciais.ler()`), a mesma que já alimenta a F4-02.
 *
 * A guarda de promessa NÃO muda: "abrimos às 8h" não é promessa para a F4-02
 * (o prompt dela diz que descrição de horário/empresa não promete nada) e aqui
 * cai SÓ quando o material consultado não a contém. Promessa e fato são duas
 * camadas — a de fato, esta, é quem sabe se o horário está escrito na base.
 *
 * ═══ O QUE ELA FAZ ═══
 *
 *  1. Separa a candidata em FRASES e tira por regra simples o que não afirma
 *     nada: pergunta, saudação e um link (um link é uma frase só — os pontos
 *     do endereço não podem fatiá-lo). Nada disso sai para a rede.
 *  2. Sem EVIDÊNCIA consultada no turno o agente respondeu de memória: a
 *     camada não roda e grava "não conferido" — a mesma postura do #2010
 *     (fail-open, com registro).
 *  3. Para cada frase, três perguntas Noul para o Jev (`claim_i`, `supported_i`,
 *     `contradicts_i`). `supported_i` diz "in any wording or format" de
 *     propósito: "14h" contra "14:00" é a mesma afirmação.
 *  4. A decisão é em CÓDIGO, pelos limiares fixos daqui, e combinada pelo
 *     MÁXIMO das frases — nunca pela média (uma frase ruim não se perdoa com
 *     dez frases certas).
 *
 * ═══ OS TRÊS ESTADOS ═══
 *
 *  - `observando` (como a tarefa nasce): a chamada sai, os rótulos vão para
 *    `jev_observacoes` e NADA é vetado — o cartão mostra quanto os dois
 *    concordaram antes de alguém deixar o Jev decidir.
 *  - `decidindo`: um `contradiz` ou `nao_esta_na_base` vira veto com erro de
 *    ensino, para o modelo reescrever a partir do material.
 *  - `desligada`: zero requisição, zero linha, o envio idêntico ao de hoje.
 *
 * `lib/ai/decisao/afirmacao-de-fato.ts` é quem conversa com o Jev e grava; o
 * que está aqui é puro (sem rede, sem banco) — é o que o gate lê.
 */
import type { Resposta } from "@/lib/ai/decisao/cliente";

/** `claim_i` ACIMA daqui = a frase afirma fato; `contradicts_i` ACIMA daqui = a base diz o contrário. */
export const LIMIAR_AFIRMACAO = 0.7;
/** `supported_i` ABAIXO daqui (com `claim_i` acima) = o fato não está na base. Igual não passa: é `<`. */
export const LIMIAR_SUPORTE = 0.3;
export const LIMIAR_CONTRADICAO = 0.7;

export type VereditoDaAfirmacao = "passa" | "contradiz" | "nao_esta_na_base";

/** Por que a camada NÃO rodou. Rótulo curto, nunca texto da candidata. */
export type MotivoDeNaoConferir =
  | "desligada"
  | "sem_evidencia"
  | "sem_frases"
  | "sem_credencial"
  | "outra_por_turno"
  | "falha";

/** O que o gate lê (`GateContext.factualClaim`). */
export interface ConferenciaDeFato {
  /** `nao_conferida` = a camada não rodou (ver `motivo`). */
  estado: "observando" | "decidindo" | "nao_conferida";
  veredito: VereditoDaAfirmacao | "nao_conferido";
  motivo?: MotivoDeNaoConferir;
  /** A frase que motivou o veto — SÓ para o erro de ensino devolvido ao modelo. */
  frase: string | null;
  quantidadeDeFrases: number;
  /** Saiu requisição para a rede? É o que o "uma por turno" de quem chama conta. */
  pediu: boolean;
}

// ── Degrau 1: as frases, sem rede ───────────────────────────────────────────

/** A URL é mascarada ANTES de fatiar: um link é uma frase só. */
const LINK = /\b(?:https?:\/\/|www\.)\S+/gi;
const FIM_DE_FRASE = /(?<=[.!?;…])\s+|\n+/;
const MARCADOR_DE_LISTA = /^\s*(?:[-*•●▪–—]|\d+[.)])\s*/;
const SOMENTE_LINK = /^(?:https?:\/\/|www\.)\S+$/i;
const LINK_MARCADO = /^\[[^\]]*\]\((?:https?:\/\/|www\.)[^)]+\)$/i;

/** Pergunta: termina em `?`. Simples, e cobre "Como posso ajudar?". */
export function ehPergunta(frase: string): boolean {
  return /\?\s*$/.test(frase);
}

/** Saudação/agradecimento: lista fechada, sem adivinhação. */
export function ehSaudacao(frase: string): boolean {
  const semAcento = frase.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return /^(?:oi|ola|opa|e ai|bom dia|boa tarde|boa noite|boa sorte|obrigad[oa]|valeu|fala|hello|hi|hey|thanks|thank you|tchau|falou)[.!…\s]*$/.test(
    semAcento,
  );
}

/** Um link não afirma fato nenhum — sai. `Veja em https://…` fica (não é só o link). */
export function ehSomenteUmLink(frase: string): boolean {
  const compacta = frase.replace(/\s+/g, "");
  return SOMENTE_LINK.test(compacta) || LINK_MARCADO.test(compacta);
}

/** O que sai por regra simples, ANTES da requisição. */
export function saiPorRegraSimples(frase: string): boolean {
  return ehPergunta(frase) || ehSaudacao(frase) || ehSomenteUmLink(frase);
}

/**
 * A candidata em frases conferíveis. A resposta inteira cabe aqui: sem limite
 * de frases (o teto da chamada é do fornecedor, não nosso), e o `scrubMessage`
 * quem corta dado de cliente antes — ver `./afirmacao-de-fato`.
 */
export function frasesParaConferir(candidata: string): string[] {
  const links: string[] = [];
  const mascarada = candidata.replace(LINK, (link) => {
    links.push(link);
    return `\u0000${links.length - 1}\u0000`;
  });
  const frases: string[] = [];
  for (const bruta of mascarada.split(FIM_DE_FRASE)) {
    const semLista = bruta.replace(MARCADOR_DE_LISTA, "").trim();
    if (semLista === "") continue;
    const frase = semLista.replace(/\u0000(\d+)\u0000/g, (_t, i: string) => links[Number(i)] ?? "");
    if (frase.trim() === "" || saiPorRegraSimples(frase)) continue;
    frases.push(frase.trim());
  }
  return frases;
}

// ── Degrau 2: as perguntas — ver `./afirmacao-de-fato` (o chamador as declara) ─

// ── Degrau 3: a decisão, em código ─────────────────────────────────────────

function probabilidade(resposta: Resposta | undefined): number | null {
  if (resposta === undefined || resposta.tipo !== "noul") return null;
  return Number.isFinite(resposta.noul) ? resposta.noul : null;
}

const GRAVIDADE: Record<VereditoDaAfirmacao, number> = { passa: 0, nao_esta_na_base: 1, contradiz: 2 };

export interface ResultadoDoCalculo {
  /** Resposta fora de probabilidade: fail-open, nunca um veto. */
  ilegivel: boolean;
  /** `null` quando `ilegivel`. */
  veredito: VereditoDaAfirmacao | null;
  frase: string | null;
}

// ── Degrau 3.5: a corroboração mecânica da paráfrase (#2582) ───────────────
//
// O `supported_i` do Jev casava com o texto LITERAL da evidência: quem junta
// dois itens da mesma linha ("Flexível R$ 119,90 · Fosca R$ 119,90" →
// "Flexível ou fosca: R$ 119,90") caía em `nao_esta_na_base` com o preço na
// evidência (issue #2582, 1ª medição real). Antes de vetar por falta de base,
// o gate confere o que é MECÂNICO, não opinião: o preço (normalizado — `R$
// 119,90` ≡ `119,90` ≡ `119.90`) e o nome de CADA item existem na evidência.
// É um piso, não um teto: `contradiz` não passa por aqui, frase sem número
// não ganha nada, item que a base não tem com aquele preço continua vetado —
// só `nao_esta_na_base` é resgatado, e só com prova mecânica na mão.

/** Um valor no texto: `R$ 1.234,56` / `119.90` / `8h` — inteiro + decimais opcionais. */
const VALOR = /(?<![\p{L}\p{N}])(?:r\$\s*)?(\d{1,3}(?:[.,]\d{3})+|\d+)(?:[.,](\d{1,2}))?(?![\p{L}\p{N}%])/giu;

/** O valor em forma canônica: `R$ 119,90` ≡ `119,90` ≡ `119.90` → `119.90`. */
function canonico(inteiro: string, decimais: string | undefined): string {
  const semSeparador = inteiro.replace(/[.,]/g, "");
  return decimais === undefined ? semSeparador : `${semSeparador}.${decimais}`;
}

interface ValorEncontrado {
  /** O valor canônico. */
  valor: string;
  /** O trecho ANTERIOR ao valor (desde o valor anterior) — é ali que mora o nome do item. */
  rotulo: string;
}

/** Cada valor do texto com o trecho que vem antes dele. */
function valoresComRotulo(texto: string): ValorEncontrado[] {
  const achados: ValorEncontrado[] = [];
  let fimDoAnterior = 0;
  for (const m of texto.matchAll(VALOR)) {
    const rotulo = texto.slice(fimDoAnterior, m.index);
    // A lista da evidência é separada por "·", ";", "|" ou quebra de linha:
    // o nome do item não atravessa o separador.
    const corte = Math.max(
      rotulo.lastIndexOf("\n"),
      rotulo.lastIndexOf("·"),
      rotulo.lastIndexOf(";"),
      rotulo.lastIndexOf("|"),
    );
    achados.push({ valor: canonico(m[1]!, m[2]), rotulo: rotulo.slice(corte + 1) });
    fimDoAnterior = m.index + m[0].length;
  }
  return achados;
}

/** Os itens nomeados antes do preço: `"Flexível ou fosca: "` → `["Flexível", "fosca"]`. */
function itensDoRotulo(rotulo: string): string[] {
  return rotulo
    .split(/[·/|,;+()]|\s+\bou\b/i)
    .map((pedaco) => pedaco.trim())
    .filter((pedaco) => pedaco !== "");
}

/** A cola que qualquer frase de preço põe em volta do item — não é nome de produto. */
const COLA_DO_ITEM: ReadonlySet<string> = new Set([
  "as", "os", "um", "uma", "uns", "umas", "de", "do", "da", "dos", "das",
  "em", "no", "na", "nos", "nas", "num", "numa", "pelo", "pela", "pelos", "pelas",
  "por", "para", "com", "sem", "sobre", "entre", "e", "ou", "mas", "que", "se",
  "ao", "aos", "ate",
  // o verbo que a frase de preço põe antes do valor ("sai por R$ …")
  "sai", "saiem", "custa", "custam", "vale", "valem", "fica", "ficam", "tem",
  "temos", "sera", "sao", "esta",
]);

/** Tokens normalizados (minúsculo, sem acento) com 2+ caracteres. */
function tokens(texto: string): Set<string> {
  const limpo = texto.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return new Set(limpo.split(/[^a-z0-9]+/).filter((t) => t.length >= 2));
}

/** O item só conta com o que NÃO é cola. */
function tokensDoItem(item: string): string[] {
  return [...tokens(item)].filter((t) => !COLA_DO_ITEM.has(t));
}

/** Nome no item × nome no trecho da evidência: exato, no plural ou com inflexão curta. */
function nomeBate(item: string, trecho: ReadonlySet<string>): boolean {
  if (trecho.has(item)) return true;
  if (item.length < 4) return false;
  const semS = item.endsWith("s") ? item.slice(0, -1) : item;
  for (const nome of trecho) {
    if (nome.length < 4) continue;
    const outro = nome.endsWith("s") ? nome.slice(0, -1) : nome;
    if (outro === semS) return true;
    // "película" × "películas", "flexível" × "flexíveis": inflação de até 2
    // letras, nunca um prefixo qualquer ("casa" não casa com "casamento").
    const folga = Math.abs(outro.length - semS.length);
    if (folga <= 2 && (outro.startsWith(semS) || semS.startsWith(outro))) return true;
  }
  return false;
}

/**
 * A frase tem BASE MECÂNICA na evidência? Exige, para CADA preço da frase:
 * o mesmo preço (canônico) num trecho da evidência e o nome de CADA item
 * daquele trecho — é o "todos os itens têm esse preço" da issue. Sem número
 * na frase não há o que conferir → `false` (a frase sem base continua vetada).
 */
export function temBaseNumerica(frase: string, evidencia: string): boolean {
  const alvos = valoresComRotulo(frase);
  if (alvos.length === 0) return false;
  const trechos = valoresComRotulo(evidencia);
  if (trechos.length === 0) return false;
  for (const { valor, rotulo } of alvos) {
    const comEstePreco = trechos.filter((t) => t.valor === valor);
    // O preço não existe em lugar nenhum da evidência.
    if (comEstePreco.length === 0) return false;
    const bolsas = comEstePreco.map((t) => tokens(t.rotulo));
    const itens = itensDoRotulo(rotulo).map(tokensDoItem).filter((nomes) => nomes.length > 0);
    // Preço sem item nomeado ("Sai por R$ 119,90") não amarra a nada: segue vetado.
    if (itens.length === 0) return false;
    for (const nomes of itens) {
      if (!bolsas.some((b) => nomes.every((n) => nomeBate(n, b)))) return false;
    }
  }
  // O que vem depois do último preço não foi conferido ("… e tem frete grátis").
  const ultimo = [...frase.matchAll(VALOR)].at(-1);
  const cauda = ultimo ? frase.slice(ultimo.index + ultimo[0].length) : "";
  return tokensDoItem(cauda).length === 0;
}

/**
 * O máximo das frases: uma frase ruim veta a candidata inteira. Resposta fora
 * de probabilidade é `ilegivel` (fail-open, com `resposta_ilegivel`), nunca um
 * veto — quem não entendeu a resposta não pode proibir nada.
 *
 * `evidencia` (texto do turno, quem chama junta título + conteúdo) alimenta a
 * corroboração mecânica do #2582: sem ela o corte é o de sempre, literal.
 */
export function decidirAfirmacoes(
  frases: readonly string[],
  respostas: Readonly<Record<string, Resposta>>,
  evidencia?: string,
): ResultadoDoCalculo {
  let pior: VereditoDaAfirmacao = "passa";
  let fraseDoVeto: string | null = null;
  for (let i = 0; i < frases.length; i += 1) {
    const claim = probabilidade(respostas[`claim_${i}`]);
    const supported = probabilidade(respostas[`supported_${i}`]);
    const contradicts = probabilidade(respostas[`contradicts_${i}`]);
    if (claim === null || supported === null || contradicts === null) {
      return { ilegivel: true, veredito: null, frase: null };
    }
    let desta: VereditoDaAfirmacao = "passa";
    if (contradicts > LIMIAR_CONTRADICAO) desta = "contradiz";
    else if (claim > LIMIAR_AFIRMACAO && supported < LIMIAR_SUPORTE) {
      // #2582: o literal não é a única forma de estar na base. Só este corte
      // é resgatado, e só com preço normalizado + item provado na evidência.
      desta =
        evidencia !== undefined && temBaseNumerica(frases[i] ?? "", evidencia)
          ? "passa"
          : "nao_esta_na_base";
    }
    if (GRAVIDADE[desta] > GRAVIDADE[pior]) {
      pior = desta;
      fraseDoVeto = frases[i] ?? null;
    }
  }
  return { ilegivel: false, veredito: pior, frase: fraseDoVeto };
}

/**
 * O erro de ensino devolvido AO MODELO quando o veto persiste — é o texto que
 * ele recebe na mensagem da cadeia, e que por isso pode conter a frase. Log,
 * trace e `jev_observacoes` ficam com rótulo curto só (ver teste).
 */
export function renderVetoDeAfirmacao(veredito: VereditoDaAfirmacao, frase: string | null): string {
  if (veredito === "contradiz") {
    return (
      `A base consultada diz o contrário de "${frase}". Não envie esta afirmação: ` +
      "reformule a partir do que está escrito no material."
    );
  }
  return (
    `Isto não está na base consultada: "${frase}". Consulte o material de novo ou diga que vai ` +
    "confirmar antes de afirmar."
  );
}
