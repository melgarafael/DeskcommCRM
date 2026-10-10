import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test } from "./helpers/test";
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal, destinoEhLocal } from "../../scripts/lib/env-de-teste";
import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

/**
 * AUDITORIA DO SITE NA FILA DE PROSPECÇÃO (spec 24, issue #2703).
 *
 * A fila tratava "tem site" como fato binário. Agora cada candidato com
 * `data.site` mostra a auditoria embutida (veredito, raio-X, estratégia), a
 * fila ordena por score e há botões de reanalisar + prévia. O que esta spec
 * prova PELA TELA, com valores exatos (não presença):
 *
 * 1. o painel exibe o veredito e o motivo do score do CANDIDATO CERTO;
 * 2. o KPI "Score médio" é a média dos exibidos (61, não um número mágico);
 * 3. trocar a ordenação para score REORDENA as linhas (quente primeiro).
 *
 * O que ela NÃO prova de propósito (sem rede externa nem IA no e2e): o clique
 * em "Reanalisar site" (faria fetch real) e em "Prévia da abordagem" (chamaria
 * o modelo) — os dois botões são assertados visíveis e habilitados; a lógica
 * deles vive em `tests/unit/prospecting-site-fetch.test.ts` e no par-IA do PR.
 *
 * Pré-requisitos (banco local do baseline, app buildada):
 *   pnpm e2e:env && pnpm e2e:build
 *   pnpm exec playwright test tests/e2e/prospeccao-auditoria-do-site.spec.ts
 */

const env = carregarEnvLocal();
const URL_SUPABASE = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const admin = createClient(URL_SUPABASE, env.SUPABASE_SERVICE_ROLE_KEY ?? "", {
  auth: { autoRefreshToken: false, persistSession: false },
});

const EVIDENCIA = path.join(process.cwd(), "evidence", "prospeccao-auditoria-do-site");
const NOME_CAMPANHA = "E2E Auditoria de site";
const SUFIXO = "qa24";

function dadosCandidato(
  nome: string,
  place: string,
  nota: number | null,
  avaliacoes: number,
  site: Record<string, unknown>,
) {
  return {
    organization_id: "",
    campaign_id: "",
    place_id: `${place}-${SUFIXO}`,
    phone: "+5511999990001",
    status: "new",
    data: {
      key: `${place}-${SUFIXO}`,
      name: nome,
      phone: "+5511999990001",
      website: "https://vitta-qa.test/",
      category: "Clínica de estética",
      address: "Rua QA, 1",
      maps_url: null,
      rating: nota,
      reviews: avaliacoes,
      emails: [],
      socials: [],
      site,
    },
  };
}

const SITE_QUENTE = {
  ver: 1,
  classe: "sem-site",
  problemas: [],
  checklist: { tem: [], falta: ["whatsapp", "tel"] },
  final_url: null,
  http_status: null,
  tempo_ms: 0,
  conteudo_resumo: null,
  pagespeed: null,
  verificado_em: "2026-10-10T12:00:00.000Z",
};

const SITE_FRIO = {
  ver: 1,
  classe: "site-ok",
  problemas: [],
  checklist: { tem: ["tel"], falta: [] },
  final_url: "https://fria-qa.test/",
  http_status: 200,
  tempo_ms: 300,
  conteudo_resumo: null,
  pagespeed: null,
  verificado_em: "2026-10-10T12:00:00.000Z",
};

async function limparCampanha(orgId: string): Promise<void> {
  const { data: campanhas } = await admin
    .from("prospecting_campaigns")
    .select("id")
    .eq("organization_id", orgId)
    .eq("name", NOME_CAMPANHA);
  for (const c of campanhas ?? []) {
    await admin.from("prospecting_candidates").delete().eq("campaign_id", (c as { id: string }).id);
    await admin.from("prospecting_campaigns").delete().eq("id", (c as { id: string }).id);
  }
}

