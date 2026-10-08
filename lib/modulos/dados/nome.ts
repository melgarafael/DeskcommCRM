/**
 * A regra de NOME da tabela de um objeto declarado — pura, sem dependência de servidor.
 *
 * Mora num módulo próprio (e não ao lado do resolvedor, que é `server-only`) porque ela precisa ser
 * chamável de QUALQUER lugar: o invariante que a amarra ao SQL roda contra um Postgres real, fora do
 * ambiente do Next, e um `import "server-only"` no caminho faz a suíte nem coletar.
 *
 * É a MESMA regra do compilador (`fn_modulo_dados_compilar`): prefixo fixo, publicador, módulo e
 * objeto, com `-` virando `_`. Duas implementações da mesma regra é dívida, e a forma de pagá-la é o
 * invariante `tests/invariants/modulo-de-dados-compilador.test.ts`, que compara este nome com a
 * tabela que o banco criou de verdade. Mudar um lado só reprova lá, em vez de virar 404 em produção.
 */
export function nomeDaTabela(publicador: string, modulo: string, objeto: string): string {
  const limpo = (s: string) => s.replaceAll("-", "_");
  return `m_${limpo(publicador)}_${limpo(modulo)}_${objeto}`;
}
