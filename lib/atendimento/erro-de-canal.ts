/**
 * "NÃO TEM POR ONDE ATENDER" — o erro do `fn_service_begin`, reconhecido num lugar só.
 *
 * ─── O erro ──────────────────────────────────────────────────────────────────
 *
 * `fn_service_begin` (baseline `:19953` e a versão vigente em `:52672`) abre o
 * atendimento de um contato e precisa de uma sessão de canal não arquivada na
 * organização. Sem nenhuma — instalação fresca, nenhum número pareado —, ela
 * levanta de propósito:
 *
 *     raise exception 'service_channel_not_found' using errcode='P0002';
 *
 * O banco está certo: sem canal não há conversa para nascer. O que faltava era
 * quem chama reconhecer a recusa em vez de vazar a exceção crua (o 500 sem
 * corpo do #3923).
 *
 * ─── POR QUE A MENSAGEM, E NÃO O `errcode` ───────────────────────────────────
 *
 * `P0002` é `no_data_found` — o código GENÉRICO do Postgres para "a consulta não
 * achou linha". Ele é usado em dezenas de funções do baseline com mensagens
 * diferentes (`parcela_nao_encontrada`, `agenda_slot_nao_encontrado`, …), então
 * um `erro.code === "P0002"` sozinho diria "não achei alguma coisa" e cada
 * chamador escolheria um status diferente para o mesmo código.
 *
 * O discriminador é a MENSAGEM, que é o nome estável do erro de negócio — é
 * exatamente o que a régua já existente usa: `lib/contacts/conversa-ao-criar.ts`
 * lê `erro.message` (`mensagemDoErro`) e o teste dela prova o par
 * `{ code: "P0002", message: "service_channel_not_found" }` chegando como
 * `detail: "service_channel_not_found"` no log (`conversa-ao-criar.test.ts:220`).
 * Este módulo é aquela leitura, extraída — para a inscrição no follow-up
 * reconhecer o MESMO erro pela MESMA régua, em vez de inventar uma segunda.
 *
 * O objeto que chega aqui é o erro do PostgREST (`{ code, message, details,
 * hint }`), não um `Error`: `String(erro)` viraria "[object Object]" e o
 * reconhecimento nunca casaria. Daí `mensagemDoErro` existir.
 */

/** O nome do erro de negócio levantado por `fn_service_begin` quando não há canal. */
export const ERRO_SEM_CANAL = "service_channel_not_found";

/**
 * A mensagem de um erro do PostgREST — que NÃO é um `Error` (`instanceof` falha).
 * O último degrau é `String(erro)`, e não `""`: quem já registrava o erro do
 * `catch` de `conversa-ao-criar` mantém o mesmo `detail` no log.
 */
export function mensagemDoErro(erro: unknown): string {
  if (erro instanceof Error) return erro.message;
  if (erro && typeof erro === "object") {
    const { message } = erro as { message?: unknown };
    if (typeof message === "string" && message.length > 0) return message;
  }
  return String(erro);
}

/**
 * A recusa é "esta instalação não tem número conectado"?
 *
 * Casa pela mensagem (ver o cabeçalho): `P0002` sozinho é genérico demais para
 * separar "sem canal" de qualquer outra linha que a consulta não achou.
 */
export function ehSemCanalDeAtendimento(erro: unknown): boolean {
  return mensagemDoErro(erro) === ERRO_SEM_CANAL;
}
