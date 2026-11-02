import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "../../lib/database.types";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { test, expect, type APIRequestContext } from "./helpers/test";

// Cookies reais de usuários sintéticos ficam somente na memória do teste.
test.use({ trace: "off", video: "off" });
test.setTimeout(120_000);

test("API parcial: gerente lê só seu tenant, viewer é recusado e o recibo não devolve texto pessoal", async ({
  playwright,
}, testInfo) => {
  const c = credenciaisSupabaseDeTeste();
  if (!/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/?$/.test(c.url))
    throw new Error("Esta prova exige o Supabase local do harness.");
  const app = `http://localhost:${process.env.E2E_PORT ?? "3001"}`;
  const admin = createClient<Database>(c.url, c.serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const tenants = [
    { org: randomUUID(), trace: randomUUID(), job: randomUUID() },
    { org: randomUUID(), trace: randomUUID(), job: randomUUID() },
  ] as const;
  const orgs = tenants.map((tenant) => tenant.org);
  const contato = randomUUID(),
    versao = randomUUID(),
    vencido = randomUUID();
  const users: string[] = [],
    contexts: APIRequestContext[] = [];
  const pessoal = "Pessoa Sintética traco3201@example.test +5511999032010 123.456.789-09";
  const segredo = "sk-synthetic-3201-never-real-never-used";
  const password = `Synthetic-${randomUUID()}!`;
  let falhou = false;
  let corte: string | undefined;

  const conferir = (r: { error: unknown }, etapa: string) => {
    if (r.error) throw new Error(`Fixture sintética falhou: ${etapa}`);
  };
  const sessao = async (org: string, role: "manager" | "viewer") => {
    const email = `trace-${randomUUID()}@example.test`;
    const criado = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    conferir(criado, "usuário");
    const user = criado.data.user;
    if (!user) throw new Error("Fixture sintética sem usuário");
    users.push(user.id);
    conferir(
      await admin
        .from("user_organizations")
        .insert({
          user_id: user.id,
          organization_id: org,
          role,
          accepted_at: new Date().toISOString(),
        }),
      "membership",
    );
    const cookies = new Map<string, string>();
    const auth = createServerClient(c.url, c.anonKey, {
      cookieOptions: { name: "sb-deskcomm-auth", secure: false, sameSite: "strict", path: "/" },
      cookies: {
        getAll: () => [...cookies].map(([name, value]) => ({ name, value })),
        setAll: (novos: { name: string; value: string; options: CookieOptions }[]) => {
          for (const cookie of novos) cookies.set(cookie.name, cookie.value);
        },
      },
    });
    conferir(await auth.auth.signInWithPassword({ email, password }), "login real");
    expect(cookies.size).toBeGreaterThan(0);
    const context = await playwright.request.newContext({
      baseURL: app,
      extraHTTPHeaders: {
        cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
      },
    });
    contexts.push(context);
    return context;
  };

  try {
    for (const org of orgs)
      conferir(
        await admin
          .from("organizations")
          .insert({
            id: org,
            slug: `trace-${org}`,
            legal_name: "Empresa sintética",
            display_name: "Empresa sintética",
            onboarded_at: new Date().toISOString(),
          }),
        "organização",
      );
    for (const tenant of tenants)
      conferir(
        await admin.from("agent_turn_traces").insert({
          id: tenant.trace,
          organization_id: tenant.org,
          job_id: tenant.job,
          contact_id: contato,
          status: "failed",
          error_code: "TypeError",
          error_message: `${pessoal} ${segredo}`,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          ferramentas: [
            {
              nome: "crm_get_contact",
              estado: "falhou",
              erro: `${pessoal} ${segredo}`,
              duracao_ms: 12,
              arguments: { body: pessoal },
            },
          ],
          skills: [{ nome: pessoal, versao_id: versao, gatilho: segredo }],
          kb_sources: [],
        }),
        "traço recente",
      );
    conferir(
      await admin
        .from("agent_turn_traces")
        .insert({
          id: vencido,
          organization_id: tenants[0].org,
          job_id: randomUUID(),
          status: "completed",
          created_at: "2000-01-01T12:00:00.000Z",
        }),
      "backlog vencido",
    );
    const managerA = await sessao(tenants[0].org, "manager"),
      managerB = await sessao(tenants[1].org, "manager"),
      viewer = await sessao(tenants[0].org, "viewer");
    const anon = await playwright.request.newContext({ baseURL: app });
    contexts.push(anon);
    expect((await anon.get("/api/v1/ai/turn-traces")).status()).toBe(401);
    const negada = await viewer.get("/api/v1/ai/turn-traces");
    expect(negada.status()).toBe(403);
    expect(await negada.json()).toMatchObject({ error: { code: "forbidden_role" } });
    for (const [context, index] of [
      [managerA, 0],
      [managerB, 1],
    ] as const) {
      const outra = tenants[index === 0 ? 1 : 0];
      const resposta = await context.get(
        `/api/v1/ai/turn-traces?contact_id=${contato}&organization_id=${outra.org}`,
      );
      expect(resposta.status()).toBe(200);
      expect(resposta.headers()["x-request-id"]).toBeTruthy();
      const body = await resposta.json();
      expect(body.data.tracos.map((r: { id: string }) => r.id)).toEqual([tenants[index].trace]);
      expect(body.data.tracos[0]).toMatchObject({
        error_code: "TypeError",
        ferramentas: [{ nome: "crm_get_contact", erro: "internal_error" }],
        skills: [{ versao_id: versao }],
      });
      for (const proibido of [
        pessoal,
        segredo,
        "error_message",
        "arguments",
        "traco3201@example.test",
      ])
        expect(JSON.stringify(body)).not.toContain(proibido);
      corte = body.data.corte_retencao_em;
      if (typeof corte !== "string") throw new Error("API sem o instante de corte");
      expect(Number.isFinite(Date.parse(corte))).toBe(true);
    }
    const cruzada = await managerA.get(`/api/v1/ai/turn-traces?job_id=${tenants[1].job}`);
    expect(cruzada.status()).toBe(200);
    expect((await cruzada.json()).data.tracos).toEqual([]);
    const antiga = await managerA.get("/api/v1/ai/turn-traces?desde=2000-01-01&ate=2000-01-02");
    expect(antiga.status()).toBe(200);
    expect((await antiga.json()).data).toMatchObject({
      tracos: [],
      total: 0,
      motivo_do_vazio: "fora_da_retencao",
      janela: { dias: 0 },
    });
    for (const query of ["desde=2026-02-30", "desde=2026-10-25&ate=2026-10-24"]) {
      const invalida = await managerA.get(`/api/v1/ai/turn-traces?${query}`);
      expect(invalida.status()).toBe(422);
      expect(await invalida.json()).toMatchObject({ error: { code: "invalid_query" } });
    }
  } catch (erro) {
    falhou = true;
    throw erro;
  } finally {
    const problemas: string[] = [];
    for (const context of contexts)
      try {
        await context.dispose();
      } catch {
        problemas.push("contexto HTTP");
      }
    for (const org of orgs)
      if ((await admin.from("organizations").delete().eq("id", org)).error)
        problemas.push("organização sintética");
    for (const user of users)
      if ((await admin.auth.admin.deleteUser(user)).error) problemas.push("usuário sintético");
    if (problemas.length) {
      if (falhou) testInfo.annotations.push({ type: "cleanup", description: problemas.join(", ") });
      else throw new Error(`Cleanup da prova: ${problemas.join(", ")}`);
    }
  }
  mkdirSync("evidence/tracos-3516", { recursive: true });
  writeFileSync(
    "evidence/tracos-3516/recibo-api.json",
    JSON.stringify(
      {
        escopo: "API parcial; sem tela",
        tenants: 2,
        manager: [200, 200],
        viewer: 403,
        anonimo: 401,
        isolamento: "PASS",
        conteudo_tecnico: "PASS",
        datas: "PASS",
        corte_retencao_em: corte,
        traces: tenants.map((tenant) => tenant.trace),
      },
      null,
      2,
    ) + "\n",
  );
});
