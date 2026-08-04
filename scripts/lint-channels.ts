/**
 * Invariante 1 da doutrina de restrição de canal
 * (`docs/doctrine/restricao-de-canal.md`): **nenhuma feature nomeia um
 * provider**. Rodado pelo `gov:verify`.
 *
 * Varredura por walk recursivo, não `fs.globSync`: a função só existe em node
 * 22+, o repo já foi node 20, e walk custa 8 linhas e nenhuma dependência.
 *
 * O lint NÃO se auto-varre: `scripts/` está fora de `ROOTS` de propósito — este
 * arquivo precisa escrever os nomes proibidos para poder proibi-los.
 *
 * ─── Por que existe uma lista de dívida (e não uma allowlist muda) ───────────
 *
 * Na primeira execução o lint apontou **56 arquivos**, não os 4 que o plano das
 * Fases 0–2 estimava. Limpar todos exigiria reescrever cópia de UI visível,
 * renomear campo de resposta de API pública (`checks.waha`) e mover a família de
 * rotas `/api/v1/webhooks/waha/*` — tudo **mudança de comportamento**, que a
 * Global Constraint nº 1 daquele plano proíbe, e que é trabalho da Fase 3
 * (quando `lib/waha/` for absorvido por `lib/channels/`).
 *
 * Então o mecanismo é uma **catraca**, não uma anistia:
 *   - arquivo novo com nome de provider → reprova (o invariante vale daqui pra frente);
 *   - arquivo que saiu da lista mas continua sujo → reprova;
 *   - arquivo que ficou limpo e esqueceram de tirar da lista → **também reprova**,
 *     para a lista só poder encolher. Dívida sem mecanismo anti-morte é dívida
 *     que envelhece em silêncio (`docs/doctrine/sistema-vivo.md`).
 *
 * Cada entrada abaixo tem categoria e razão escrita. Entrada sem razão é dívida
 * silenciosa — se você precisar acrescentar uma, escreva o porquê junto.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN = /\b(waha|WAHA|meta_cloud|graph\.facebook\.com)\b/;
const ROOTS = ["app", "lib", "components", "workers"];
const ALLOWED = [
  /^lib\/channels\//,
  // O transporte que o adapter embrulha; some quando a Fase 3 o absorver.
  /^lib\/waha\//,
  // Saída de `supabase gen types`: os nomes são COLUNAS. Editar à mão é o defeito.
  /^lib\/database\.types\.ts$/,
];

/**
 * Dívida conhecida, medida em 2026-07-27 (Task 7 do plano de seam de canais).
 * Ordem alfabética dentro de cada grupo, para o diff ficar legível.
 */