test.describe("Auditoria do site na fila de prospecção (#2703)", () => {
  test.beforeAll(async () => {
    if (!destinoEhLocal(URL_SUPABASE)) {
      throw new Error(`RECUSADO: ${URL_SUPABASE} não é loopback — esta spec não escreve fora do local.`);
    }
    const creds = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".e2e-creds.json"), "utf8")) as {
      org_id: string;
    };
    await limparCampanha(creds.org_id);
    const { data: campanha, error: erroCampanha } = await admin
      .from("prospecting_campaigns")
      .insert({
        organization_id: creds.org_id,
        request_id: "00000000-0000-4000-8000-000000000024",
        name: NOME_CAMPANHA,
        search: { niche: "clínica de estética", location: "Sorocaba, SP" },
        status: "paused",
        search_status: "succeeded",
      })
      .select("id")
      .single();
    if (erroCampanha || !campanha) throw new Error(`semear campanha: ${erroCampanha?.message}`);
    const fria = dadosCandidato("Clínica Fria QA", "place-fria", 4.2, 10, SITE_FRIO);
    const quente = dadosCandidato("Clínica Vitta QA", "place-quente", 5.0, 120, SITE_QUENTE);
    // Timestamps explícitos: a ordem padrão é `created_at desc`, e dois inserts
    // no mesmo milissegundo deixariam a ordem inicial indefinida (flake).
    for (const [candidato, criadoEm] of [
      [fria, "2026-06-01T12:00:00.000Z"],
      [quente, "2026-01-01T12:00:00.000Z"],
    ] as const) {
      const { error } = await admin.from("prospecting_candidates").insert({
        ...candidato,
        created_at: criadoEm,
        organization_id: creds.org_id,
        campaign_id: (campanha as { id: string }).id,
      });
      if (error) throw new Error(`semear candidato: ${error.message}`);
    }
  });

  test.afterAll(async () => {
    const creds = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".e2e-creds.json"), "utf8")) as {
      org_id: string;
    };
    await limparCampanha(creds.org_id);
  });

  test("painel, score, KPI e ordenação com valores exatos", async ({ page }) => {
    test.setTimeout(120_000);
    const creds = lerCreds();
    await loginComoAdmin(page, creds);
    await page.goto("/app/prospecting");
    await page.getByRole("button", { name: NOME_CAMPANHA, exact: true }).click();

    const linhaQuente = page.getByRole("row", { name: /Clínica Vitta QA/ });
    const linhaFria = page.getByRole("row", { name: /Clínica Fria QA/ });

    // 1. veredito + motivo do score no candidato certo (40+30+30=100).
    await expect(linhaQuente.getByText("Sem site próprio", { exact: true })).toBeVisible();
    await expect(linhaQuente.getByText("Score 100", { exact: true })).toBeVisible();
    await expect(linhaQuente.getByText("nota alta + volume de avaliações", { exact: true })).toBeVisible();
    await expect(linhaFria.getByText("Score 21", { exact: true })).toBeVisible();

    // 2. KPI é a média dos exibidos: (100+21)/2 = 60.5 → 61.
    await expect(page.getByText("Score médio", { exact: true })).toBeVisible();
    await expect(page.getByText("61", { exact: true }).first()).toBeVisible();

    // 3. ordenação por score põe o quente primeiro (antes: o frio, mais recente).
    await expect(linhaFria).toBeVisible();
    const ordemAntes = await page
      .getByRole("row", { name: /Clínica (Vitta|Fria) QA/ })
      .allTextContents();
    expect(ordemAntes[0]).toContain("Fria");
    await page.getByLabel("Ordenar").selectOption("score");
    const ordemDepois = await page
      .getByRole("row", { name: /Clínica (Vitta|Fria) QA/ })
      .allTextContents();
    expect(ordemDepois[0]).toContain("Vitta");

    // 4. ações presentes e habilitadas (o clique faria rede/IA: fora do e2e).
    await expect(linhaQuente.getByRole("button", { name: "Reanalisar site" })).toBeEnabled();
    await expect(linhaQuente.getByRole("button", { name: "Prévia da abordagem" })).toBeEnabled();
    await page.screenshot({ path: path.join(EVIDENCIA, "fila-com-auditoria.png"), fullPage: true });
  });
});
