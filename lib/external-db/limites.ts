/**
 * Os LIMITES DE LEITURA do banco externo — configuráveis por conexão.
 *
 * ─── Por que existe uma faixa, e não só o valor ─────────────────────────────
 *
 * Cada organização tem um processo diferente: uma lê 20 linhas e pronto, outra
 * precisa varrer centenas com muitos filtros. O valor cravado no código forçava
 * todo mundo no mesmo teto. Agora quem administra a conexão escolhe o teto DENTRO
 * de uma faixa — os mínimos e máximos daqui são o piso e o teto ABSOLUTOS, os
 * mesmos aplicados no CHECK do banco e no Zod das rotas.
 *
 * ─── O que cada limite faz ──────────────────────────────────────────────────
 *
 *  - `linhas`: teto de linhas por consulta (grade da tela E tools do agente).
 *  - `filtros`: teto de condições (`where`) numa consulta da IA.
 *  - `respostaBytes`: teto de bytes da resposta devolvida ao MODELO (o dado que
 *    entra no contexto). A grade da tela não passa por ele.
 *
 * Módulo CLIENT-SAFE: só números, sem zod/supabase/next — o formulário da tela
 * importa daqui para os `min`/`max` dos campos.
 */

export const LIMITE_LINHAS = { minimo: 1, maximo: 5000, padrao: 200 } as const;
export const LIMITE_FILTROS = { minimo: 0, maximo: 100, padrao: 20 } as const;
export const LIMITE_RESPOSTA_BYTES = { minimo: 4_096, maximo: 1_048_576, padrao: 30_000 } as const;

/** Página padrão da grade (o teto efetivo é o `max_rows` da conexão). */
export const LIMITE_PADRAO_DA_GRADE = 50;
