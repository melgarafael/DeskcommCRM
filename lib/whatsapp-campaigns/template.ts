/**
 * Template de campanha WhatsApp — variáveis simples, render atômico.
 * Tokens desconhecidos → erro (não inicia campanha).
 */

export const CAMPAIGN_TEMPLATE_VARS = [
  "first_name",
  "full_name",
  "company_name",
  "trade_name",
] as const;

export type CampaignTemplateVar = (typeof CAMPAIGN_TEMPLATE_VARS)[number];

const TOKEN_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

export function extractTemplateTokens(template: string): string[] {
  const found = new Set<string>();
  for (const m of template.matchAll(TOKEN_RE)) {
    if (m[1]) found.add(m[1]);
  }
  return [...found];
}

export function validateCampaignTemplate(template: string): {
  ok: true;
  tokens: string[];
} | { ok: false; unknown: string[] } {
  const tokens = extractTemplateTokens(template);
  const allowed = new Set<string>(CAMPAIGN_TEMPLATE_VARS);
  const unknown = tokens.filter((t) => !allowed.has(t));
  if (unknown.length > 0) return { ok: false, unknown };
  return { ok: true, tokens };
}

export interface TemplateContext {
  first_name?: string | null;
  full_name?: string | null;
  company_name?: string | null;
  trade_name?: string | null;
}

export function firstNameFrom(full: string | null | undefined): string {
  if (!full?.trim()) return "";
  return full.trim().split(/\s+/)[0] ?? "";
}

export function renderCampaignTemplate(template: string, ctx: TemplateContext): string {
  const map: Record<string, string> = {
    first_name: ctx.first_name?.trim() || firstNameFrom(ctx.full_name) || "",
    full_name: ctx.full_name?.trim() || "",
    company_name: ctx.company_name?.trim() || ctx.trade_name?.trim() || "",
    trade_name: ctx.trade_name?.trim() || ctx.company_name?.trim() || "",
  };
  return template.replace(TOKEN_RE, (_, key: string) => map[key] ?? "");
}
