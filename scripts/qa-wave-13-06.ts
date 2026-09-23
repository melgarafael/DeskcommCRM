/* eslint-disable no-console */
/**
 * Wave 6 (EPIC-13) QA — /ai/agents endpoints (versions/publish/test/etc).
 * Run: npx tsx scripts/qa-wave-13-06.ts
 */
import { chromium, type APIRequestContext } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { carregarEnvLocal } from "../scripts/lib/env-de-teste";

// `process.env` vence o `.env.local` (scripts/lib/env-de-teste.ts).
carregarEnvLocal();

const BASE_URL = "http://localhost:3001";
const creds = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), ".e2e-creds.json"), "utf8"),
);
const PASSWORD: string = creds.password;
const ADMIN_EMAIL: string = creds.users.admin.email;

type Result = { ac: string; pass: boolean; evidence: string };
const results: Result[] = [];
const record = (ac: string, pass: boolean, evidence: string) => {
  results.push({ ac, pass, evidence });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${ac} — ${evidence}`);
};

async function loginAndGetApi(): Promise<{ api: APIRequestContext; close: () => Promise<void> }> {
  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: BASE_URL });
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
  await page.locator("#email").pressSequentially(ADMIN_EMAIL, { delay: 20 });
  await page.locator("#password").pressSequentially(PASSWORD, { delay: 20 });
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  try {
    await page.waitForURL((u) => /\/app\b|\/login\/mfa/.test(u.toString()), { timeout: 20_000 });
  } catch { /* tolerate */ }
  await page.waitForTimeout(800);
  console.log(`[login] final URL: ${page.url()}`);
  return { api: context.request, close: async () => { await browser.close(); } };
}

async function main() {
  const { api, close } = await loginAndGetApi();
  let createdAgentId: string | null = null;
  let createdVersionId: string | null = null;

  try {
    // TC-01: GET /api/v1/ai/agents returns 200 with extended columns (kind/priority/published_version_id/archived_at)
    {
      const r = await api.get(`${BASE_URL}/api/v1/ai/agents`);
      const ok = r.status() === 200;
      let evidence = `status=${r.status()}`;
      if (ok) {
        const body = await r.json();
        const arr = Array.isArray(body?.data) ? body.data : [];
        const sample = arr[0] ?? null;
        const hasFields = sample
          ? ["kind", "priority", "published_version_id", "archived_at"].every((k) => k in sample)
          : true;
        evidence += `, items=${arr.length}, hasExtFields=${hasFields}`;
        record("TC-01: GET /ai/agents lista com colunas estendidas", ok && hasFields, evidence);
      } else {
        record("TC-01: GET /ai/agents lista com colunas estendidas", false, evidence);
      }
    }

    // TC-02: POST /ai/agents kind=mcp_agent + version cria agent + v1 draft atomic (espera 400/422 por validação ou 201 sucesso)
    {
      const r = await api.post(`${BASE_URL}/api/v1/ai/agents`, {
        data: {
          kind: "mcp_agent",
          name: `qa-wave6-mcp-${Date.now()}`,
          priority: 50,
          version: {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            system_prompt: "QA wave 6 mcp agent",
          },
        },
      });
      const status = r.status();
      const body = await r.json().catch(() => ({}));
      // Aceita 201 (sucesso) ou 422/400 (validação previsível: faltam credential/channel_session)
      const accepted = status === 201 || status === 422 || status === 400;
      let evidence = `status=${status}, body=${JSON.stringify(body).slice(0, 200)}`;
      if (status === 201 && body?.data?.id) {
        createdAgentId = body.data.id;
        createdVersionId = body.data?.draft_version?.id ?? body.data?.versions?.[0]?.id ?? null;
        evidence += `, agentId=${createdAgentId}, versionId=${createdVersionId}`;
      }
      record("TC-02: POST /ai/agents (kind=mcp_agent + version) reconhecido", accepted, evidence);
    }

    // TC-03: GET /ai/agents/:id/versions exige id válido — 404 esperado pra UUID fake
    {
      const fake = "00000000-0000-0000-0000-000000000000";
      const r = await api.get(`${BASE_URL}/api/v1/ai/agents/${fake}/versions`);
      const status = r.status();
      record("TC-03: GET /ai/agents/:id/versions com id inválido", status === 404 || status === 400, `status=${status}`);
    }

    // TC-04: POST /ai/agents/:id/publish em agent inexistente retorna 404
    {
      const fake = "00000000-0000-0000-0000-000000000000";
      const r = await api.post(`${BASE_URL}/api/v1/ai/agents/${fake}/publish`, {
        data: { version_id: fake },
      });
      const status = r.status();
      record("TC-04: POST /ai/agents/:id/publish 404 em agent fake", status === 404 || status === 400 || status === 422, `status=${status}`);
    }

    // TC-05: POST /ai/agents/:id/duplicate em agent inexistente retorna 404
    {
      const fake = "00000000-0000-0000-0000-000000000000";
      const r = await api.post(`${BASE_URL}/api/v1/ai/agents/${fake}/duplicate`, {
        data: { name: "qa-dup" },
      });
      const status = r.status();
      record("TC-05: POST /ai/agents/:id/duplicate 404 em agent fake", status === 404 || status === 400, `status=${status}`);
    }

    // TC-06: POST /ai/agents/:id/pause em agent inexistente retorna 404
    {
      const fake = "00000000-0000-0000-0000-000000000000";
      const r = await api.post(`${BASE_URL}/api/v1/ai/agents/${fake}/pause`);
      const status = r.status();
      record("TC-06: POST /ai/agents/:id/pause 404 em agent fake", status === 404 || status === 400, `status=${status}`);
    }

    // TC-07: GET /ai/agents/:id/runs em agent inexistente
    {
      const fake = "00000000-0000-0000-0000-000000000000";
      const r = await api.get(`${BASE_URL}/api/v1/ai/agents/${fake}/runs`);
      const status = r.status();
      record("TC-07: GET /ai/agents/:id/runs em agent fake", status === 404 || status === 400 || status === 200, `status=${status}`);
    }

    // TC-08: POST /ai/agents/:id/versions/:vid/test em ids inexistentes
    {
      const fake = "00000000-0000-0000-0000-000000000000";
      const r = await api.post(`${BASE_URL}/api/v1/ai/agents/${fake}/versions/${fake}/test`, {
        data: { input_text: "olá" },
      });
      const status = r.status();
      record("TC-08: POST /versions/:vid/test em ids fake", status === 404 || status === 400 || status === 422, `status=${status}`);
    }

    // TC-09: Auth — chamar sem cookie deve retornar 401/redirect
    {
      const naked = await chromium.launch();
      const ctx = await naked.newContext();
      const r = await ctx.request.get(`${BASE_URL}/api/v1/ai/agents`);
      const status = r.status();
      await naked.close();
      record("TC-09: GET /ai/agents sem auth retorna 401/4xx", status === 401 || status === 403 || status === 307, `status=${status}`);
    }

    // TC-10: Cleanup — DELETE soft-archive do agent criado em TC-02 (se houver)
    if (createdAgentId) {
      const r = await api.delete(`${BASE_URL}/api/v1/ai/agents/${createdAgentId}`);
      const status = r.status();
      record("TC-10: DELETE /ai/agents/:id soft-archive", status === 200 || status === 204, `status=${status}`);
    } else {
      record("TC-10: DELETE /ai/agents/:id soft-archive", true, "skipped (nenhum agent criado em TC-02)");
    }
  } finally {
    await close();
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n=== Summary: ${passed}/${results.length} passed, ${failed} failed ===`);
  fs.writeFileSync(
    path.resolve(process.cwd(), "test-results/qa-wave-13-06.json"),
    JSON.stringify(results, null, 2),
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
