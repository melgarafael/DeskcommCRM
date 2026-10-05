import { normalizar } from "@/lib/catalogo/busca";

/**
 * Uma opção de caixa de seleção com busca.
 *
 * `label` é o que a pessoa lê e o que a busca procura. `keywords` existe para o
 * que a pessoa DIGITA mas não lê — o identificador técnico do modelo
 * (`anthropic/claude-haiku-4-5`), por exemplo. O `value` fica de fora da busca
 * de propósito: quando é um uuid, qualquer letra de `a` a `f` casaria com quase
 * todas as opções.
 */
export interface OpcaoDeSelecao {
  value: string;
  label: string;
  keywords?: readonly string[];
  disabled?: boolean;
}

/**
 * Filtra por palavras: cada palavra da busca precisa aparecer no rótulo ou nas
 * keywords, em qualquer ordem — "4 sonnet" acha "Claude Sonnet 4.6". Acento,
 * caixa e pontuação são ignorados pelo mesmo `normalizar` da busca do catálogo,
 * para "sao paulo" achar "São Paulo".
 */
export function filtrarOpcoes<T extends OpcaoDeSelecao>(opcoes: readonly T[], busca: string): T[] {
  const termos = normalizar(busca).split(" ").filter(Boolean);
  if (termos.length === 0) return [...opcoes];
  return opcoes.filter((opcao) => {
    const alvo = normalizar([opcao.label, ...(opcao.keywords ?? [])].join(" "));
    return termos.every((termo) => alvo.includes(termo));
  });
}
