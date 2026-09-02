/**
 * ENSAIO do ciclo de anonimização — no tenant DESCARTÁVEL, não na org de teste.
 *
 * Objetivo: provar o INSTRUMENTO antes de precisar dele. Roda o único tipo que a
 * UI conhece hoje (`store_redact`), do clique até o cascade, e verifica os dois
 * lados. Quando o vocabulário do `redact` for alinhado, só troca o alvo.
 *
 * POR QUE NO TENANT B: `store_redact` anonimiza o TENANT INTEIRO. Na org de teste
 * isso atingiria 55 contatos, 132 mensagens e 51 leads — irreversível, e
 * destruiria os fixtures de todas as sessões. Aqui o tenant é meu, de hoje, e
 * tem um único titular.
 *
 * EXECUÇÃO DO WORKER — escopo cirúrgico: não existe runner standalone do worker
 * de LGPD (o único script é o genérico, que carrega os handlers de ENVIO e
 * dispararia 139 eventos pendentes, alguns de abril). Então este arquivo
 * seleciona **apenas** eventos `lgpd.redact_received` **desta org** e chama
 * `processLgpdRedact()` neles. Não varre a fila, não toca em message.outbound,
 * não "limpa" nada.
 *
 * Run: E2E_PORT=3020 npx tsx tests/capture-lgpd-ensaio-tenant-b.ts
 */

import { chromium } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import * as fs from "node:fs";

import type { EventRow } from "@/lib/event-log/dispatcher";
import { processLgpdRedact } from "@/workers/lgpd-redact-worker";

import { CREDS, EVIDENCE, loginAs, shotPage } from "./qa-helpers";
import { carregarEnvLocal } from "../scripts/lib/env-de-teste";

const env = carregarEnvLocal();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const B = CREDS.tenant_b as {
  org_id: string;
  email: string;
  password: string;
  totp: { secret: string };
  lgpd: { contactId: string; leadId: string; activityId: string; requestId: string };
};

const resultados: { nome: string; ok: boolean; detalhe: string }[] = [];
function record(nome: string, ok: boolean, detalhe: string): void {
  resultados.push({ nome, ok, detalhe });
  console.info(`${ok ? "PASS" : "FALHA"}  ${nome} — ${detalhe}`);
}

async function estado() {
  const c = await admin
    .from("contacts")
    .select("name,email,phone_number,is_anonymized")
    .eq("id", B.lgpd.contactId)
    .single();
  if (c.error) throw new Error(`contato: ${c.error.message}`);
  const a = await admin
    .from("crm_lead_activities")
    .select("id,actor_kind,reason,evidence,payload,metadata,created_at")
    .eq("id", B.lgpd.activityId)
    .single();
  if (a.error) throw new Error(`atividade: ${a.error.message}`);
  const r = await admin
    .from("lgpd_requests")
    .select("status")
    .eq("id", B.lgpd.requestId)
    .single();
  if (r.error) throw new Error(`request: ${r.error.message}`);
  return {
    contato: c.data as Record<string, unknown>,
    atividade: a.data as Record<string, unknown>,
    status: (r.data as { status: string }).status,
  };
}

/** Executa SÓ os eventos de redact desta org. Escopo é a garantia de segurança. */
async function rodarWorkerDeLgpd(): Promise<number> {
  const { data, error } = await admin
    .from("event_log")
    .select("id,organization_id,event_type,entity_kind,entity_id,payload,metadata,consumed_by,attempts")
    .eq("organization_id", B.org_id)
    .eq("event_type", "lgpd.redact_received")
    .eq("status", "pending");
  if (error) throw new Error(`buscar eventos: ${error.message}`);
  const eventos = (data ?? []) as unknown as EventRow[];
  console.info(`[worker] ${eventos.length} evento(s) lgpd.redact_received pendente(s) NESTA org`);

  for (const ev of eventos) {
    if (ev.event_type !== "lgpd.redact_received" || ev.organization_id !== B.org_id) {
      throw new Error(`[worker] recusado: evento fora do escopo (${ev.event_type} / ${ev.organization_id})`);
    }
    const r = await processLgpdRedact(ev);
    console.info(`[worker] evento ${ev.id.slice(0, 8)} → status=${r.status} detail=${r.detail ?? "-"}`);
  }
  return eventos.length;
}

