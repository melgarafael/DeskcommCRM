/**
 * A FALHA FOI DO BANCO? — a pergunta que faltava ao teste do agente (#4020).
 *
 * A rota `POST /ai/agents/:id/versions/:vid/test` tinha um `catch` só, e todo
 * erro virava a mesma frase: "Confira modelo, credencial e materiais do agente".
 * Quando o banco não respondia (`Query read timeout`), a tela mandava a pessoa
 * reinstalar credencial e reindexar a base — e ela fazia isso, porque a frase
 * dizia que era ali o problema. Duas instalações recriaram credenciais, agentes
 * e artigos por causa de um timeout de banco.
 *
 * A régua aqui é a MESMA dos outros lugares em que o produto prefere calar a
 * afirmar sem prova (`voice_estado_indeterminado`, `ehFalhaTransitoria` ao
 * contrário): **só se responde "é o banco" quando o erro PROVA isso.** O que
 * não casa continua com a frase de hoje — inclusive a exceção desconhecida,
 * que não é acusada de ser banco nem de ser credencial.
 *
 * O que conta como prova:
 *
 *   - SQLSTATE (`err.code`) das classes que dizem "o banco não está ali para
 *     atender": conexão (08xxx), rollback de transação (40xxx, deadlock/
 *     serialização — tentar de novo resolve), recurso (53xxx), intervenção do
 *     operador (57xxx, e é aí que mora o `57014` de `statement timeout`),
 *     erro de sistema (58xxx).
 *   - Mensagem que só o driver/pool do Postgres produz — `Query read timeout`
 *     (o `query_timeout` do `pg` chega SEM `code`; medido em
 *     `lib/agent-engine/db/pool.test.ts`), socket derrubado, pooler saturado,
 *     banco subindo/desligando.
 *   - O pool do engine sem endereço (`SUPABASE_DB_URL ausente`, lançado por
 *     `getRequestPool`): não há banco para responder, e credencial do agente
 *     não tem relação nenhuma com isso.
 *
 * O que NÃO conta, de propósito:
 *
 *   - `ECONNREFUSED`, `ETIMEDOUT`, `fetch failed` sozinhos: são rede, e a mesma
 *     marca aparece quando quem não responde é o PROVEDOR de IA. Dizer "banco"
 *     aí seria trocar uma acusação errada por outra.
 *   - Qualquer mensagem que só contenha "timeout": o erro de provedor diz
 *     "timeout" também.
 *   - Erro sem código e sem mensagem conhecida → `false`. Indefinido não acusa.
 *
 * Não se desce em `err.cause`: o `pg` não embrulha o erro dele, e procurar
 * causa em cadeia transformaria um erro de provedor que embala um `fetch
 * failed` em "problema de banco". Quem provar embrulho no meio do motor
 * (`lib/agent-engine/agent/**`) acrescenta o ramo aqui, com o caminho no
 * comentário e um caso no teste.
 */

/**
 * Classes de SQLSTATE em que o banco EXISTE mas não conseguiu atender agora —
 * as `22xxx` (dado) e `23xxx` (integridade) ficam de fora de propósito: elas
 * são defeito de dado/código, e "o banco não respondeu" seria falso.
 */
const SQLSTATE_SEM_ATENDIMENTO = /^(08|40|53|57|58)[0-9A-Z]{3}$/;

/**
 * Frases que o driver/pool do Postgres e o pooler produzem. Cada uma foi
 * escolhida por ser exclusiva deste caminho — nenhuma aparece em erro de
 * provedor de IA, nem em erro de rede genérico.
 */
const MENSAGENS_DO_BANCO: readonly RegExp[] = [
  // `query_timeout` do `pg`: o socket ficou mudo e a leitura estourou.
  /query read timeout/i,
  // Servidor/pooler derrubou a conexão no meio (restart do Postgres, blip).
  /connection terminated/i,
  /terminating connection due to administrator command/i,
  /the database system is (starting up|shutting down|in recovery mode)/i,
  /cannot connect now/i,
  // Fila do pool estourada no servidor.
  /too many clients already/i,
  /timeout exceeded when trying to connect/i,
  // `getRequestPool()` sem `SUPABASE_DB_URL` — a instalação não tem banco da IA.
  /supabase_db_url ausente/i,
];

/**
 * `true` só quando dá para PROVAR que a falha veio do banco. Ver o cabeçalho:
 * o custo de um falso positivo é mandar a pessoa olhar o lugar errado de novo.
 */
export function ehFalhaDoBanco(err: unknown): boolean {
  const codigo = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof codigo === "string" && SQLSTATE_SEM_ATENDIMENTO.test(codigo.trim())) {
    return true;
  }

  const mensagem = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (mensagem === "") return false;

  return MENSAGENS_DO_BANCO.some((padrao) => padrao.test(mensagem));
}
