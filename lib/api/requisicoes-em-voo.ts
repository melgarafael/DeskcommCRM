/**
 * AS REQUISIÇÕES DO CLIENTE HTTP QUE AINDA NÃO TERMINARAM.
 *
 * Cada chamada de `apiClient` entra aqui ao começar e sai ao terminar — com
 * resposta, erro ou cancelamento. Quem precisa encerrar o que ficou para trás
 * chama `cancelarRequisicoesEmVoo()`, e cada uma delas cai no mesmo caminho de
 * quem cancela pelo próprio `signal`: o `fetch` em curso é abortado, a espera
 * entre tentativas é interrompida e não há tentativa seguinte.
 *
 * ─── Por que existe ─────────────────────────────────────────────────────────
 *
 * Quem chama hoje é o setup dos testes (`tests/setup/vitest.setup.ts`), depois
 * de desmontar a tela de cada caso. Uma tela renderizada sem dublê de rede faz
 * leituras reais que falham (`sem_conexao`), e o cliente as repete com espera
 * crescente — trabalho que sobrevive ao teste, porque quase nenhuma leitura do
 * front repassa `signal` e desmontar não a cancela (para medir:
 * `git grep -n "apiClient.get" -- hooks app components | grep -vc signal`). Desde que o retry
 * passou a escrever `request_retried` (#4910), a linha da última tentativa às
 * vezes cai quando o vitest já está fechando o worker, e a parte inteira do
 * `verify` reprova com todos os testes verdes:
 *
 *     EnvironmentTeardownError: [vitest-worker]: Closing rpc while
 *     "onUserConsoleLog" was pending
 *
 * Módulo próprio, e não dentro de `client.ts`, de propósito: 254 arquivos de
 * teste fazem `vi.mock("@/lib/api/client")`, e um módulo importado pelo setup
 * fica em cache antes do mock — o setup que importasse o cliente desligaria
 * esses mocks.
 */
const emVoo = new Set<AbortController>();

/** Registra uma requisição que começou, pelo controle que a cancela. */
export function entrarEmVoo(controle: AbortController): void {
  emVoo.add(controle);
}

/** Tira do registro uma requisição que terminou, por qualquer caminho. */
export function sairDeVoo(controle: AbortController): void {
  emVoo.delete(controle);
}

/** Cancela todas as requisições que ainda não terminaram. */
export function cancelarRequisicoesEmVoo(motivo: string): void {
  for (const controle of emVoo) {
    controle.abort(new DOMException(motivo, "AbortError"));
  }
  emVoo.clear();
}