async function main(): Promise<void> {
  fs.mkdirSync(EVIDENCE, { recursive: true });

  const antes = await estado();
  console.info("=== ANTES ===");
  console.info(`  contato: "${antes.contato.name}" anonimizado=${antes.contato.is_anonymized}`);
  console.info(`  atividade: reason=${antes.atividade.reason ? "TEM PII" : "null"} evidence=${JSON.stringify(antes.atividade.evidence)} actor_kind=${antes.atividade.actor_kind}`);
  console.info(`  request: ${antes.status}`);
  if (antes.status !== "received") {
    throw new Error(`request em "${antes.status}" — rode scripts/seed-e2e-tenant-b.ts para reiniciar`);
  }

  // ---- o caminho do usuário -------------------------------------------------
  const browser = await chromium.launch();
  const page = await (
    await browser.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  page.setDefaultTimeout(90_000);
  page.setDefaultNavigationTimeout(90_000);

  await loginAs(page, {
    email: B.email,
    password: B.password,
    totpSecret: B.totp.secret,
    rotulo: "tenant B admin",
  });

  await page.getByRole("link", { name: "Proteção de Dados", exact: true }).click();
  await page.waitForURL(/\/app\/lgpd/, { timeout: 30_000 });
  const link = page.locator(`a[href*="${B.lgpd.requestId}"]`).first();
  await link.waitFor({ state: "visible", timeout: 90_000 });
  await shotPage(page, "lgpd-b-1-lista.png", false);

  await link.click();
  await page.waitForURL(new RegExp(B.lgpd.requestId), { timeout: 90_000 });
  await page.waitForLoadState("networkidle").catch(() => null);

  const botao = page.getByRole("button", { name: /anonimiz|aprovar/i }).first();
  if ((await botao.count()) === 0) {
    const texto = (await page.locator("main").first().textContent()) ?? "";
    throw new Error(
      `[lgpd-b] sem botão de aprovação — a tela diz: ${texto.replace(/\s+/g, " ").slice(0, 200)}`,
    );
  }
  record("UI: a tela de aprovação ABRE para store_redact", true, "botão de aprovação presente");
  await shotPage(page, "lgpd-b-2-detalhe.png", false);

  await botao.click();
  const campo = page.locator("#approved_reason, textarea").first();
  await campo.waitFor({ state: "visible", timeout: 20_000 });
  await campo.fill("Ensaio do ciclo de anonimizacao em tenant descartavel — QA");
  const confirmar = page.getByRole("button", { name: /confirmar|anonimiz|aprovar/i }).last();
  await confirmar.click();
  await page.waitForTimeout(4000);
  await shotPage(page, "lgpd-b-3-aprovado.png", false);
  await browser.close();

  const posAprovacao = await estado();
  record(
    "UI: aprovação transiciona o request",
    posAprovacao.status !== "received",
    `"${antes.status}" → "${posAprovacao.status}"`,
  );

  // ---- o worker, com escopo cirúrgico ---------------------------------------
  const executados = await rodarWorkerDeLgpd();
  record("worker de LGPD executou o evento", executados > 0, `${executados} evento(s) processado(s)`);

  const depois = await estado();
  console.info("\n=== DEPOIS ===");
  console.info(`  contato: "${depois.contato.name}" anonimizado=${depois.contato.is_anonymized}`);

  // --- lado A: o que TEM de sumir ---
  record(
    "contato anonimizado",
    depois.contato.is_anonymized === true,
    `is_anonymized=${depois.contato.is_anonymized} name="${depois.contato.name}"`,
  );
  record(
    "activity.reason virou NULL",
    depois.atividade.reason === null,
    `reason = ${depois.atividade.reason === null ? "NULL" : JSON.stringify(depois.atividade.reason).slice(0, 50)}`,
  );
  record(
    "activity.payload e metadata zerados",
    JSON.stringify(depois.atividade.payload ?? {}) === "{}" &&
      JSON.stringify(depois.atividade.metadata ?? {}) === "{}",
    `payload=${JSON.stringify(depois.atividade.payload).slice(0, 40)} metadata=${JSON.stringify(depois.atividade.metadata).slice(0, 40)}`,
  );

  // --- lado B: o que NÃO pode sumir ---
  record(
    "activity.evidence SOBREVIVEU",
    JSON.stringify(depois.atividade.evidence) === JSON.stringify(antes.atividade.evidence),
    `antes=${JSON.stringify(antes.atividade.evidence)} depois=${JSON.stringify(depois.atividade.evidence)}`,
  );
  record(
    "activity.actor_kind SOBREVIVEU",
    depois.atividade.actor_kind === antes.atividade.actor_kind,
    `"${antes.atividade.actor_kind}" → "${depois.atividade.actor_kind}"`,
  );
  record(
    "timestamp preservado",
    depois.atividade.created_at === antes.atividade.created_at,
    depois.atividade.created_at === antes.atividade.created_at ? "intacto" : "MUDOU",
  );

  const falhas = resultados.filter((x) => !x.ok);
  console.info(`\n=== ENSAIO: ${resultados.length - falhas.length}/${resultados.length} PASS ===`);
  for (const f of falhas) console.info(`  FALHA ${f.nome}: ${f.detalhe}`);
  if (falhas.length) process.exit(1);
}

main().catch((err) => {
  console.error("❌ Ensaio de LGPD falhou:", err);
  process.exit(1);
});
