/**
 * Configuração do projeto na Vercel.
 *
 * Os crons abaixo são a MESMA cadência de `docker/scheduler/entrypoint.sh`.
 * Plano Pro: minuto a minuto vale. Hobby: expressões mais frequentes que
 * 1×/dia derrubam o deploy — nesse caso deixe só o `lgpd-sla-watcher` e use
 * o relógio HTTP (`docs/runbooks/vercel-hobby-relogio.md`).
 *
 * Auth: Vercel Cron manda Bearer CRON_SECRET; em produção `lib/env.ts` copia
 * isso para INTERNAL_CRON_SECRET. INTERNAL_SECRET continua valendo nas rotas.
 */

import type { VercelConfig } from "@vercel/config/v1";

const config: VercelConfig = {
  crons: [
    { path: "/api/v1/cron/agent-dispatcher", schedule: "* * * * *" },
    { path: "/api/v1/cron/followup-flow-worker", schedule: "* * * * *" },
    { path: "/api/v1/cron/event-log-drain", schedule: "* * * * *" },
    { path: "/api/v1/cron/routing-worker", schedule: "* * * * *" },
    { path: "/api/v1/cron/recover-stuck-messages", schedule: "* * * * *" },
    { path: "/api/v1/cron/storage-redaction", schedule: "*/5 * * * *" },
    { path: "/api/v1/cron/snooze-watcher", schedule: "*/5 * * * *" },
    { path: "/api/v1/cron/attendant-heartbeat", schedule: "*/5 * * * *" },
    { path: "/api/v1/cron/webhook-log-retention", schedule: "*/5 * * * *" },
    { path: "/api/v1/cron/channel-health", schedule: "*/5 * * * *" },
    { path: "/api/v1/cron/agenda-google-push", schedule: "*/5 * * * *" },
    { path: "/api/v1/cron/agenda-reminder", schedule: "*/5 * * * *" },
    // Entraram na `main` depois que este PR foi escrito (lotes 3 e 4+5 da
    // triagem de 14/set). O gate `cron-routes-scheduled` compara este
    // inventário com o do scheduler e reprova quando eles divergem.
    { path: "/api/v1/cron/agenda-expira-pendentes", schedule: "*/15 * * * *" },
    { path: "/api/v1/cron/case-stale-watcher", schedule: "7 * * * *" },
    { path: "/api/v1/cron/contact-birthdays", schedule: "7 * * * *" },
    { path: "/api/v1/cron/contact-avatars", schedule: "*/10 * * * *" },
    { path: "/api/v1/cron/agenda-google-refresh", schedule: "*/10 * * * *" },
    { path: "/api/v1/cron/agenda-google-sync", schedule: "*/15 * * * *" },
    { path: "/api/v1/cron/risk-watcher", schedule: "*/15 * * * *" },
    { path: "/api/v1/cron/contact-phones", schedule: "*/30 * * * *" },
    { path: "/api/v1/cron/contact-proposals-watcher", schedule: "17 * * * *" },
    { path: "/api/v1/cron/lgpd-sla-watcher", schedule: "0 12 * * *" },
    { path: "/api/v1/cron/kb-conversations-batch", schedule: "30 3 * * *" },
    { path: "/api/v1/cron/sync-model-catalog", schedule: "15 4 * * *" },
    { path: "/api/v1/cron/data-retention", schedule: "40 4 * * *" },
  ],
  functions: {
    "app/api/v1/cron/**/route.ts": { maxDuration: 120 },
    "app/api/v1/system/relogio/tick/route.ts": { maxDuration: 60 },
    "app/api/internal/agents/run/route.ts": { maxDuration: 300 },
  },
};

export default config;
