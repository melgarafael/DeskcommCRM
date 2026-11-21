/**
 * AGRUPAR "SUAS CAMPANHAS" POR NICHO (#4956, fatia PR9).
 *
 * A lista de campanhas sempre veio na ordem do servidor (`created_at desc`) e o
 * nicho só aparecia DENTRO da campanha aberta. Quem roda várias ofertas para o
 * mesmo público — padarias, clínicas, imobiliárias — lia a lista inteira para
 * descobrir onde estavam as campanhas daquele nicho.
 *
 * O agrupamento é de APRESENTAÇÃO e nada mais: nenhum campo é gravado, nenhuma
 * campanha muda de lugar no banco e nenhuma contagem do cartão é recalculada. O
 * que a tela faz é desenhar um cabeçalho por nicho e pôr as campanhas embaixo.
 *
 * Três decisões que o teste trava (e que um agrupamento ingênuo erra):
 *
 * 1. **A ORDEM NÃO MUDA.** Cada grupo aparece onde a primeira campanha dele
 *    apareceria — nada de reordenar por nome de nicho, que jogaria a campanha
 *    de ontem para o fim da tela. Dentro do grupo, a ordem é a que veio.
 * 2. **CAMPANHA SEM NICHO TEM GRUPO PRÓPRIO, e ele é nomeado.** `search` nulo
 *    (campanha gravada antes de o nicho existir, ou jsonb velho) e nicho vazio
 *    caem em `nicho: null`, nunca num grupo "" sem cabeçalho e nunca somem.
 * 3. **O NICHO É COMPARADO SEM CAIXA.** "Padarias" e "padarias" são o MESMO
 *    público para quem lê a tela, e dois cabeçalhos iguais a menos de uma
 *    maiúscula seriam ruído. O rótulo mostrado é o da PRIMEIRA campanha do
 *    grupo — o texto do operador, sem normalizar o que ele digitou.
 *
 * Mora em módulo próprio (e não em `_client.tsx`) porque a régua é testável sem
 * DOM, do mesmo jeito que `arquivamento.ts` — e porque o PR #4958 também mexe na
 * lista: manter isto fora da tela deixa os dois PRs em arquivos diferentes.
 */
export type GrupoPorNicho<T> = {
  /** O nicho em minúsculas, sem espaços nas pontas. `null` = campanhas sem nicho. */
  chave: string | null;
  /** O nicho como a PRIMEIRA campanha do grupo o escreveu — é o rótulo do cabeçalho. */
  nicho: string | null;
  campanhas: T[];
};

type ComNicho = { search: { niche?: string | null } | null };

/**
 * O nicho como está gravado, ou `null` quando não há: `search` nulo, texto vazio
 * ou um valor que não é string (o `search` é jsonb e já teve formato antigo).
 */
function nichoEscrito(campanha: ComNicho): string | null {
  const bruto = campanha.search?.niche;
  if (typeof bruto !== "string") return null;
  const limpo = bruto.trim();
  return limpo === "" ? null : limpo;
}

/**
 * As campanhas agrupadas por nicho, na ordem em que os nichos aparecem. Soma dos
 * grupos é SEMPRE a lista de entrada, na mesma ordem — quem chama não perde
 * campanha nem contagem.
 */
export function agruparPorNicho<T extends ComNicho>(
  campanhas: readonly T[],
): GrupoPorNicho<T>[] {
  const grupos: GrupoPorNicho<T>[] = [];
  const porChave = new Map<string | null, GrupoPorNicho<T>>();

  for (const campanha of campanhas) {
    const escrito = nichoEscrito(campanha);
    const chave = escrito === null ? null : escrito.toLocaleLowerCase("pt-BR");
    const existente = porChave.get(chave);
    if (existente) {
      existente.campanhas.push(campanha);
      continue;
    }
    const novo: GrupoPorNicho<T> = { chave, nicho: escrito, campanhas: [campanha] };
    porChave.set(chave, novo);
    grupos.push(novo);
  }

  return grupos;
}
