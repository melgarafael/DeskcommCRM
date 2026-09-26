/**
 * A CENTRAL MOSTRA O MAIS GRAVE PRIMEIRO — PELA TELA.
 *
 * Antes, a fila aberta era só "mais recente primeiro": um aviso crítico de dez
 * dias atrás ficava embaixo de avisos informativos de hoje (e, passados 50,
 * sumia da tela). O unitário prova a regra na rota; esta spec prova o que o
 * dono vê: a ordem das linhas e a frase que explica essa ordem.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "./helpers/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const credentials = credenciaisSupabaseDeTeste();
const db = createClient(credentials.url, credentials.serviceRole, {
  auth: { persistSession: false },
});
const password = `Local-${randomUUID()}!`;
const dias = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

/** Criados de propósito na ordem inversa da gravidade: o crítico é o mais velho. */
const AVISOS = [
  { severity: "info", title: "Informativo de hoje", created_at: dias(0) },
  { severity: "warn", title: "Atenção de ontem", created_at: dias(1) },
  { severity: "warn", title: "Atenção de três dias", created_at: dias(3) },
  { severity: "critical", title: "Crítico de dez dias", created_at: dias(10) },
];
const AVISOS_TITULOS = AVISOS.map((a) => a.title);

let usuario = { id: "", email: "" };
let org = "";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(usuario.email);
  await page.getByLabel(/senha/i).fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(?:\/|$)/, { timeout: 60_000 });
}

test.beforeAll(async () => {
  const email = `gravidade-${randomUUID()}@invariant.test`;
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw error;
  usuario = { id: data.user.id, email };

  const o = await db
    .from("organizations")
    .insert({
      slug: `gravidade-${randomUUID()}`,
      legal_name: "Gravidade",
      display_name: "Gravidade",
      onboarded_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (o.error) throw o.error;
  org = o.data.id;
  const m = await db.from("user_organizations").insert({
    organization_id: org,
    user_id: usuario.id,
    role: "agent",
    accepted_at: new Date().toISOString(),
  });
  if (m.error) throw m.error;
  const a = await db
    .from("agent_inbox_items")
    .insert(AVISOS.map((x) => ({ ...x, organization_id: org, kind: "handoff", status: "open" })));
  if (a.error) throw a.error;
});

test.afterAll(async () => {
  if (org) {
    const r = await db.from("organizations").delete().eq("id", org);
    if (r.error) throw r.error;
  }
  if (usuario.id) {
    const r = await db.auth.admin.deleteUser(usuario.id);
    if (r.error) throw r.error;
  }
});

test("o crítico antigo abre a lista; entre iguais, o mais recente vem antes", async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page);
  await page.goto("/app/ai/inbox");

  const linhas = page.getByTestId("inbox-item");
  await expect(linhas).toHaveCount(AVISOS.length);
  const titulos = (await linhas.allTextContents()).map(
    (texto) => AVISOS_TITULOS.find((t) => texto.includes(t)) ?? "?",
  );
  expect(titulos).toEqual([
    "Crítico de dez dias",
    "Atenção de ontem",
    "Atenção de três dias",
    "Informativo de hoje",
  ]);

  // A frase que explica a ordem: visível, legível e só na fila aberta.
  const frase = page.getByText("Os mais graves primeiro; entre iguais, os mais recentes.");
  await expect(frase).toBeVisible();
  const medida = await frase.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { largura: r.width, altura: r.height, cabe: el.scrollWidth <= el.clientWidth };
  });
  expect(medida.cabe).toBe(true);
  expect(medida.altura).toBeGreaterThan(0);

  const pasta = info.outputPath("gravidade");
  mkdirSync(pasta, { recursive: true });
  await page.screenshot({ path: `${pasta}/central.png`, fullPage: true });

  await page.getByRole("tab", { name: "Resolvidos" }).click();
  await expect(page.getByText("Nenhum aviso resolvido")).toBeVisible();
  await expect(frase).toHaveCount(0);
});
