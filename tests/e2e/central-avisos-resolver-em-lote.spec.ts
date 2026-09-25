/**
 * "MARCAR TODOS RESOLVIDOS" PELA TELA, COMO O OPERADOR FAZ.
 *
 * Prova três coisas que o unitário não prova, porque as três moram entre o
 * clique e o banco: que o botão está lá e é alcançável; que o lote fecha os
 * abertos DAQUELA organização e só dela; e que o título do aviso continua
 * saindo como foi gravado quando a interface está em espanhol (issue #603).
 *
 * Trabalho original de @rafaelbatistazz no PR #622.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page, type TestInfo } from "@playwright/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const credentials = credenciaisSupabaseDeTeste();
const db = createClient(credentials.url, credentials.serviceRole, {
  auth: { persistSession: false },
});
const password = `Local-${randomUUID()}!`;

/** Título com dado de gente dentro — é assim que o runtime grava de verdade. */
const TITULO = (n: number) => `Fulano de Tal ${n} pediu para falar com uma pessoa`;
const TITULO_VIZINHA = "Aviso da organização vizinha";
const QUANTOS = 6;

let usuario = { id: "", email: "" };
const orgs: string[] = [];

async function insert(table: string, value: Record<string, unknown>) {
  const { data, error } = await db.from(table).insert(value).select("id").single();
  if (error) throw error;
  return data.id as string;
}

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(usuario.email);
  await page.getByLabel(/senha/i).fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(?:\/|$)/, { timeout: 60_000 });
}

const linha = (page: Page, titulo: string) =>
  page.getByTestId("inbox-item").filter({ hasText: titulo });

async function evidencia(page: Page, info: TestInfo, nome: string) {
  const diretorio = info.outputPath(nome);
  mkdirSync(diretorio, { recursive: true });
  await page.screenshot({ path: `${diretorio}/central.png`, fullPage: true });
}

test.beforeAll(async () => {
  const email = `lote-${randomUUID()}@invariant.test`;
  const { data, error } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw error;
  usuario = { id: data.user.id, email };

  for (const n of [0, 1]) {
    const org = await insert("organizations", {
      slug: `lote-${randomUUID()}`,
      legal_name: `Lote ${n}`,
      display_name: `Lote ${n}`,
      onboarded_at: new Date().toISOString(),
    });
    orgs.push(org);
  }
  const membro = await db.from("user_organizations").insert({
    organization_id: orgs[0],
    user_id: usuario.id,
    role: "agent",
    accepted_at: new Date().toISOString(),
  });
  if (membro.error) throw membro.error;

  for (let i = 0; i < QUANTOS; i += 1) {
    await insert("agent_inbox_items", {
      organization_id: orgs[0],
      kind: "handoff",
      severity: "warn",
      title: TITULO(i),
      body: `Motivo: contrato. Cliente: Fulano de Tal ${i}.`,
      status: "open",
    });
  }
  await insert("agent_inbox_items", {
    organization_id: orgs[1],
    kind: "handoff",
    severity: "warn",
    title: TITULO_VIZINHA,
    status: "open",
  });
});

test.afterAll(async () => {
  for (const id of orgs) {
    const r = await db.from("organizations").delete().eq("id", id);
    if (r.error) throw r.error;
  }
  const r = await db.auth.admin.deleteUser(usuario.id);
  if (r.error) throw r.error;
});

test("um clique fecha os abertos da minha organização e não encosta na vizinha", async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page);
  await page.goto("/app/ai/inbox");

  await expect(linha(page, TITULO(0))).toBeVisible();
  await expect(page.getByTestId("inbox-item")).toHaveCount(QUANTOS);
  await evidencia(page, info, "antes");

  await page.getByRole("button", { name: "Marcar todos resolvidos" }).click();

  await expect(page.getByText("Nenhum aviso em aberto")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Marcar todos resolvidos" })).toHaveCount(0);
  await evidencia(page, info, "depois");

  await page.getByRole("tab", { name: "Resolvidos" }).click();
  await expect(page.getByTestId("inbox-item")).toHaveCount(QUANTOS);

  // O que o service role NÃO podia alcançar: a organização vizinha.
  const vizinha = await db
    .from("agent_inbox_items")
    .select("status")
    .eq("organization_id", orgs[1]);
  if (vizinha.error) throw vizinha.error;
  expect(vizinha.data.map((l) => l.status)).toEqual(["open"]);
});

test("em espanhol, o título do aviso continua o que foi gravado (issue #603)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const reabre = await db
    .from("agent_inbox_items")
    .update({ status: "open" })
    .eq("organization_id", orgs[0]);
  if (reabre.error) throw reabre.error;
  const idioma = await db.auth.admin.updateUserById(usuario.id, {
    user_metadata: { locale: "es" },
  });
  if (idioma.error) throw idioma.error;

  await login(page);
  await page.goto("/app/ai/inbox");

  // O rótulo NOSSO traduz…
  await expect(page.getByRole("button", { name: "Marcar todos como resueltos" })).toBeVisible();
  // …e o dado sai como veio.
  await expect(linha(page, TITULO(0))).toBeVisible();
});
