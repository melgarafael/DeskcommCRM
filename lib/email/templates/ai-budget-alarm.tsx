/** Modelo reservado, sem emissor/agendador ativo. Não habilita novos envios. */
import { NEUTROS_DE_SAIDA, type MarcaDeSaida } from "@/lib/branding/saida";
import { estruturaDeEmail } from "./estrutura";
export interface BudgetAlarmEmailOptions {
  marca: MarcaDeSaida;
  pct: number;
  consumedCents: number;
  limitCents: number;
  orgName?: string | null;
  dashboardUrl: string;
}

const brl = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "USD",
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
  const subject = `Alerta IA: orçamento atingiu ${pctStr} — ${opts.marca.nome}`;
  const orgLine = opts.orgName
    ? `<p style="margin:0 0 16px;font-size:14px;color:${NEUTROS_DE_SAIDA.suave}">Organização: <strong>${escapeHtml(opts.orgName)}</strong></p>`
    : "";

  const html = estruturaDeEmail(opts.marca, `    <h1 style="font-size:22px;line-height:1.3;margin:0 0 16px;color:${NEUTROS_DE_SAIDA.texto}">
      Orçamento mensal de IA atingiu ${escapeHtml(pctStr)}
    </h1>
    ${orgLine}
    <p style="margin:0 0 12px;font-size:15px;line-height:1.5">
      Consumo no mês: <strong>${escapeHtml(fmt(opts.consumedCents))}</strong>
      de <strong>${escapeHtml(fmt(opts.limitCents))}</strong>.
    </p>
    <p style="margin:0 0 16px;font-size:14px;color:${NEUTROS_DE_SAIDA.suave}">
      Ao atingir 100%, o bot de IA será automaticamente pausado ou desabilitado
      conforme a política configurada. Atendimento humano segue normalmente.
    </p>
    <p style="margin:24px 0">
      <a href="${escapeHtml(opts.dashboardUrl)}" style="display:inline-block;padding:12px 24px;background:${opts.marca.accent};color:${opts.marca.accentFg};border-radius:6px;text-decoration:none;font-weight:600">
        Ver dashboard de uso
      </a>
    </p>
    <p style="margin:24px 0 0;font-size:12px;color:${NEUTROS_DE_SAIDA.suave}">
      Este alerta é enviado automaticamente uma vez a cada 24h enquanto o
      consumo permanecer acima do limite configurado.
    </p>
  `);

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