const KNOWN_DEBT: { reason: string; files: string[] }[] = [
  {
    reason:
      "Superfície de TRANSPORTE do provider legado (control plane de sessão, " +
      "webhook receiver, download de mídia). Mesma natureza de `lib/waha/`, que " +
      "já é exceção: não são features perguntando identidade, são o próprio " +
      "canal. Saem junto com `lib/waha/` na Fase 3.",
    files: [
      "app/api/v1/channel-sessions/[id]/qr/route.ts",
      "app/api/v1/channel-sessions/[id]/reconnect/route.ts",
      "app/api/v1/channel-sessions/[id]/route.ts",
      "app/api/v1/channel-sessions/route.ts",
      "app/api/v1/health/route.ts",
      "app/api/v1/messages/[id]/media/route.ts",
      "app/api/v1/onboarding/whatsapp/qr/route.ts",
      "app/api/v1/onboarding/whatsapp/session/route.ts",
      "app/api/v1/webhooks/waha/[token]/route.ts",
      "app/api/v1/webhooks/waha/route.ts",
      "app/onboarding/connect-whatsapp/page.tsx",
      "lib/agent-engine/edge/crm/session-reconciler.ts",
      "workers/media-persist-worker.ts",
    ],
  },
  {
    reason:
      "Texto VISÍVEL ao usuário (cópia de tela) ou nome de campo de resposta de " +
      "API pública (`checks.waha`, `waha_ban`, `waha_sessions_count`). Trocar é " +
      "mudança de comportamento observável — proibida nas Fases 0–2. A cópia " +
      "neutra de canal entra junto com o seletor de canal da Fase 3a, que é " +
      "quando o usuário passa a ter mais de um canal para distinguir.",
    files: [
      "app/api/v1/admin/dashboard/kpis/route.ts",
      "app/api/v1/admin/tenants/[id]/health/route.ts",
      "app/design/sections/SectionPatterns.tsx",
      "app/onboarding/connect-whatsapp/_client.tsx",
      "components/admin/dashboard/AlertItem.tsx",
      "components/admin/dashboard/KPICards.tsx",
      "components/admin/tenants/HealthGrid.tsx",
      "components/admin/tenants/TenantOverview.tsx",
      "components/connections/ConnectionsClient.tsx",
    ],
  },
  {
    reason:
      "`WahaChannelAdapter` — o ChannelAdapter PRÉ-seam do agent-engine (F2-25), " +
      "abstração paralela à de `lib/channels/`. Unificar as duas é decisão de " +
      "arquitetura com superfície própria, não passo de um lint.",
    files: ["lib/agent-engine/agent/followup-turn.ts", "lib/agent-engine/agent/inbound-turn.ts"],
  },
  {
    reason:
      "Menção em COMENTÁRIO/prosa técnica — não há acoplamento nenhum no código. " +
      "O regex é o da doutrina (que fala em 'string') e não distingue prosa de " +
      "código. Medido ao vivo nesta task: o comentário que eu escrevi explicando " +
      "de onde uma função tinha saído virou um infrator novo. Reescrever prosa " +
      "correta ('o container converte o áudio no servidor') para escapar de um " +
      "regex PIORA o código — por isso a decisão é registrar, não reescrever.",
    files: [
      "app/api/v1/ai/agents/[id]/versions/[vid]/test/route.ts",
      "app/api/v1/conversations/[id]/media/route.ts",
      "app/api/v1/webhook-sources/route.ts",
      "app/api/v1/webhooks/in/[token]/route.ts",
      "app/app/ai/agents/[id]/_components/TestPanel.tsx",
      "components/inbox/media/media-utils.ts",
      "lib/agent-engine/channel-adapter.ts",
      "lib/agent-engine/cron/scheduler.ts",
      "lib/agent-engine/edge/channel/waha-adapter.ts",
      "lib/agent-engine/edge/crm/mcp-client.ts",
      "lib/agent-engine/edge/crm/send-message.ts",
      "lib/agent-engine/edge/crm/session-watchdog.ts",
      "lib/agent-engine/edge/egress.ts",
      "lib/agent-engine/env.ts",
      "lib/agent-engine/health/circuit.ts",
      "lib/agent-engine/obs/metrics.ts",
      "lib/ai/dispatcher/triggers.ts",
      "lib/ai/runtime/finalize.ts",
      "lib/automation/start-conversation.ts",
      "lib/env.ts",
      "lib/followup/reactivity.ts",
      "lib/messaging/media/types.ts",
      "lib/messaging/media/waha-source.ts",
      "lib/schemas/channels.ts",
      "lib/supabase/admin.ts",
      "lib/types/messaging.ts",
      "lib/webhooks/secrets.ts",
      "workers/agent-worker/main.ts",
      "workers/ai-response-worker.ts",
      "workers/agent-worker/app-cron-ticker.ts",
    ],
  },
];

const DEBT = new Set(KNOWN_DEBT.flatMap((g) => g.files));

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

const offenders = ROOTS.flatMap(walk)
  .filter((f) => !ALLOWED.some((re) => re.test(f)))
  .filter((f) => FORBIDDEN.test(readFileSync(f, "utf8")));

const novos = offenders.filter((f) => !DEBT.has(f));
const stale = [...DEBT].filter((f) => !offenders.includes(f)).sort();

if (novos.length) {
  console.error(
    "Nome de provider fora de lib/channels/ (doutrina restricao-de-canal, invariante 1):",
  );
  for (const f of novos.sort()) console.error(`  ${f}`);
  console.error(
    "\nPergunte uma CAPACIDADE (`capabilitiesOf`), peça o adapter (`getAdapter`) ou o\n" +
      "identificador da sessão (`resolveSessionRef`) — nunca nomeie o provider.",
  );
}

if (stale.length) {
  console.error(
    "\nEntradas de KNOWN_DEBT que já não vazam (ou o arquivo sumiu) — apague-as de\n" +
      "scripts/lint-channels.ts para a catraca não afrouxar:",
  );
  for (const f of stale) console.error(`  ${f}`);
}

if (novos.length || stale.length) process.exit(1);

console.info(`lint-channels: ok (${DEBT.size} arquivos de dívida conhecida, nenhum novo)`);
