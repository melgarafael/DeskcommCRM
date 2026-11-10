/**
 * MENSAGEM QUE SAIU POR MODELO — provado pela tela, como quem atende lê a conversa.
 *
 * ## O defeito
 *
 * Com a janela de 24 h fechada, só sai modelo aprovado. A conversa mostrava o
 * corpo do modelo como um texto qualquer: quem lia não sabia que tinha saído por
 * modelo, nem quais opções (botões) o cliente recebeu — e a resposta dele
 * ("Quero mudar algo") aparecia solta, sem a pergunta que a originou.
 *
 * ## Por que pela tela, e não só pelo teste de componente
 *
 * `components/inbox/MessageBubble.test.tsx` monta o `Message` à mão. Não prova
 * que `template_name` sobrevive à rota (`listMessagesHandler` → `MSG_COLS`): um
 * `select` sem a coluna devolve `undefined`, e o selo sai sem o nome, em
 * silêncio. Nem que `metadata.template_buttons` chega ao balão certo.
 *
 * O fixture grava a linha como o envio a grava (`app/api/v1/messages/_handler.ts`:
 * `type='template'`, `template_name`/`template_language` e os botões lidos do
 * espelho em `metadata.template_buttons`) — quem prova o envio gravando os botões
 * é `tests/unit/messages-handler-canal-intermediado.test.ts`.
 *
 * Pré-requisitos (banco local, app buildada):
 *   pnpm exec tsx scripts/seed-e2e-credentials.ts
 *   pnpm e2e:env && pnpm e2e:build
 *   E2E_PORT=3021 pnpm exec playwright test tests/e2e/inbox-mensagem-por-modelo.spec.ts
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "./helpers/test";
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), "evidence/inbox-mensagem-por-modelo");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

const env = carregarEnvLocal();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** A limpeza apaga por prefixo: a rodada anterior (worker reiniciado) também sai. */
const PREFIXO = "Mensagem por Modelo E2E";
const NOME_DO_CONTATO = `${PREFIXO} ${Date.now()}`;
const CORPO_DO_MODELO = "CORPO DO MODELO DE ENTREGA";
const CORPO_DE_TEXTO = "RESPOSTA DIGITADA COMUM";

let creds: Creds;
let conversaId = "";

async function login(page: Page, email: string, senha: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
}

async function limpar(): Promise<void> {
  const { data } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", creds.org_id)
    .like("display_name", `${PREFIXO}%`);
  const ids = ((data as Array<{ id: string }> | null) ?? []).map((c) => c.id);
  if (ids.length === 0) return;
  await admin.from("messages").delete().in("contact_id", ids);
  await admin.from("conversations").delete().in("contact_id", ids);
  await admin.from("contacts").delete().in("id", ids);
}

test.describe("Inbox — a mensagem que saiu por modelo diz qual e mostra as opções", () => {
  test.describe.configure({ timeout: 180_000 });

  test.beforeAll(async () => {
    if (!fs.existsSync(CREDS_PATH)) {
      execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
    }
    creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    await limpar();

    const { data: sessaoExistente } = await admin
      .from("channel_sessions")
      .select("id")
      .eq("organization_id", creds.org_id)
      .limit(1)
      .maybeSingle();
    let sessaoId = (sessaoExistente as { id: string } | null)?.id ?? null;
    if (!sessaoId) {
      const { data, error } = await admin
        .from("channel_sessions")
        .insert({
          organization_id: creds.org_id,
          waha_session_name: `e2e-mensagem-por-modelo-${Date.now()}`,
          webhook_secret_encrypted: "e2e",
        })
        .select("id")
        .single();
      if (error) throw new Error(`channel_sessions: ${error.message}`);
      sessaoId = (data as { id: string }).id;
    }

    const { data: contato, error: erroContato } = await admin
      .from("contacts")
      .insert({
        organization_id: creds.org_id,
        display_name: NOME_DO_CONTATO,
        phone_number: `+55119${String(Date.now()).slice(-8)}`,
      })
      .select("id")
      .single();
    if (erroContato) throw new Error(`contacts: ${erroContato.message}`);
    const contatoId = (contato as { id: string }).id;

    const { data: conversa, error: erroConversa } = await admin
      .from("conversations")
      .insert({
        organization_id: creds.org_id,
        contact_id: contatoId,
        channel_session_id: sessaoId,
        status: "open",
        last_message_at: new Date().toISOString(),
        last_inbound_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (erroConversa) throw new Error(`conversations: ${erroConversa.message}`);
    conversaId = (conversa as { id: string }).id;

    const base = {
      organization_id: creds.org_id,
      conversation_id: conversaId,
      channel_session_id: sessaoId,
      contact_id: contatoId,
      direction: "outbound",
      status: "sent",
      sent_via: "user",
      sent_by_user_id: creds.users.agent!.id,
    };
    const t0 = Date.now();
    const linhas = [
      // O CONTROLE: texto comum na mesma conversa — sem selo, sem opções.
      { ...base, type: "text", body: CORPO_DE_TEXTO, sent_at: new Date(t0).toISOString() },
      {
        ...base,
        type: "template",
        body: CORPO_DO_MODELO,
        template_name: "confirmacao_de_entrega_e2e",
        template_language: "pt_BR",
        metadata: { template_buttons: ["Sim, confirmo", "Quero mudar algo"] },
        sent_at: new Date(t0 + 1000).toISOString(),
      },
    ];
    for (const linha of linhas) {
      const { error } = await admin.from("messages").insert(linha);
      if (error) throw new Error(`messages (${linha.body}): ${error.message}`);
    }
  });

  test.afterAll(async () => {
    await limpar();
  });

  test("o balão do modelo leva o selo com o nome e as opções; o texto comum não", async ({ page }) => {
    await login(page, creds.users.agent!.email, creds.password);
    await page.goto(`/app/inbox/${conversaId}`);

    // Precondição: a conversa carregou (senão toda ausência abaixo passaria por vacuidade).
    await expect(page.getByText(CORPO_DE_TEXTO, { exact: true })).toBeVisible({ timeout: 60_000 });

    // O balão que CONTÉM o corpo: o selo, o corpo e a lista são irmãos dentro dele.
    const balaoCom = (corpo: string) => page.getByText(corpo, { exact: true }).locator("xpath=..");
    const doModelo = balaoCom(CORPO_DO_MODELO);
    await expect(doModelo.getByTestId("selo-do-modelo")).toHaveText(/confirmacao_de_entrega_e2e/);
    const opcoes = doModelo.getByRole("list", { name: /Opções enviadas ao cliente|Opciones enviadas al cliente/ });
    await expect(opcoes.getByRole("listitem")).toHaveText(["Sim, confirmo", "Quero mudar algo"]);

    const comum = balaoCom(CORPO_DE_TEXTO);
    await expect(comum.getByTestId("selo-do-modelo")).toHaveCount(0);
    await expect(comum.getByRole("list")).toHaveCount(0);

    // As opções cabem no balão: nenhuma sai pela lateral (medido, não a olho).
    const caixaDoBalao = await doModelo.boundingBox();
    for (const item of await opcoes.getByRole("listitem").all()) {
      const caixa = await item.boundingBox();
      expect(caixa && caixaDoBalao && caixa.x + caixa.width <= caixaDoBalao.x + caixaDoBalao.width + 1).toBeTruthy();
    }

    fs.mkdirSync(EVIDENCIA, { recursive: true });
    await doModelo.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(EVIDENCIA, "01-modelo-com-selo-e-opcoes.png"), animations: "disabled" });
  });
});
