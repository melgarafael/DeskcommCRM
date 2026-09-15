/**
 * Relógio local dos crons HTTP. Em prod o crontab da VPS chama as mesmas
 * rotas; o Next em `pnpm dev` não chama sozinho.
 *
 * Não mexe em produção: só faz POST em NEXT_PUBLIC_APP_URL e Supabase de
 * loopback; URLs remotas são rejeitadas antes do primeiro tick.
 *
 * Uso (app já no ar):
 *   pnpm dev:crons
 */
const INTERVAL_MS = Number(process.env.DEV_CRON_INTERVAL_MS ?? "15000");

const PATHS = [
  "/api/v1/cron/event-log-drain",
  "/api/v1/cron/followup-flow-worker",
  "/api/v1/cron/crm-document-intake",
  "/api/v1/cron/advomax-contact-links-reconcile",
] as const;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function requiredEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new Error(`${name} ausente — rode com --env-file=.env.local`);
  }
  return v;
}

function localUrl(raw: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} inválida; use uma URL local em localhost, 127.0.0.1 ou ::1`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`${name} deve usar loopback durante desenvolvimento; recebido ${url.hostname}`);
  }
  return url;
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
  const base = localUrl(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000", "NEXT_PUBLIC_APP_URL").toString().replace(/\/$/, "");
  const supabase = localUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321", "NEXT_PUBLIC_SUPABASE_URL");
  const secret = process.env.INTERNAL_CRON_SECRET?.trim() || requiredEnv("INTERNAL_SECRET");

  console.info("[dev-crons] alvo HTTP", base);
  console.info("[dev-crons] banco (Supabase)", supabase.host);
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
