/**
 * Apoio das duas specs da cobrança (a do dublê e a da Stripe real): banco pelo
 * service role, login, estado, dreno do barramento e a FOTO das chaves da
 * instalação. Essas chaves são globais, e cada spec as devolve como achou.
 */
import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import { expect, type APIRequestContext, type Page } from "./test";
import { credenciaisSupabaseDeTeste } from "../../../scripts/lib/env-de-teste";

const credenciais = credenciaisSupabaseDeTeste();
export const db = createClient(credenciais.url, credenciais.serviceRole, { auth: { persistSession: false } });
export const senha = `Local-${randomUUID()}!`;

export const CHAVES_DA_COBRANCA = [
  "MODULO_COBRANCA", "COBRANCA_PROVEDOR", "COBRANCA_TOLERANCIA_DIAS",
  "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET",
] as const;

export async function inserir(tabela: string, valor: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from(tabela).insert(valor).select("id").single();
  if (error) throw error;
  return data.id as string;
}

export async function criarPessoa(rotulo: string, sufixo: string): Promise<{ id: string; email: string }> {
  const email = `cob-${rotulo}-${sufixo}@invariant.test`;
  const { data, error } = await db.auth.admin.createUser({ email, password: senha, email_confirm: true });
  if (error || !data.user) throw error ?? new Error(`não criou ${rotulo}`);
  return { id: data.user.id, email };
}

export async function entrar(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(email);
  await page.getByLabel(/senha/i).fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 60_000 });
}

export async function estadoDaOrg(id: string): Promise<{ status: string; suspended_kind: string | null }> {
  const { data, error } = await db.from("organizations").select("status, suspended_kind").eq("id", id).single();
  if (error) throw error;
  return data as { status: string; suspended_kind: string | null };
}

export interface LinhaDaAssinatura {
  estado: string; plano_id: string; plano_agendado_id: string | null; provedor: string | null; modo: string | null;
  provedor_cliente_id: string | null; checkout_url: string | null; ultimo_aviso: string | null; cancela_no_fim: boolean;
}
export async function assinaturaDe(org: string): Promise<LinhaDaAssinatura> {
  const { data, error } = await db.from("cobranca_assinaturas")
    .select("estado, plano_id, plano_agendado_id, provedor, modo, provedor_cliente_id, checkout_url, ultimo_aviso, cancela_no_fim")
    .eq("organization_id", org).single();
  if (error) throw error;
  return data as LinhaDaAssinatura;
}

/** Recua datas da assinatura no banco. O cron e a régua de produção seguem com o now() real. */
export async function recuar(org: string, campos: Record<string, string>): Promise<void> {
  const r = await db.from("cobranca_assinaturas").update(campos).eq("organization_id", org);
  if (r.error) throw r.error;
}
export const diasAtras = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
export const horasAtras = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

function segredoInterno(): string {
  const segredo = process.env.INTERNAL_CRON_SECRET || process.env.INTERNAL_SECRET;
  if (!segredo) throw new Error("sem INTERNAL_CRON_SECRET/INTERNAL_SECRET no ambiente do e2e");
  return segredo;
}

/**
 * Drena o barramento até a condição valer. O teto é de 150 s porque o
 * consumidor de `cobranca.sinal` adia 30 s quando houve releitura recente
 * (coalescer, spec §7c).
 */
export async function drenarAte(request: APIRequestContext, rotulo: string, pronto: () => Promise<boolean>, tetoMs = 150_000): Promise<void> {
  const limite = Date.now() + tetoMs;
  while (!(await pronto())) {
    if (Date.now() > limite) throw new Error(`${rotulo}: não aconteceu em ${tetoMs / 1000} s`);
    const r = await request.post("/api/v1/cron/event-log-drain", { headers: { authorization: `Bearer ${segredoInterno()}` } });
    expect(r.status(), await r.text()).toBe(200);
    await new Promise((ok) => setTimeout(ok, 3_000));
  }
}

export async function rodarCronDaCobranca(request: APIRequestContext): Promise<void> {
  const r = await request.post("/api/v1/cron/cobranca", { headers: { authorization: `Bearer ${segredoInterno()}` } });
  expect(r.status(), await r.text()).toBe(200);
}

export async function saidasDe(org: string): Promise<{ llm: number; outbound: number }> {
  const llm = await db.from("llm_calls").select("id", { count: "exact", head: true }).eq("organization_id", org);
  if (llm.error) throw llm.error;
  const saida = await db.from("messages").select("id", { count: "exact", head: true }).eq("organization_id", org).eq("direction", "outbound");
  if (saida.error) throw saida.error;
  return { llm: llm.count ?? -1, outbound: saida.count ?? -1 };
}

export async function contarAuditoria(acao: string, org: string): Promise<number> {
  const r = await db.from("api_audit_log").select("id", { count: "exact", head: true }).eq("action", acao).eq("organization_id", org);
  if (r.error) throw r.error;
  return r.count ?? -1;
}

export type FotoDasChaves = Array<Record<string, unknown>>;
export async function fotografarChaves(): Promise<FotoDasChaves> {
  const r = await db.from("platform_config").select("*").in("chave", [...CHAVES_DA_COBRANCA]);
  if (r.error) throw r.error;
  return r.data as FotoDasChaves;
}
export async function restaurarChaves(foto: FotoDasChaves): Promise<void> {
  const apaga = await db.from("platform_config").delete().in("chave", [...CHAVES_DA_COBRANCA]);
  if (apaga.error) throw apaga.error;
  if (foto.length > 0) {
    const volta = await db.from("platform_config").insert(foto);
    if (volta.error) throw volta.error;
  }
}
