/**
 * Captura DETERMINÍSTICA da resposta do cliente a uma pergunta de fluxo.
 *
 * É a rede do motor (Fase 2 do fluxo robusto): o modelo continua sendo quem
 * interpreta texto livre e registra com `flow_collect`, mas quando a resposta é
 * inequívoca por regra fixa (data, número, sim/não, opção de lista) o motor a
 * captura sozinho — e, mais importante, DISTINGUE três desfechos do inbound:
 *
 *   - `respondeu`  → casou uma regra; grava o valor normalizado.
 *   - `desviou`    → o cliente perguntou/pediu OUTRA coisa antes de responder;
 *                    a pergunta continua pendente e a tentativa NÃO conta.
 *   - `ignorou`    → aceno/silêncio (emoji, "ok", "blz"…): a pergunta foi feita
 *                    e não veio resposta — a tentativa CONTA.
 *   - `nao_identificado` → mensagem substantiva que não casou regra nem desvio
 *                    (típico de campo `text`): deixa para o modelo registrar.
 *
 * Escopo conservador, mesma filosofia de `dados-do-lead.ts`: só captura o que
 * casa um padrão inequívoco, ancorado no tipo do campo e nas pistas do rótulo/
 * pergunta ("ano" exige 4 dígitos plausíveis, "km" aceita "mil", etc.). Texto
 * livre NUNCA é capturado aqui — interpretar sentido não é trabalho de regex.
 */
import type { ContactFlowFieldType } from "./graph-schema";

/** O mínimo que a captura precisa saber de um campo pendente. */
export interface CampoPendenteParaCaptura {
  key: string;
  label: string;
  type: ContactFlowFieldType;
  options?: string[] | undefined;
  question?: string | undefined;
}

export interface CapturaDeCampo {
  key: string;
  /** Valor NORMALIZADO (o que o sistema usa): "true"/"false", dígitos, AAAA-MM-DD ou a opção. */
  valor: string;
  /** Trecho/estrutura que sustentou a captura — auditoria, nunca vai ao cliente. */
  bruto: string;
}

export type ResultadoDaLeitura =
  | { resultado: "respondeu"; captura: CapturaDeCampo }
  | { resultado: "desviou" }
  | { resultado: "ignorou" }
  | { resultado: "nao_identificado" };

