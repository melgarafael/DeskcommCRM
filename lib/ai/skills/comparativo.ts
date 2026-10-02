/**
 * Comparativo entre a cópia da organização e a versão atual do catálogo de uma
 * skill, produzido ANTES de adotar (issue #1962, resto da #1927/#1951 após o
 * #1960). Única fonte da regra: o GET /api/v1/ai/skills e o primeiro paint de
 * /app/ai/skills leem daqui, para o operador ver O QUE mudou entre a cópia
 * editada e a versão nova antes de decidir adotar.
 *
 * O comparativo é por NOME de campo da versão (descricao, matcher, corpo) — cada
 * um sinaliza se divergiu —, mais o diff de LINHAS do procedimento (linhas
 * adicionadas/removidas). Não é um diff de texto cru: é o sumário nomeado que a
 * tela mostra. A descrição e o corpo vêm das colunas da versão; o matcher é o
 * jsonb de palavras-chave.
 */
export interface ComparativoMatcher {
  // Opcional de propósito: a coluna `skill_versions.matcher` tem default `'{}'`,
  // e um matcher sem `any_keywords` não pode derrubar o GET /skills e o SSR.
  any_keywords?: string[];
  probe_keywords?: string[];
}

export interface ComparativoEntrada {
  description: string;
  body: string;
  matcher: ComparativoMatcher;
}

export interface ComparativoSkill {
  descricao_mudou: boolean;
  matcher_mudou: boolean;
  /** Palavras-chave que ENTRAM ao adotar: estão no catálogo e não na cópia. */
  any_adicionadas: string[];
  /**
   * Palavras-chave que SAEM ao adotar: estão na cópia e não no catálogo. Podem
   * ser edição da própria organização, não remoção do catálogo — o diff é de
   * duas vias (cópia × catálogo), sem a versão de origem.
   */
  any_removidas: string[];
  corpo_mudou: boolean;
  linhas_adicionadas: number;
  linhas_removidas: number;
  /** Nomes dos campos que divergiram — caso factual de "o que mudou". */
  mudou_em: Array<"descricao" | "matcher" | "corpo">;
  /** Sumário nomeado em PT-BR, para API/consumidores. */
  resumo: string;
}

/** Diferença de lista preservando ordem — o que está num lado e não no outro. */
function diffList<T>(base: readonly T[], alvo: readonly T[]): { adicionadas: T[]; removidas: T[] } {
  const noAlvo = new Set(alvo);
  const naBase = new Set(base);
  return {
    adicionadas: alvo.filter((x) => !naBase.has(x)),
    removidas: base.filter((x) => !noAlvo.has(x)),
  };
}

/**
 * Conta linhas adicionadas/removidas no procedimento via LCS por linha. Corpos
 * têm teto de 200 linhas (`MAX_SKILL_BODY_LINES`), então o DP O(n·m) é barato.
 */
export function diffLinhas(base: string, alvo: string): { adicionadas: number; removidas: number } {
  const linhasDe = (texto: string): string[] => (texto === "" ? [] : texto.split("\n"));
  const a = linhasDe(base);
  const b = linhasDe(alvo);
  const n = a.length;
  const m = b.length;
  // dp[i][j] = tamanho do LCS entre a[0..i) e b[0..j)
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i += 1) {
    const linhaA = a[i - 1]!;
    const linhaAtual = dp[i]!;
    const linhaAnterior = dp[i - 1]!;
    for (let j = 1; j <= m; j += 1) {
      linhaAtual[j] =
        linhaA === b[j - 1]!
          ? linhaAnterior[j - 1]! + 1
          : Math.max(linhaAnterior[j]!, linhaAtual[j - 1]!);
    }
  }
  const lcs = dp[n]?.[m] ?? 0;
  return {
    adicionadas: m - lcs,
    removidas: n - lcs,
  };
}

const CAMPO_ARTIGO: Record<ComparativoSkill["mudou_em"][number], string> = {
  descricao: "a descrição",
  matcher: "as palavras-chave de ativação",
  corpo: "o procedimento (corpo)",
};

/** Junta "a descrição" + "o procedimento (corpo)" → "a descrição e o procedimento (corpo)". */
function montarResumo(mudouEm: ComparativoSkill["mudou_em"]): string {
  if (mudouEm.length === 0) return "Nada mudou entre a cópia e o catálogo.";
  if (mudouEm.length === 1) return `Mudou só ${CAMPO_ARTIGO[mudouEm[0]!]}`;
  const ultimo = mudouEm[mudouEm.length - 1]!;
  const antes = mudouEm.slice(0, -1).map((campo) => CAMPO_ARTIGO[campo]);
  const texto = `${antes.join(", ")} e ${CAMPO_ARTIGO[ultimo]}`;
  return `Mudou ${texto}`;
}

/**
 * Compara a versão que a ORGANIZAÇÃO tem no ar com a versão atual do CATÁLOGO.
 * Campos que divergem entram em `mudou_em`; o corpo leva contagem de linhas
 * adicionadas/removidas. O pior caso (uma das entradas sem corpo) → nada muda.
 */
export function compararSkill(org: ComparativoEntrada, catalogo: ComparativoEntrada): ComparativoSkill {
  const descricao_mudou = org.description !== catalogo.description;

  const anyDiff = diffList(org.matcher.any_keywords ?? [], catalogo.matcher.any_keywords ?? []);
  const matcher_mudou =
    anyDiff.adicionadas.length > 0 || anyDiff.removidas.length > 0;

  const linhas = diffLinhas(org.body, catalogo.body);
  const corpo_mudou = linhas.adicionadas > 0 || linhas.removidas > 0;

  const mudou_em: ComparativoSkill["mudou_em"] = [];
  if (descricao_mudou) mudou_em.push("descricao");
  if (matcher_mudou) mudou_em.push("matcher");
  if (corpo_mudou) mudou_em.push("corpo");

  return {
    descricao_mudou,
    matcher_mudou,
    any_adicionadas: anyDiff.adicionadas,
    any_removidas: anyDiff.removidas,
    corpo_mudou,
    linhas_adicionadas: linhas.adicionadas,
    linhas_removidas: linhas.removidas,
    mudou_em,
    resumo: montarResumo(mudou_em),
  };
}