/**
 * AS BOLHAS SAEM NA ORDEM EM QUE O MODELO AS ESCREVEU.
 *
 * ─── O defeito medido ───────────────────────────────────────────────────────
 *
 * Num passo, o modelo pode chamar `send_message` mais de uma vez, e o AI SDK
 * executa as chamadas do mesmo passo AO MESMO TEMPO (`Promise.all` em
 * `executeTools`). Cada chamada roda a cadeia `before_send` sozinha e só envia
 * quando ganha o lock do número — então a ordem de saída era a ordem em que as
 * cadeias terminavam, não a do modelo. E a pausa humana (uma por turno) cai em
 * cima da primeira chamada a chegar, que costuma ser a abertura: ela fica
 * segurando a pausa enquanto as outras passam direto para o lock.
 *
 * Medido numa VPS de produção (v1.102.0, 08/11/2026): o agente respondeu em três
 * bolhas e o "Boa pergunta! Pelo nome, acho que você quis dizer Enterprise",
 * que abria a resposta, chegou por último, seis segundos depois das outras.
 *
 * ─── O conserto ─────────────────────────────────────────────────────────────
 *
 * Cada chamada pega a vez ao ENTRAR no `execute`, de forma síncrona (antes do
 * primeiro `await`), e só pode tomar o lock depois que a chamada anterior
 * terminou. A cadeia de cada uma (as consultas ao modelo, inclusive) continua
 * rodando em paralelo: só o envio espera a vez. A vez é liberada no `finally`
 * — veto, recusa, erro ou envio, a chamada seguinte nunca fica presa.
 *
 * A ordem de entrada é a ordem das chamadas no passo: o SDK as percorre em
 * ordem e cada uma passa pelos mesmos `await`s antes de chegar ao `execute`.
 */
export type VezNaFila = {
  /** Resolve quando a chamada anterior do turno terminou (enviou, foi vetada ou falhou). */
  anterior: Promise<void>;
};

export function criarFilaDeEnvio(): <A, R>(
  args: A,
  corpo: (args: A, vez: VezNaFila) => Promise<R>,
) => Promise<R> {
  let cauda: Promise<void> = Promise.resolve();
  return async (args, corpo) => {
    // Síncrono até aqui: a posição na fila é a ordem de chamada, não a de chegada ao lock.
    const anterior = cauda;
    let liberar!: () => void;
    cauda = new Promise<void>((resolve) => {
      liberar = resolve;
    });
    try {
      return await corpo(args, { anterior });
    } finally {
      liberar();
    }
  };
}
