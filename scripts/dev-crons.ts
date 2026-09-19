/**
 * Relógio local dos crons HTTP. Em prod o crontab da VPS chama as mesmas
 * rotas; o Next em `pnpm dev` não chama sozinho.
 *
 * Não mexe em produção: só faz POST em NEXT_PUBLIC_APP_URL (default
 * localhost:3000). O risco é o *banco*: se .env.local aponta para o mesmo
 * Supabase da VPS, este loop compete com o cron de lá.
 *
 * Uso (app já no ar):
 *   pnpm dev:crons
 */
const INTERVAL_MS = Number(process.env.DEV_CRON_INTERVAL_MS ?? "15000");

const PATHS = [
  "/api/v1/cron/prospecting",
  "/api/v1/cron/event-log-drain",
  "/api/v1/cron/followup-flow-worker",
] as const;

function requiredEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new Error(`${name} ausente — rode com --env-file=.env.local`);
  }
  return v;
}

function supabaseHost(): string {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").host || "(sem URL)";
  } catch {
    return "(URL inválida)";
  }
}

async function tick(base: string, secret: string): Promise<void> {
  for (const path of PATHS) {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
    });
    const body = await res.text();
    const snippet = body.length > 240 ? `${body.slice(0, 240)}…` : body;
    console.info(`[dev-crons] ${path} → ${res.status} ${snippet}`);
  }
}

async function main(): Promise<void> {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const secret = process.env.INTERNAL_CRON_SECRET?.trim() || requiredEnv("INTERNAL_SECRET");

  console.info("[dev-crons] alvo HTTP", base);
  console.info("[dev-crons] banco (Supabase)", supabaseHost());
  console.info(
    "[dev-crons] se esse host for o da VPS, pare — o drain local disputa event_log/job_queue com produção",
  );
  console.info(`[dev-crons] intervalo ${INTERVAL_MS}ms — Ctrl+C encerra`);

  await tick(base, secret);
  setInterval(() => {
    void tick(base, secret).catch((err: unknown) => {
      console.error("[dev-crons] tick falhou", err instanceof Error ? err.message : err);
    });
  }, INTERVAL_MS);
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
