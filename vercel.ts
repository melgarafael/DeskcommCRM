/**
 * Configuração do projeto Vercel.
 *
 * Os agendamentos de produção vivem no serviço `scheduler` do
 * docker-compose.prod.yml. O plano Hobby da Vercel rejeita expressões com
 * frequência maior que uma execução diária, portanto esta implantação web não
 * declara crons Vercel. As rotas /api/v1/cron/* continuam disponíveis para um
 * scheduler externo ou para o serviço Docker de produção.
 *
 * Auth de cron: header `Authorization: Bearer ${INTERNAL_SECRET}` validado em
 * cada handler.
 */

import type { VercelConfig } from "@vercel/config/v1";

const config: VercelConfig = {
  functions: {
    // EPIC-13 S-13.08: ToolLoopAgent runtime can issue multiple tool calls per
    // step. 300s max keeps Fluid Compute within bounds; the runtime's own
    // step/token/cost guards usually finish much earlier.
    "app/api/internal/agents/run/route.ts": { maxDuration: 300 },
  },
};

export default config;
