/** Next/Supabase/browser reais; Resend em receiver HTTP sintético persistente dojob. */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { byteaToBuffer, decryptKey } from "@/lib/crypto/aes_gcm";
import fixture from "../fixtures/resend-da-organizacao.json";
import { test, expect, type Page } from "./helpers/test";
import {
  encerrarFilhosDaProvaDeEmail,
  executarFilhoDaProvaDeEmail,
} from "./helpers/filho-da-prova-de-email";
import { generateTotp, msUntilNextTotpWindow } from "./utils/totp";

const RECEIVER = "http://127.0.0.1:3997";
const EVIDENCE = path.join(process.cwd(), "evidence/email-da-organizacao");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

type Creds = {
  password: string;
  org_id: string;
  users: { admin: { id: string; email: string } };
  admin_totp: { secret: string };
};
type Received = {
  metodo: string;
  caminho: string;
  authorization_sha256?: string;
  corpo?: Record<string, unknown>;
};

function bancoLocal() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !service || !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) {
    throw new Error("A prova de e-mail exige o Supabase local doCI.");
  }
  return createClient<Database>(url, service, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function entrar(page: Page, creds: Creds) {
  await page.goto("/login");
  await page.locator("#email").fill(creds.users.admin.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/login\/mfa/);
  // Outra spec pode ter usado o código desta janela. Espera a próxima janela
  // real, sem rotacionar o fator do admin compartilhado nem mudar relógio/TZ.
  await page.waitForTimeout(msUntilNextTotpWindow() + 200);
  await page.locator('input[aria-label="Dígito 1"]').click();
  await page.keyboard.type(generateTotp(creds.admin_totp.secret), { delay: 40 });
  await page.waitForURL(/\/app\//);
}

async function trocar(page: Page, orgId: string, name: string) {
  // O reload da Marca longa conserva o scroll. Conclui a volta real ao topo
  // antes de abrir o portal, sem forçar clique em item fora da janela.
  await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" }));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  const seletor = page.getByTestId("tenant-switcher");
  await expect(seletor).toBeInViewport();
  await seletor.click();
  const destino = page.getByTestId(`tenant-switcher-item-${orgId}`);
  await expect(destino).toBeInViewport();
  await destino.click({ timeout: 5_000 });
  await page.waitForURL(/\/app\/inbox(?:\?|$)/);
  await expect(page.getByTestId("tenant-switcher")).toHaveAttribute(
    "aria-label",
    `Organização: ${name}`,
  );
  await expect(page.getByTestId("organization-transition")).toHaveCount(0);
}

async function abrirMarcaPeloMenu(page: Page) {
  await page.getByRole("link", { name: "Configurações", exact: true }).click();
  await page.locator('a[href="/app/settings/marca"]').click();
  await expect(page.locator("#org_resend_api_key")).toBeVisible();
}

async function conectar(page: Page, key: string, from: string) {
  await page.locator("#org_resend_api_key").fill(key);
  await page.locator("#org_resend_from_email").fill(from);
  await page.getByRole("button", { name: "Conectar conta Resend", exact: true }).click();
}

async function recibos(): Promise<Received[]> {
  const r = await fetch(`${RECEIVER}/__duble/recebidos`, { signal: AbortSignal.timeout(5_000) });
  if (!r.ok) throw new Error("O receiver persistente não devolveu os recibos.");
  const body = (await r.json()) as { requisicoes: Received[] };
  return body.requisicoes;
}

test.afterEach(async () => {
  await encerrarFilhosDaProvaDeEmail();
});

// Um login, dois tenants próprios e todos os passos no mesmo caso:120s de teto
// próprio (inclusive encerramento do filho), sem alterar o teto dojob ou outro teste.
// playwright.config.ts mantém retries:0. Os120s próprios cabem nos336s medidos.
test("admin conecta e recarrega sem segredo, confere DNS, envia por duas contas e desconecta", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const creds = JSON.parse(
    readFileSync(path.join(process.cwd(), ".e2e-creds.json"), "utf8"),
  ) as Creds;
  expect(
    Boolean(creds.admin_totp?.secret && creds.users.admin.id && creds.org_id),
    "seed de admin/MFA ausente",
  ).toBe(true);
  expect(process.env.RESEND_BASE_URL).toBe(RECEIVER);
  const db = bancoLocal();
  const original = await db
    .from("organizations")
    .select("display_name")
    .eq("id", creds.org_id)
    .single();
  if (original.error || !original.data?.display_name)
    throw new Error("Não foi possível confirmar o nome atual da organização original.");
  const nomeOriginal = original.data.display_name;
  const suffix = randomUUID();
  const names = [
    `Empresa a sintética ${suffix.slice(0, 8)}`,
    `Empresa b sintética ${suffix.slice(0, 8)}`,
  ];
  const ids: string[] = [];
  const responses: Promise<void>[] = [];
  const bodies: string[] = [];
  const children: { pid: number; closed_before_cleanup: true }[] = [];
  const stages: string[] = [];
  const shots: { name: string; bytes: Buffer }[] = [];
  let evidence: Record<string, unknown> | null = null;
  let lastCipher = "";
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/app/settings/marca") {
      responses.push(
        response
          .text()
          .then((body) => {
            bodies.push(body);
          })
          .catch(() => undefined),
      );
    }
  });
  const count = async (id: string) => {
    const r = await db
      .from("organization_resend_accounts")
      .select("organization_id", { count: "exact", head: true })
      .eq("organization_id", id);
    if (r.error || r.count === null) throw new Error("A contagem real da conta falhou.");
    return r.count;
  };
  const noSecret = async () => {
    await Promise.all(responses);
    expect(bodies.length > 0, "nenhuma resposta de tela foi observada").toBe(true);
    const all = [...bodies, await page.content()];
    for (const body of all) {
      for (const key of [...Object.values(fixture.errors), fixture.a.key, fixture.b.key]) {
        expect(body.includes(key), "uma chave apareceu no retorno da tela").toBe(false);
      }
      if (lastCipher)
        expect(
          body.includes(lastCipher.replace(/^\\x/, "")),
          "ciphertext apareceu no retorno da tela",
        ).toBe(false);
    }
    await expect(page.locator("#org_resend_api_key")).toHaveValue("");
  };
  const capture = async (name: string) => {
    shots.push({ name, bytes: await page.screenshot({ fullPage: true }) });
    stages.push(name);
  };
  const run = async (id: string, subject: string) => {
    const receipt = await executarFilhoDaProvaDeEmail(
      ["--import", "tsx", "scripts/provas/enviar-email-da-organizacao.ts"],
      { organization_id: id, recipient: `prova-${suffix}@destino.email-e2e.invalid`, subject },
    );
    children.push({ pid: receipt.pid, closed_before_cleanup: receipt.closed_before_cleanup });
    return receipt.result;
  };
  mkdirSync(EVIDENCE, { recursive: true });
  try {
    const pa = await db
      .from("platform_admins")
      .select("user_id", { count: "exact", head: true })
      .eq("user_id", creds.users.admin.id)
      .is("revoked_at", null);
    expect(
      pa.error === null && pa.count === 0,
      "o admin da prova não pode ser platform admin",
    ).toBe(true);
    for (const [index, name] of ["a", "b"].entries()) {
      const org = await db
        .from("organizations")
        .insert({
          slug: `e2e-email-resend-${name}-${suffix.slice(0, 8)}`,
          legal_name: names[index]!,
          display_name: names[index]!,
          onboarded_at: new Date().toISOString(),
          settings: {
            branding: {
              email_from_name: `Empresa ${name} sintética`,
              email_reply_to: `resposta@empresa-${name}.email-e2e.invalid`,
            },
          },
        })
        .select("id")
        .single();
      if (org.error || !org.data) throw new Error("Não foi possível criar organização própria.");
      ids.push(org.data.id);
      const member = await db
        .from("user_organizations")
        .insert({
          organization_id: org.data.id,
          user_id: creds.users.admin.id,
          role: "admin",
          accepted_at: new Date().toISOString(),
        });
      if (member.error) throw new Error("Não foi possível associar o admin à organização própria.");
    }
    await entrar(page, creds);
    await trocar(page, ids[0]!, names[0]!);
    // Descoberta da porta real, pelo menu: não digitar a URL da funcionalidade.
    await abrirMarcaPeloMenu(page);
    await expect(page.getByText("Nenhuma conta Resend conectada.", { exact: true })).toBeVisible();
    expect(await count(ids[0]!)).toBe(0);

    // Recusas não gravam. Nenhuma delas depende da conta criada por outra spec.
    const beforeInvalid = (await recibos()).filter((r) => r.caminho.startsWith("/domains")).length;
    await conectar(page, fixture.a.key, `bad<sender@${fixture.a.domain}`);
    await expect(
      page.getByText("Use um endereço de e-mail como contato@suaempresa.com", { exact: true }),
    ).toBeVisible();
    expect((await recibos()).filter((r) => r.caminho.startsWith("/domains")).length).toBe(
      beforeInvalid,
    );
    expect(await count(ids[0]!)).toBe(0);
    const errors = [
      [
        fixture.errors.permission,
        "Esta chave não permite consultar domínios. Crie uma chave Full Access na Resend e tente de novo.",
      ],
      [
        fixture.errors.pending,
        `O domínio ${fixture.a.domain} ainda não está verificado na sua conta Resend. Verifique os registros dele no painel da Resend e tente de novo.`,
      ],
      [
        fixture.errors.disabled,
        "O envio está desativado para este domínio na Resend. Ative-o no painel da Resend e tente de novo.",
      ],
      [
        fixture.errors.unavailable,
        "Não consegui consultar a Resend agora. Tente de novo em instantes.",
      ],
    ] as const;
    for (const [key, expected] of errors) {
      await conectar(page, key, fixture.a.from);
      await expect(page.getByText(expected, { exact: true })).toBeVisible();
      expect(await count(ids[0]!)).toBe(0);
    }
    await page.locator("#org_resend_api_key").fill("");
    await capture("01-recusas-nao-gravam.png");

    await conectar(page, fixture.a.key, fixture.a.from);
    await expect(
      page.getByText("Conta Resend conectada. Os e-mails das automações saem por ela agora.", {
        exact: true,
      }),
    ).toBeVisible();
    await page.reload();
    await expect(page.locator("#org_resend_from_email")).toHaveValue(fixture.a.from);
    const account = await db
      .from("organization_resend_accounts")
      .select("*")
      .eq("organization_id", ids[0]!)
      .single();
    if (account.error || !account.data) throw new Error("A conta conectada não foi lida do banco.");
    expect(account.data.api_key_last4).toBe(fixture.a.key.slice(-4));
    lastCipher = account.data.api_key_ciphertext;
    const decrypted = decryptKey({
      ciphertext: byteaToBuffer(account.data.api_key_ciphertext),
      iv: byteaToBuffer(account.data.api_key_iv),
      tag: byteaToBuffer(account.data.api_key_tag),
    });
    expect(decrypted === fixture.a.key, "a cifra real não recupera a chave da conta").toBe(true);
    await noSecret();
    await capture("02-conectada-reload-sem-chave.png");

    await page.getByRole("button", { name: "Conferir", exact: true }).click();
    await expect(page.getByText("Domínio verificado na Resend", { exact: true })).toBeVisible();
    await expect(
      page.getByText(`outbound.${fixture.a.domain}`, { exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByText("Ausente", { exact: true }).first()).toBeVisible();
    await capture("03-verificado-e-dns-ausente-distintos.png");
    const subjectA = `prova-email-${randomUUID()}`;
    expect(await run(ids[0]!, subjectA)).toMatchObject({
      ok: true,
      status: "success",
      via: "resend",
    });
    const postA = (await recibos()).filter(
      (r) => r.metodo === "POST" && r.caminho === "/emails" && r.corpo?.subject === subjectA,
    );
    expect(postA).toHaveLength(1);
    expect(postA[0]).toMatchObject({
      authorization_sha256: sha(`Bearer ${fixture.a.key}`),
      corpo: {
        from: `Empresa a sintética <${fixture.a.from}>`,
        reply_to: "resposta@empresa-a.email-e2e.invalid",
      },
    });
    expect(
      Array.isArray(postA[0]!.corpo!.to) ? postA[0]!.corpo!.to : [postA[0]!.corpo!.to],
    ).toEqual([`prova-${suffix}@destino.email-e2e.invalid`]);

    // Conta configurada ilegível não vira ausência/fallback: app e ação real recusam.
    const bad = await db
      .from("organization_resend_accounts")
      .update({ api_key_ciphertext: "\\x00" })
      .eq("organization_id", ids[0]!);
    if (bad.error) throw new Error("Não foi possível preparar a cifra inválida própria.");
    await page.reload();
    // A projeção segura da tela não decifra: a conta continua configurada.
    await expect(page.locator("#org_resend_from_email")).toHaveValue(fixture.a.from);
    expect(await count(ids[0]!)).toBe(1);
    const subjectBad = `prova-email-${randomUUID()}`;
    expect(await run(ids[0]!, subjectBad)).toMatchObject({
      ok: false,
      status: "failed",
      error: "conta_de_email_indisponivel",
    });
    expect(
      (await recibos()).filter(
        (r) => r.metodo === "POST" && r.caminho === "/emails" && r.corpo?.subject === subjectBad,
      ),
    ).toHaveLength(0);
    const restore = await db
      .from("organization_resend_accounts")
      .update({ api_key_ciphertext: account.data.api_key_ciphertext })
      .eq("organization_id", ids[0]!);
    if (restore.error) throw new Error("Não foi possível restaurar a conta própria.");

    await trocar(page, ids[1]!, names[1]!);
    await abrirMarcaPeloMenu(page);
    await expect(page.getByText("Nenhuma conta Resend conectada.", { exact: true })).toBeVisible();
    await expect(page.locator("#org_resend_from_email")).toHaveValue("");
    await conectar(page, fixture.b.key, fixture.b.from);
    await expect(
      page.getByText("Conta Resend conectada. Os e-mails das automações saem por ela agora.", {
        exact: true,
      }),
    ).toBeVisible();
    await page.reload();
    await expect(page.locator("#org_resend_from_email")).toHaveValue(fixture.b.from);
    expect(await count(ids[0]!)).toBe(1);
    expect(await count(ids[1]!)).toBe(1);
    await noSecret();
    const subjectB = `prova-email-${randomUUID()}`;
    expect(await run(ids[1]!, subjectB)).toMatchObject({
      ok: true,
      status: "success",
      via: "resend",
    });
    const postB = (await recibos()).filter(
      (r) => r.metodo === "POST" && r.caminho === "/emails" && r.corpo?.subject === subjectB,
    );
    expect(postB).toHaveLength(1);
    expect(postB[0]).toMatchObject({
      authorization_sha256: sha(`Bearer ${fixture.b.key}`),
      corpo: {
        from: `Empresa b sintética <${fixture.b.from}>`,
        reply_to: "resposta@empresa-b.email-e2e.invalid",
      },
    });
    expect(
      Array.isArray(postB[0]!.corpo!.to) ? postB[0]!.corpo!.to : [postB[0]!.corpo!.to],
    ).toEqual([`prova-${suffix}@destino.email-e2e.invalid`]);
    expect(postA[0]!.authorization_sha256 === postB[0]!.authorization_sha256).toBe(false);
    await capture("05-outra-empresa-outro-remetente.png");
    await trocar(page, ids[0]!, names[0]!);
    await abrirMarcaPeloMenu(page);
    await expect(page.locator("#org_resend_from_email")).toHaveValue(fixture.a.from);
    await page.getByRole("button", { name: "Desconectar", exact: true }).click();
    await expect(page.getByText("Nenhuma conta Resend conectada.", { exact: true })).toBeVisible();
    await page.reload();
    expect(await count(ids[0]!)).toBe(0);
    expect(await count(ids[1]!)).toBe(1);
    await noSecret();
    await capture("06-desconectada-vizinha-preservada.png");
    await trocar(page, creds.org_id, nomeOriginal);
    evidence = {
      candidate_sha: process.env.CANDIDATO_SHA ?? null,
      checkout_sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      run_id: process.env.GITHUB_RUN_ID ?? null,
      observed_at: new Date().toISOString(),
      transport: "receiver HTTP sintético persistente3997; sem entrega paga/caixa postal",
      action_boundary: "execute real send_email + banco; sem cron/fila",
      organizations: [...ids],
      same_admin_two_tenants: true,
      pngs: stages,
      children,
      http: [...postA, ...postB],
      invalid_cipher: {
        configured_rows: 1,
        action_status: "failed",
        error: "conta_de_email_indisponivel",
        outgoing_posts: 0,
      },
      response_bodies_checked: bodies.length,
    };
  } finally {
    // O callback do filho já fechou o PID antes de run() devolver, inclusive no timeout.
    await encerrarFilhosDaProvaDeEmail();
    await page.close();
    const cleanupFailed: string[] = [];
    for (const id of ids) {
      const removed = await db
        .from("organizations")
        .delete()
        .eq("id", id)
        .like("slug", "e2e-email-resend-%")
        .select("id");
      if (removed.error || !removed.data || removed.data.length !== 1) cleanupFailed.push(id);
    }
    if (cleanupFailed.length) throw new Error("Cleanup da organização própria falhou.");
  }
  // O recibo só declara PASS depois do encerramento dos filhos e cleanup de ambos tenants.
  for (const shot of shots) writeFileSync(path.join(EVIDENCE, shot.name), shot.bytes);
  writeFileSync(
    path.join(EVIDENCE, "recibo.json"),
    JSON.stringify(
      {
        ...evidence,
        cases_passed: 1,
        cleanup_organizations_removed: true,
        finished_at: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
});