function normalizar(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const RE_DATA_BR = /\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b/;
const RE_DATA_ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const RE_ACENO =
  /^(ok|okay|blz|beleza|certo|ta|tá|entendi|entendido|vlw|valeu|obg|obrigado|obrigada|kkk+|rs+|haha+|hehe+|👍+|👌+|🙏+|❤️?|sim|nao|não|n|claro|isso|certo|beleza|depois eu vejo|vou ver|deixa eu ver|vou verificar)$/;

/** Sem emoji, sem pontuação e sem espaços supérfluos — base das comparações. */
function soPalavras(texto: string): string {
  return texto
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(texto: string): string[] {
  const n = soPalavras(normalizar(texto));
  return n === "" ? [] : n.split(" ");
}

/** Rótulo + pergunta viram o "contexto" do campo (pistas lexicais). */
function contextoDoCampo(campo: CampoPendenteParaCaptura): string {
  return normalizar(`${campo.label} ${campo.question ?? ""}`);
}

function contemContexto(campo: CampoPendenteParaCaptura, textoNormalizado: string): boolean {
  const ctx = tokens(contextoDoCampo(campo));
  return ctx.length > 0 && ctx.some((t) => t.length >= 3 && textoNormalizado.includes(t));
}

/**
 * Tenta normalizar a resposta para o campo. `exigirContexto` liga a âncora
 * lexical (rótulo/pergunta) — desligada só para a PRIMEIRA pergunta pendente,
 * que é justamente a que o bot acabou de fazer.
 */
export function normalizarValorDoCampo(
  campo: CampoPendenteParaCaptura,
  texto: string,
  opts: { exigirContexto: boolean },
): CapturaDeCampo | null {
  const t = texto.trim();
  if (t === "") return null;
  const n = normalizar(t);
  const temContexto = contemContexto(campo, n);
  if (opts.exigirContexto && !temContexto) return null;

  switch (campo.type) {
    case "date":
      return capturarData(campo, t, n, temContexto);
    case "number":
      return capturarNumero(campo, t, n, temContexto);
    case "boolean":
      return capturarBooleano(campo, t, n, temContexto);
    case "select":
      return capturarSelect(campo, t, n);
    case "text":
      // Texto livre é interpretação — não é trabalho de regex.
      return null;
  }
}

function capturarData(
  campo: CampoPendenteParaCaptura,
  bruto: string,
  n: string,
  ancorado: boolean,
): CapturaDeCampo | null {
  const iso = RE_DATA_ISO.exec(n);
  if (iso) {
    const [, a, m, d] = iso;
    if (validaData(Number(a), Number(m), Number(d))) {
      return { key: campo.key, valor: `${a}-${m}-${d}`, bruto };
    }
  }
  const br = RE_DATA_BR.exec(n);
  if (!br) return null;
  // Sem âncora, só aceita se parecer responda à pergunta: a data é dominante.
  if (!ancorado && tokens(bruto).length > 6) return null;
  const dia = Number(br[1]);
  const mes = Number(br[2]);
  let ano = Number(br[3]);
  if (ano < 100) {
    const d = new Date();
    const seculo = Math.floor(d.getFullYear() / 100);
    ano = seculo * 100 + ano;
  }
  if (!validaData(ano, mes, dia)) return null;
  return {
    key: campo.key,
    valor: `${String(ano).padStart(4, "0")}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`,
    bruto,
  };
}

function validaData(ano: number, mes: number, dia: number): boolean {
  if (ano < 1900 || ano > 2100) return false;
  if (mes < 1 || mes > 12) return false;
  if (dia < 1 || dia > 31) return false;
  return true;
}

function capturarNumero(
  campo: CampoPendenteParaCaptura,
  bruto: string,
  n: string,
  ancorado: boolean,
): CapturaDeCampo | null {
  const m = /(\d[\d.,]*)\s*(mil|k)?\b/i.exec(n);
  if (!m) return null;
  if (!ancorado && tokens(bruto).length > 4) return null;

  const ctx = contextoDoCampo(campo);
  const ehAno = /\bano\b/.test(ctx);
  const temMil = (m[2] ?? "") !== "";

  let digitos = m[1]!.replace(/\s/g, "");
  // Separador de milhar (ponto) e decimal (vírgula) no padrão BR.
  if (/,/.test(digitos)) digitos = digitos.replace(/\./g, "").replace(",", ".");
  else digitos = digitos.replace(/\.(?=\d{3}\b)/g, "");
  let valor = Number(digitos);
  if (!Number.isFinite(valor)) return null;
  if (temMil) valor *= 1000;
  if (ehAno) {
    // "ano" tem faixa plausível: evita capturar "24" (parcelas) como 2024.
    if (!Number.isInteger(valor) || valor < 1950 || valor > 2100) return null;
    return { key: campo.key, valor: String(valor), bruto };
  }
  return { key: campo.key, valor: String(valor), bruto };
}

function capturarBooleano(
  campo: CampoPendenteParaCaptura,
  bruto: string,
  n: string,
  temContexto: boolean,
): CapturaDeCampo | null {
  // Sem contexto e mensagem longa ("tenho interesse em uma moto") não é resposta
  // a um sim/não — booleano só captura em réplica curta ou com pista do rótulo.
  if (!temContexto && tokens(bruto).length > 3) return null;
  const neg = /\b(nao|nunca|negativo|falso|sem)\b/.test(` ${n} `);
  // A lista FORTE vale sempre. "tenho"/"possuo"/"sou" são genéricos demais
  // sozinhos — "tenho interesse em uma moto" virava `true` para o campo CNH —
  // então só contam quando o RÓTULO está presente ("tenho cnh", "tenho
  // habilitação"): aí a palavra carrega o sentido de posse do campo.
  const forte =
    /\b(sim|claro|isso|com certeza|positivo|verdadeiro|pode ser|exato|correto|ja tenho|ja possuo|eu tenho|eu possuo)\b/.test(
      ` ${n} `,
    );
  const comContexto = temContexto && /\b(tenho|possuo|sou)\b/.test(` ${n} `);
  // "não tenho"/"não possuo" contêm "tenho"/"possuo": o negativo vence.
  if (neg) return { key: campo.key, valor: "false", bruto };
  if (forte || comContexto) return { key: campo.key, valor: "true", bruto };
  return null;
}

function capturarSelect(
  campo: CampoPendenteParaCaptura,
  bruto: string,
  n: string,
): CapturaDeCampo | null {
  const opcoes = campo.options ?? [];
  if (opcoes.length === 0) return null;
  // Opção mais longa primeiro: evita "novo" casar dentro de "novo/novinho".
  for (const opcao of [...opcoes].sort((a, b) => b.length - a.length)) {
    const no = normalizar(opcao);
    if (no !== "" && n.includes(no)) return { key: campo.key, valor: opcao, bruto };
  }
  return null;
}

/** O cliente mudou de assunto? (pergunta/pedido explícito em vez de resposta.) */
export function detectarDesvio(texto: string): boolean {
  const n = normalizar(texto);
  if (n === "") return false;
  if (n.includes("?")) return true;
  return /\b(quanto|quantos|quanta|quantas|qual|quais|quando|onde|como|porque|por que|pode|poderia|gostaria|queria|quero|aceita|faz|consigo|da pra|tem como|voce[s]? tem|tem jeito)\b/.test(
    n,
  );
}

/** Aceno/silêncio: emoji, vazio ou muleta curta que não responde nem pergunta. */
export function ehAcenoOuSilencio(texto: string): boolean {
  const palavras = soPalavras(texto);
  if (palavras === "") return true;
  return RE_ACENO.test(normalizar(palavras));
}

/**
 * Lê o inbound contra a PRIMEIRA pergunta pendente e devolve o desfecho.
 * Puro — a gravação e a contagem de tentativa ficam em `atendimento.ts`.
 */
export function classificarInbound(
  campo: CampoPendenteParaCaptura,
  texto: string | null | undefined,
): ResultadoDaLeitura {
  const t = texto ?? "";
  if (t.trim() === "") return { resultado: "ignorou" };

  const captura = normalizarValorDoCampo(campo, t, { exigirContexto: false });
  if (captura !== null) return { resultado: "respondeu", captura };

  if (detectarDesvio(t)) return { resultado: "desviou" };
  if (ehAcenoOuSilencio(t)) return { resultado: "ignorou" };
  return { resultado: "nao_identificado" };
}

/** Texto da pergunta a enviar quando o modelo não a incluiu (determinístico). */
export function textoDaPergunta(campo: CampoPendenteParaCaptura): string {
  const q = campo.question?.trim();
  if (q !== undefined && q !== "") return q;
  const label = campo.label.trim();
  if (label === "") return "Pode me contar mais?";
  return label.endsWith("?") ? label : `${label}?`;
}

/**
 * O valor que o MODELO mandou em `flow_collect` bate com o TIPO do campo?
 *
 * Existe porque o modelo gravava lixo: no teste ao vivo de 2026-09-18, um "ok"
 * foi registrado como `troca_ano` (campo `number`). A captura determinística
 * não faz isso — ela respeita o tipo —, mas o caminho do `flow_collect` não
 * validava nada e deixava o modelo sobrescrever a pergunta com um valor que não
 * responde a ela.
 *
 * Não normaliza nem interpreta: só ACEITA ou RECUSA. `number` exige dígitos;
 * `boolean` exige sim/não; `date` exige data; `select` exige uma das opções;
 * `text` aceita qualquer coisa não-vazia (é o único tipo livre).
 */
export function valorBateComTipo(campo: CampoPendenteParaCaptura, valor: unknown): boolean {
  const v = typeof valor === "string" ? valor.trim() : valor;
  if (v === null || v === undefined || v === "") return false;
  const s = String(v).trim();
  switch (campo.type) {
    case "number":
      // Aceita "120000", "120.000", "120 mil" — mas NÃO "ok".
      return /\d/.test(s) && /^[\d.,\s]*(mil|k)?$/i.test(s.replace(/\s+/g, " ").trim());
    case "boolean":
      return /^(true|false|sim|nao|não|1|0)$/i.test(s);
    case "date":
      return RE_DATA_ISO.test(s) || RE_DATA_BR.test(s);
    case "select":
      return (campo.options ?? []).some((o) => normalizar(o) === normalizar(s));
    case "text":
      return true;
    default:
      return false;
  }
}

/**
 * Palavras funcionais que não identificam uma pergunta (artigos, preposições,
 * pronomes, interrogativos genéricos). A comparação olha só o CONTEÚDO.
 */
const PALAVRAS_FUNCIONAIS = new Set([
  "a", "o", "as", "os", "um", "uma", "uns", "umas",
  "de", "da", "do", "das", "dos", "em", "no", "na", "nos", "nas",
  "e", "eh", "que", "qual", "quais", "quando", "onde", "como", "porque",
  "me", "te", "seu", "sua", "você", "voce", "voce", "vc", "para", "pra",
  "por", "com", "sem", "ao", "aos", "à", "às", "é", "ser", "esta", "esse", "essa",
]);

function tokensDeConteudo(texto: string): Set<string> {
  return new Set(tokens(texto).filter((t) => t.length >= 3 && !PALAVRAS_FUNCIONAIS.has(t)));
}

/** A pergunta saiu em algum dos textos enviados neste turno? (cobertura do conteúdo.) */
export function perguntaSaiuNosTextos(
  pergunta: string,
  textos: readonly string[],
  limiar = 0.6,
): boolean {
  const alvo = tokensDeConteudo(pergunta);
  if (alvo.size === 0) return false;
  for (const texto of textos) {
    const atual = tokensDeConteudo(texto);
    if (atual.size === 0) continue;
    let inter = 0;
    for (const g of alvo) if (atual.has(g)) inter += 1;
    if (inter / alvo.size >= limiar) return true;
  }
  return false;
}
