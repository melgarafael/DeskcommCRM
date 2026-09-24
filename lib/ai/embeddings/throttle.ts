/**
 * RITMO DAS CHAMADAS DE EMBEDDING NA INDEXAÇÃO.
 *
 * ─── O defeito que isto resolve ─────────────────────────────────────────────
 *
 * Medido ao vivo (2026-09-22): reindexar com a chave do Google falhava com
 * *"Quota exceeded for metric: …embed_content_free_tier_requests, limit: 100 …
 * Please retry in 6.6s"*. Não era chave errada nem cota esgotada — era o **teto
 * de requisições por minuto** do plano gratuito. Cada trecho (chunk) do material
 * é UMA requisição; a indexação dispara em rajada e estoura os 100/min. Pior: o
 * worker roda vários materiais em paralelo, somando no mesmo teto.
 *
 * ─── A decisão ──────────────────────────────────────────────────────────────
 *
 * Um espaçador GLOBAL (por processo): garante um intervalo mínimo entre o INÍCIO
 * de duas chamadas de embedding, serializando todos os indexadores concorrentes.
 * O default (800 ms ≈ 75/min) fica abaixo do teto de 100/min com folga para a
 * busca do agente, que é rara.
 *
 * Só o caminho de INDEXAÇÃO usa isto — a busca do agente não pode esperar na fila
 * de um material sendo preparado.
 *
 * `RAG_EMBEDDING_INTERVALO_MS=0` desliga o espaçador (quem tem tier pago e quer
 * velocidade).
 */

const INTERVALO_PADRAO_MS = 800;

function intervaloConfigurado(): number {
  const bruto = process.env.RAG_EMBEDDING_INTERVALO_MS;
  if (bruto === undefined || bruto.trim() === "") return INTERVALO_PADRAO_MS;
  const n = Number(bruto);
  return Number.isFinite(n) && n >= 0 ? n : INTERVALO_PADRAO_MS;
}

/** Quando (epoch ms) a próxima chamada pode começar. 0 = livre. */
let proximoLivre = 0;
/** Fila que serializa o cálculo — sem ela, chamadas concorrentes leriam o mesmo horário. */
let fila: Promise<void> = Promise.resolve();

/**
 * Espera a vez de uma chamada de embedding. Resolve quando é seguro chamar o
 * provedor. Nunca lança.
 */
export function aguardarVezDeEmbedding(): Promise<void> {
  const vez = fila.then(async () => {
    const intervalo = intervaloConfigurado();
    if (intervalo <= 0) return;
    const agora = Date.now();
    const espera = Math.max(0, proximoLivre - agora);
    if (espera > 0) {
      await new Promise((resolve) => setTimeout(resolve, espera));
    }
    proximoLivre = Date.now() + intervalo;
  });
  // A cauda da fila não pode propagar rejeição (nada aqui lança, mas defensivo).
  fila = vez.catch(() => {});
  return vez;
}

/** Só para teste: zera o estado do espaçador. */
export function _resetThrottleDeEmbedding(): void {
  proximoLivre = 0;
  fila = Promise.resolve();
}
