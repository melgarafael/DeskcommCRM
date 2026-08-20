import { DEFAULT_APP_NAME } from "@/lib/branding";

/**
 * AI budget alarm email (PT-BR). Plain HTML — no React Email runtime.
 *
 * Triggered by `workers/ai-budget-checker.cron.ts` when the monthly consumption
 * crosses `alarm_threshold_pct` and once per 24h thereafter.
 */
export interface BudgetAlarmEmailOptions {
  pct: number;
  consumedCents: number;
  limitCents: number;
  orgName?: string | null;
  dashboardUrl: string;
}

const brl = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

function fmt(cents: number): string {
  return brl.format(cents / 100);
}

export function buildBudgetAlarmEmail(opts: BudgetAlarmEmailOptions): {
  subject: string;
  html: string;
  text: string;
} {
  const pctStr = `${opts.pct.toFixed(2)}%`;
  const subject = `Alerta IA: orçamento atingiu ${pctStr} — ${DEFAULT_APP_NAME}`;
  const orgLine = opts.orgName
    ? `<p style="margin:0 0 16px;font-size:14px;color:#57534e">Organização: <strong>${escapeHtml(opts.orgName)}</strong></p>`
    : "";

  const html = `<!doctype html>
<html lang="pt-BR">
<body style="margin:0;padding:0;background:#f5f5f4;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#1c1917">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px">
    <h1 style="font-size:22px;line-height:1.3;margin:0 0 16px;color:#0c0a09">
      Orçamento mensal de IA atingiu ${escapeHtml(pctStr)}
    </h1>
    ${orgLine}
    <p style="margin:0 0 12px;font-size:15px;line-height:1.5">
      Consumo no mês: <strong>${escapeHtml(fmt(opts.consumedCents))}</strong>
      de <strong>${escapeHtml(fmt(opts.limitCents))}</strong>.
    </p>
    <p style="margin:0 0 16px;font-size:14px;color:#57534e">
      Ao atingir 100%, o bot de IA será automaticamente pausado ou desabilitado
      conforme a política configurada. Atendimento humano segue normalmente.
    </p>
    <p style="margin:24px 0">
      <a href="${opts.dashboardUrl}" style="display:inline-block;padding:12px 24px;background:#0ea5e9;color:#ffffff;border-radius:6px;text-decoration:none;font-weight:600">
        Ver dashboard de uso
      </a>
    </p>
    <p style="margin:24px 0 0;font-size:12px;color:#78716c">
      Este alerta é enviado automaticamente uma vez a cada 24h enquanto o
      consumo permanecer acima do limite configurado.
    </p>
  </div>
</body>
</html>`;

  const text = [
    `Orçamento mensal de IA atingiu ${pctStr}.`,
    opts.orgName ? `Organização: ${opts.orgName}` : "",
    `Consumo: ${fmt(opts.consumedCents)} de ${fmt(opts.limitCents)}.`,
    "",
    `Dashboard: ${opts.dashboardUrl}`,
  ]
    .filter(Boolean)
    .join("\n");

  return { subject, html, text };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
