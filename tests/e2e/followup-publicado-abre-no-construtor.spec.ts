import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "@playwright/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

/**
 * UM FLUXO PUBLICADO ABRE COMO ESTÁ NO AR — não em branco.
 *
 * ═══ O defeito ══════════════════════════════════════════════════════════════
 *
 * O canvas lê `followup_flow_pointers.draft_graph`. Quando a versão nasce POR
 * FORA do construtor (publicação por script, restauração de backup, importação
 * de outra instalação), o ponteiro ganha `active_version_id` e NUNCA ganha
 * rascunho. O motor executa o fluxo; a tela desenha nada.
 *
 * ⚠️ E o estrago não para em "a tela está vazia": `savedGraph` também nascia
 * vazio, então arrastar um nó e salvar trocaria o rascunho por quase-nada — e o
 * "Publicar" seguinte trocaria o fluxo do AR por esse quase-nada.
 *
 * ═══ O que esta spec mede, pela tela ════════════════════════════════════════
 *
 * Semeia exatamente esse estado — versão publicada com três nós, `draft_graph`
 * NULL — e abre o construtor como um gestor faria. Os três nós têm de estar
 * desenhados. Na `main` sem o PR o canvas vem vazio.
 */

const RAIZ = path.resolve(__dirname, "../..");
const NOME_DO_FLUXO = "Fluxo publicado por fora (QA visual)";

const GRAFO_NO_AR = {
  nodes: [
    { id: "n1", type: "trigger", label: "Começo publicado", position: { x: 0, y: 0 }, config: {} },
    {
      id: "n2",
      type: "wait",
      label: "Aguardar 10 min",
      position: { x: 260, y: 0 },
      config: { mode: "fixed", duration_ms: 600_000 },
    },
    {
      id: "n3",
      type: "end",
      label: "Fim publicado",
      position: { x: 520, y: 0 },
      config: { outcome: "converted" },
    },
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2", priority: 0, condition: { type: "always" } },
    { id: "e2", source: "n2", target: "n3", priority: 0, condition: { type: "always" } },
  ],
};

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string } | undefined>;
}

function admin() {
  const c = credenciaisSupabaseDeTeste();
  return createClient(c.url, c.serviceRole, { auth: { persistSession: false } });
}

async function entrar(page: Page, creds: Creds) {
  const usuario = creds.users.manager!;
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(usuario.email);
  await page.getByLabel(/senha/i).fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
}

test("o fluxo publicado por fora do construtor abre com os nós que estão no ar", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const creds = JSON.parse(
    fs.readFileSync(path.join(RAIZ, ".e2e-creds.json"), "utf8"),
  ) as Creds;
  const db = admin();

  // ─── O ESTADO QUE O DEFEITO EXIGE ────────────────────────────────────────
  // Ponteiro com versão ativa e SEM rascunho. A ordem importa: o ponteiro nasce
  // primeiro (a versão referencia `pointer_id`), a versão depois, e o ponteiro
  // recebe `active_version_id` no fim.
  await db
    .from("followup_flow_pointers")
    .delete()
    .eq("organization_id", creds.org_id)
    .eq("name", NOME_DO_FLUXO);

  const { data: ponteiro, error: erroPonteiro } = await db
    .from("followup_flow_pointers")
    .insert({
      organization_id: creds.org_id,
      name: NOME_DO_FLUXO,
      status: "active",
      draft_graph: null,
      trigger_config: { kind: "manual" },
    } as never)
    .select("id")
    .single();
  if (erroPonteiro) throw new Error(`followup_flow_pointers: ${erroPonteiro.message}`);
  const ponteiroId = (ponteiro as { id: string }).id;

  const { data: versao, error: erroVersao } = await db
    .from("followup_flow_versions")
    .insert({
      organization_id: creds.org_id,
      pointer_id: ponteiroId,
      graph: GRAFO_NO_AR,
    } as never)
    .select("id")
    .single();
  if (erroVersao) throw new Error(`followup_flow_versions: ${erroVersao.message}`);

  await db
    .from("followup_flow_pointers")
    .update({ active_version_id: (versao as { id: string }).id } as never)
    .eq("id", ponteiroId);

  // Precondição explícita: se o rascunho não estiver NULL, o caso não exercita
  // nada — passaria pelo caminho trivial e o verde não valeria.
  const { data: conferido } = await db
    .from("followup_flow_pointers")
    .select("draft_graph, active_version_id")
    .eq("id", ponteiroId)
    .single();
  expect(
    (conferido as { draft_graph: unknown }).draft_graph,
    "o rascunho não está nulo — o cenário do defeito não foi montado",
  ).toBeNull();

  // ─── A TELA ──────────────────────────────────────────────────────────────
  await entrar(page, creds);
  await page.goto(`/app/ai/followups/${ponteiroId}`);
  await expect(page.getByTestId("flow-builder-shell")).toBeVisible({ timeout: 25_000 });
  await expect(page.getByTestId("flow-canvas")).toBeVisible({ timeout: 20_000 });

  const cartoes = page.locator('[data-testid^="node-card-"]');
  await expect(
    cartoes.first(),
    "o construtor abriu VAZIO num fluxo que está publicado e rodando",
  ).toBeVisible({ timeout: 20_000 });
  expect(
    await cartoes.count(),
    "o canvas não desenhou os três nós da versão que está no ar",
  ).toBe(3);

  await expect(page.getByTestId("node-card-n1")).toContainText("Começo publicado");
  await expect(page.getByTestId("node-card-n3")).toContainText("Fim publicado");

  // Geometria por ferramenta: nó no DOM com área zero é nó que ninguém vê.
  const area = await page
    .getByTestId("node-card-n2")
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.width * r.height;
    });
  expect(area, "o nó está no DOM mas não tem área na tela").toBeGreaterThan(1000);

  await page.screenshot({
    path: path.join(RAIZ, ".superpowers/evidence/followup-publicado-abre-cheio.png"),
  });
});
