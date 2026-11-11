import type { ToolSet } from 'ai';

/**
 * AS MENSAGENS DE UM PASSO SAEM NA ORDEM EM QUE O MODELO AS ESCREVEU.
 *
 * ─── O defeito medido ───────────────────────────────────────────────────────
 *
 * Num passo, o modelo pode chamar `send_message` mais de uma vez (ou combinar
 * texto com template, catálogo ou passagem para humano), e o AI SDK executa as
 * chamadas do mesmo passo AO MESMO TEMPO. Cada uma rodava a cadeia `before_send`
 * sozinha e enviava quando ganhava o lock do número — a ordem de saída era a de
 * chegada ao lock. A pausa humana (uma por turno) caía sobre a primeira chamada,
 * em geral a abertura, que ficava para trás.
 *
 * Medido numa VPS de produção (v1.102.0, 08/11/2026): o agente respondeu em três
 * mensagens e "Boa pergunta! Pelo nome, acho que você quis dizer Enterprise",
 * que abria a resposta, chegou por último, seis segundos depois das outras.
 *
 * ─── O conserto ─────────────────────────────────────────────────────────────
 *
 * As ferramentas que falam com o cliente dividem UMA fila por turno. Cada
 * chamada pega a vez ao entrar, de forma síncrona, e só executa depois que a
 * anterior terminou (enviou, foi vetada ou falhou — a vez é liberada no
 * `finally`). Executar a chamada inteira em série, e não só o envio, é o que
 * mantém corretos o teto de envios do turno, a checagem de resposta obsoleta e a
 * de duplicata: cada chamada lê o estado que a anterior deixou.
 *
 * O custo é a cadeia de cada mensagem rodar depois da anterior — da mesma ordem
 * de grandeza do intervalo que o anti-ban já impõe entre mensagens.
 *
 * A vez precisa ser pega na ORDEM DO MODELO: o SDK inicia as chamadas na ordem do
 * passo, e o único embrulho assíncrono por fora deste (`guardServiceTools`, em
 * `lib/atendimento/fronteira-server.ts`) preserva essa ordem.
 */
export function criarFilaDeEnvio(): <R>(corpo: () => Promise<R>) => Promise<R> {
  let cauda: Promise<void> = Promise.resolve();
  return async (corpo) => {
    // Síncrono até o primeiro `await`: a posição na fila é a ordem de entrada.
    const anterior = cauda;
    let liberar!: () => void;
    cauda = new Promise<void>((resolve) => {
      liberar = resolve;
    });
    try {
      await anterior;
      return await corpo();
    } finally {
      liberar();
    }
  };
}

/** As ferramentas do turno que mandam mensagem ao cliente. */
export const FERRAMENTAS_QUE_FALAM_COM_O_CLIENTE = [
  'send_message',
  'send_template',
  'present_catalog_items',
  'request_human_handoff',
] as const;

/** Põe as ferramentas nomeadas numa fila única; as demais seguem como estão. */
export function emOrdemDeEscrita<T extends ToolSet>(
  tools: T,
  nomes: readonly string[] = FERRAMENTAS_QUE_FALAM_COM_O_CLIENTE,
): T {
  const naFila = criarFilaDeEnvio();
  return Object.fromEntries(
    Object.entries(tools).map(([nome, definicao]) => {
      const execute = definicao.execute;
      if (!nomes.includes(nome) || !execute) return [nome, definicao];
      return [
        nome,
        {
          ...definicao,
          execute: (...args: Parameters<typeof execute>) => naFila(async () => execute(...args)),
        },
      ];
    }),
  ) as T;
}
