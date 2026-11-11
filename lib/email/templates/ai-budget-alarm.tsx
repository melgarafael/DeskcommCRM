/**
 * Alerta de orçamento de IA por e-mail. HTML puro — sem runtime de React Email.
 *
 * SEM CHAMADOR HOJE. O único era `workers/ai-budget-checker.cron.ts`, apagado na
 * limpeza do teto de orçamento (0159) por nunca ter tido agendador. Quem avisa o
 * cliente que o gasto passou do ponto escolhido é o item `budget_warning` na
 * Central (`agent_inbox_items`), aberto pelo próprio gate. Este arquivo fica de
 * pé porque o alarme POR E-MAIL continua sendo uma peça desejada — e é a dívida
 * D1 de marca (`tests/unit/branding.test.ts`): ele ainda escreve o nosso nome,
 * o que só passa a importar no dia em que ele voltar a ser enviado.
 *
 * O IDIOMA (#4302) entra resolvido em `idioma` e vale para o assunto também —
 * era o único dos três moldes cujo assunto tinha frase fixa. O texto mora no
 * dicionário da interface; nada de cópia paralela aqui dentro.
 */
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO, type Idioma } from "@/lib/i18n/idiomas";

import { preencher } from "./texto";

export interface BudgetAlarmEmailOptions {
  pct: number;
  consumedCents: number;
  limitCents: number;
  orgName?: string | null;
  dashboardUrl: string;
  /** O idioma de quem recebe. Sem ele, `pt-BR` — o comportamento de antes. */
  idioma?: Idioma;
}

export function buildBudgetAlarmEmail(opts: BudgetAlarmEmailOptions): {
  subject: string;
  html: string;
  text: string;
} {
  const idioma = opts.idioma ?? IDIOMA_PADRAO;
  const t = (texto: string, valores: Readonly<Record<string, string>> = {}) =>
    preencher(traduzir(texto, idioma), valores);
  const brl = new Intl.NumberFormat(idioma, { style: "currency", currency: "USD" });
  const fmt = (cents: number): string => brl.format(cents / 100);

  const pctStr = `${opts.pct.toFixed(2)}%`;
  // O nome do produto continua AQUI, no arquivo que já é a dívida D1 da marca
  // (`tests/unit/branding.test.ts`) — não no dicionário, onde viraria ocorrência
  // nova de marca num arquivo novo. Tradução não é o lugar de resolver marca.
  const subject = `${t("Alerta IA: orçamento atingiu {pct}", { pct: pctStr })} — DeskcommCRM`;
  const orgLine = opts.orgName
    ? `<p style="margin:0 0 16px;font-size:14px;color:#57534e">${escapeHtml(t("Organização:"))} <strong>${escapeHtml(opts.orgName)}</strong></p>`
    : "";

  const html = `<!doctype html>
<html lang="${idioma}">
<body style="margin:0;padding:0;background:#f5f5f4;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#1c1917">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px">
    <h1 style="font-size:22px;line-height:1.3;margin:0 0 16px;color:#0c0a09">
      ${escapeHtml(t("Orçamento mensal de IA atingiu {pct}", { pct: pctStr }))}
    </h1>
    ${orgLine}
    <p style="margin:0 0 12px;font-size:15px;line-height:1.5">
      ${escapeHtml(t("Consumo no mês:"))} <strong>${escapeHtml(fmt(opts.consumedCents))}</strong>
      ${escapeHtml(t("de"))} <strong>${escapeHtml(fmt(opts.limitCents))}</strong>.
    </p>
    <p style="margin:0 0 16px;font-size:14px;color:#57534e">
      ${escapeHtml(
        t(
          "Ao atingir 100%, o bot de IA será automaticamente pausado ou desabilitado conforme a política configurada. Atendimento humano segue normalmente.",
        ),
      )}
    </p>
    <p style="margin:24px 0">
      <a href="${opts.dashboardUrl}" style="display:inline-block;padding:12px 24px;background:#0ea5e9;color:#ffffff;border-radius:6px;text-decoration:none;font-weight:600">
        ${escapeHtml(t("Ver dashboard de uso"))}
      </a>
    </p>
    <p style="margin:24px 0 0;font-size:12px;color:#78716c">
      ${escapeHtml(
        t(
          "Este alerta é enviado automaticamente uma vez a cada 24h enquanto o consumo permanecer acima do limite configurado.",
        ),
      )}
    </p>
  </div>
</body>
</html>`;

  const text = [
    t("Orçamento mensal de IA atingiu {pct}.", { pct: pctStr }),
    opts.orgName ? t("Organização: {organizacao}", { organizacao: opts.orgName }) : "",
    t("Consumo: {gasto} de {limite}.", {
      gasto: fmt(opts.consumedCents),
      limite: fmt(opts.limitCents),
    }),
    "",
    t("Dashboard: {url}", { url: opts.dashboardUrl }),
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
