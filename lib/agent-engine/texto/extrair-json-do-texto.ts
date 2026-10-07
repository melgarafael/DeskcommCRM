/**
 * Extrai o PRIMEIRO objeto JSON válido do texto do modelo (ou o texto inteiro,
 * quando ele todo já é JSON).
 *
 * POR QUE EXISTE: os classificadores auxiliares do agente pedem JSON no
 * PROMT ("responda SOMENTE JSON: {...}") — não há `response_format` no seam
 * (`runModelCall`). Modelos roteados por OpenRouter produzem as mesmas saídas
 * com três formas que os parsers antigos (slice `indexOf('{')` →
 * `lastIndexOf('}')`) quebravam:
 *
 *   1. Cerca de código  — ```json\n{...}\n```  (prosa em volta);
 *   2. Repetição        — `{...} {a segunda cópia...}` (o modelo ecoa o JSON
 *                         mais de uma vez: o `lastIndexOf('}')` pegava o fim
 *                         da SEGUNDA cópia e o slice abrangia duas, invalidando
 *                         o parse — "JSON inválido em 7 de 11 checagens");
 *   3. Objeto completo no MEIO de prosa.
 *
 * Esta função NUNCA lança: a leitura de um auxiliar não pode derrubar o turno
 * (colapso de falha). Devolve `null` quando não encontra nada parseável.
 *
 * A varredura de blocos é ciente de STRINGS (o texto costuma carregar PII com
 * `{`, `}` e `"` dentro), e tenta cada bloco `{...}` de nível superior até um
 * parsear — primeiro valor (estável), não o último.
 *
 * Só `{` abre bloco: os chamadores esperam objeto, e um `[` da prosa ("[1]",
 * "[ver abaixo") viraria a resposta ou encerraria a busca. A cerca de código não
 * é retirada: a varredura começa no `{` e a deixa de fora — retirá-la antes
 * reescreveria crases DENTRO das strings do JSON.
 */
const NADA = Symbol("nao-achou-json");

function tentarParsear(texto: string): unknown | typeof NADA {
  const t = texto.trim();
  if (t === "") return NADA;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return NADA;
  }
}

/**
 * Blocos `{…}` de nível superior da string, cientes de strings com escapes.
 * Não interpreta conteúdo — só respeita `"..."` (com `\\`) para não deixar `}`
 * dentro de texto derrubar o balanceamento. Devolve os blocos na ordem em que
 * aparecem.
 */
function blocosDeNivelSuperior(texto: string): string[] {
  const blocos: string[] = [];
  let i = 0;
  const n = texto.length;
  while (i < n) {
    if (texto[i] !== "{") {
      i++;
      continue;
    }
    let aberto = 0;
    let emString = false;
    let escapado = false;
    let fechouFora = false;
    for (let j = i; j < n; j++) {
      const ch = texto[j];
      if (emString) {
        if (escapado) escapado = false;
        else if (ch === "\\") escapado = true;
        else if (ch === '"') emString = false;
        continue;
      }
      if (ch === '"') {
        emString = true;
        continue;
      }
      if (ch === "{") aberto++;
      else if (ch === "}") {
        aberto--;
        if (aberto === 0) {
          blocos.push(texto.slice(i, j + 1));
          i = j + 1;
          fechouFora = true;
          break;
        }
      }
    }
    // Não fechou até o fim — nada mais a extrair. Seguir do próximo caractere
    // devolveria um objeto INTERNO de uma saída truncada (o schema do checkpoint
    // aceita `{"nada_a_declarar":true}` como checkpoint vazio) e tornaria a
    // varredura quadrática. Parar mantém o fechamento falhando fechado.
    if (!fechouFora) i = n;
  }
  return blocos;
}

/**
 * Primeiro JSON válido do texto, ou `null`. Determinístico (primeiro bloco que
 * parsear), tolerante a cerca de código, prosa e repetição. Nunca lança.
 */
export function extrairJsonDoTexto(texto: string): unknown | null {
  // Caminho feliz: o texto inteiro É o JSON.
  const inteiro = tentarParsear(texto);
  if (inteiro !== NADA) return inteiro;

  // Degradação: varre por blocos top-level e devolve o primeiro que parsear.
  for (const bloco of blocosDeNivelSuperior(texto)) {
    const valor = tentarParsear(bloco);
    if (valor !== NADA) return valor;
  }
  return null;
}
/**
 * Primeiro OBJETO JSON do texto, ou `null` — o que todo leitor de veredito quer.
 *
 * `extrairJsonDoTexto` devolve o texto inteiro quando ele todo parseia, e um
 * `[{...}]` vira ARRAY — que passa pela guarda `typeof x !== "object"` dos
 * leitores e chega a eles como veredito sem campo nenhum (triagem do #2144: o
 * guardrail de promessa caía em "sem promessa" sem o warn de parse-fail).
 * Aqui array e escalar no topo não são a resposta: a varredura de blocos acha o
 * primeiro objeto lá dentro — o mesmo que o recorte antigo `{…}` achava.
 */
export function extrairObjetoJsonDoTexto(texto: string): Record<string, unknown> | null {
  const valor = extrairJsonDoTexto(texto);
  if (ehObjeto(valor)) return valor;
  for (const bloco of blocosDeNivelSuperior(texto)) {
    const v = tentarParsear(bloco);
    if (ehObjeto(v)) return v;
  }
  return null;
}

function ehObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
