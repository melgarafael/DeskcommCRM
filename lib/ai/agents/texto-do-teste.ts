/**
 * O TEXTO DO TESTE DO AGENTE — a pergunta e a resposta que a aba "Execuções"
 * mostra depois (#4426).
 *
 * ─── Por que um módulo puro, e não dois `slice` nas rotas ───────────────────
 *
 * Os dois lados da mesma coluna precisam da MESMA régua: a rota que escreve
 * (POST `/test`) corta o texto antes do INSERT/UPDATE e a que lê (GET `/runs`)
 * entrega o que está gravado. Duas cópias do limite divergem no dia em que uma
 * for ajustada — e a tela passaria a mostrar um texto que o banco não guardou.
 *
 * ─── Por que cortar, e por que estes números ───────────────────────────────
 *
 * 4000 é o teto do PRÓPRIO schema do POST (`testRunSchema.sample_message`,
 * `lib/ai/agents/validation.ts`): a pergunta não pode chegar maior do que o
 * formulário aceita, e o corte aqui é a rede para o dia em que o schema mudar.
 * A resposta sai do modelo, não de um formulário — 8000 é o teto do `clip()` do
 * `RunTrace`, ou seja, o mesmo que a tela já desenha; guardar mais do que ela
 * mostra encheria a tabela de conteúdo que ninguém lê.
 *
 * O corte é de CARACTERES, não de bytes: a coluna é `text` e o produto é PT-BR
 * com acento — medir bytes cortaria uma resposta no meio de um "ç".
 */

/** O teto da PERGUNTA do teste — o mesmo do schema do POST. */
export const LIMITE_DO_TEXTO_DO_TESTE = 4000;

/** O teto da RESPOSTA do teste — o mesmo do `clip()` que o drawer desenha. */
export const LIMITE_DA_RESPOSTA_DO_TESTE = 8000;

/** A marca de que o texto foi cortado, colada no fim do que ficou. */
const MARCA_DE_CORTE = "… (truncado)";

/**
 * Apara e corta. Devolve `null` para texto vazio.
 *
 * `null` e não `""`: a coluna distingue "não houve texto" (execução real,
 * resposta vazia por aborto) de "houve e era vazio", e a tela desenha as duas
 * de formas diferentes — vazio viraria uma caixa branca sem explicação.
 */
export function textoDoTeste(valor: unknown, limite: number): string | null {
  if (typeof valor !== "string") return null;
  const aparado = valor.trim();
  if (aparado === "") return null;
  if (aparado.length <= limite) return aparado;
  // O corte desconta a marca para o resultado não passar do teto: um texto de
  // 4001 caracteres não pode virar 4014 e ser recusado pelo mesmo limite que o
  // gerou.
  return `${aparado.slice(0, limite - MARCA_DE_CORTE.length)}${MARCA_DE_CORTE}`;
}

/** A pergunta do teste, no teto do formulário. */
export function perguntaDoTeste(valor: unknown): string | null {
  return textoDoTeste(valor, LIMITE_DO_TEXTO_DO_TESTE);
}

/** A resposta final do teste, no teto do que a tela desenha. */
export function respostaDoTeste(valor: unknown): string | null {
  return textoDoTeste(valor, LIMITE_DA_RESPOSTA_DO_TESTE);
}
