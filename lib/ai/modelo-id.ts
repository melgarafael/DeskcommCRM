/**
 * As formas em que o id de um modelo chega — e a forma canônica de cada uma.
 *
 * Mora aqui, e não em `lib/ai/runtime/cost.ts`, porque DUAS regras dependem
 * dela: o match do catálogo de preço e o degrau do Haiku 5.5
 * (`lib/ai/custo-escalonado.ts`, #4123). Manter a normalização no módulo do
 * catálogo faria o degrau importar de volta quem importa o degrau — ciclo.
 * `lib/ai/runtime/cost.ts` reexporta esta função, então quem já a importava de
 * lá continua funcionando.
 */

/**
 * Gera os ids canônicos a tentar contra a tabela, do mais específico para o
 * generalista — o match nunca escolhe um generalista quando o exato existe.
 *
 * O catálogo (`ai_models`) guarda `model_id` como o provedor o nomeia: na
 * Anthropic/OpenAI sem prefixo, num roteador com prefixo `provider/`
 * (`anthropic/claude-haiku-4-5`). O id que chega pode trazer três variações que
 * o catálogo não conhece e que a normalização absorve:
 *
 *  - sufixo de variante do roteador (`:beta`, `:free`) — mas o id CRU, com o
 *    sufixo, é sempre o primeiro candidato: `<m>:free` tem linha própria no
 *    catálogo da OpenRouter, com preço 0, e ela vence a linha paga `<m>`;
 *  - prefixo `provider/` já embutido no `model` (issue #1929);
 *  - a versão grafada com ponto (`claude-haiku-4.5`) em vez do hífen do
 *    catálogo (`claude-haiku-4-5`) — o caso desta issue (#1931).
 */
export function normalizarModeloId(model: string): string[] {
  // `:free`, `:beta`, `:beta:free` — o OpenRouter anexa variantes ao id.
  const comPrefixo = (model.split(":")[0] ?? "").trim();
  const nome = comPrefixo.includes("/")
    ? comPrefixo.slice(comPrefixo.indexOf("/") + 1)
    : comPrefixo;

  const candidatos: string[] = [];
  const ordem = [
    model.trim(), // como veio, com o sufixo — o exato vence
    comPrefixo, // só com o sufixo recortado
    comPrefixo.replace(/\./g, "-"), // grafia do catálogo com hífen
    nome, // recorte do prefixo
    nome.replace(/\./g, "-"), // recorte do prefixo + hífen
  ];
  for (const c of ordem) {
    if (c && c.length > 0 && !candidatos.includes(c)) candidatos.push(c);
  }
  return candidatos;
}
