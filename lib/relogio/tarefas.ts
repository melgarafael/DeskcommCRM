/**
 * Trabalhos de MINUTO para instalação sem agendador próprio.
 *
 * No self-host o contêiner `scheduler` já chama cada rota. Esta lista é o
 * que o relógio HTTP (GitHub Actions, cron-job.org, botão na tela) precisa
 * cobrir para follow-up, fila e dreno de eventos não pararem.
 */
export const TAREFAS_DO_RELOGIO = [
  {
    id: "event-log-drain",
    rotulo: "Ler a fila de eventos",
    porque: "Acorda automações e o follow-up quando chega mensagem.",
  },
  {
    id: "followup-flow-worker",
    rotulo: "Andar os follow-ups",
    porque: "É o passo que manda a próxima pergunta depois do SIM.",
  },
  {
    id: "routing-worker",
    rotulo: "Distribuir conversas",
    porque: "Conversa nova sem dono entra na fila do atendente certo.",
  },
  {
    id: "recover-stuck-messages",
    rotulo: "Destravar envios parados",
    porque: "Mensagem presa em «enviando» deixa de mentir progresso.",
  },
] as const;

export type IdDeTarefaDoRelogio = (typeof TAREFAS_DO_RELOGIO)[number]["id"];

export const CAMINHO_DO_TICK = "/api/v1/system/relogio/tick";

export function comandoCurlDoRelogio(appUrl: string): string {
  const base = appUrl.replace(/\/$/, "");
  return `curl -fsS -X POST -H "Authorization: Bearer $INTERNAL_SECRET" "${base}${CAMINHO_DO_TICK}"`;
}

/** URL absoluta do tick — para colar em cron-job.org / GitHub Actions. */
export function urlDoTickDoRelogio(appUrl: string): string {
  return `${appUrl.replace(/\/$/, "")}${CAMINHO_DO_TICK}`;
}
