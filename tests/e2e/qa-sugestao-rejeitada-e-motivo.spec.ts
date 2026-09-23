/**
 * A SUGESTÃO REJEITADA SAI DA TELA, E A FALHA DIZ O MOTIVO — pela tela (PR #740).
 *
 * ─── As duas metades, e por que nenhuma spec cobria ───────────────────────
 *
 * 1) `ReplyReviewPanel` mostrava `drafts[0]` — a mais recente, QUALQUER que
 *    fosse o estado. Rejeitar não fecha nada, então a rejeitada continuava
 *    sendo a mais recente e o texto morto ficava na tela, com a caixa
 *    desabilitada e sem botão de fechar. `autonomia-assistida.spec.ts` percorre
 *    APROVAR; ninguém clicava em "Rejeitar".
 *
 * 2) A rota fazia `} catch {` — sem nome. Três causas viravam a mesma frase,
 *    que mandava conferir a publicação do agente mesmo quando o problema era
 *    outro. Aqui se mede a frase que a tela mostra para a causa mais comum:
 *    nenhum agente publicado atende o canal.
 *
 * ─── Ambiente ────────────────────────────────────────────────────────────
 *
 * `INTERNAL_AGENT_RUN_STUB=true` (mesmo interruptor de
 * `autonomia-assistida.spec.ts`): a geração roda o caminho REAL da rota, com o
 * provedor de LLM trocado por fixture. Sem ele o arquivo pula — ambiente
 * ausente não é defeito.
 */
import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { expect, test, type Page } from "@playwright/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { seedPlatformPlaybook } from "../../lib/agent-engine/agent/playbook-seed";

const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, {
  auth: { persistSession: false },
});
const senha = `Local-${randomUUID()}!`;
const orgs: string[] = [];
const usuarios: string[] = [];

test.skip(
  process.env.INTERNAL_AGENT_RUN_STUB !== "true",
  "INTERNAL_AGENT_RUN_STUB ausente — a geração da sugestão chamaria um provedor de LLM real.",
);
test.describe.configure({ timeout: 240_000 });

async function inserir(tabela: string, valor: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from(tabela).insert(valor).select("id").single();
  if (error) throw error;
  return data.id as string;
}

async function fixture(pool: pg.Pool) {
  expect(["127.0.0.1", "localhost"]).toContain(new URL(credenciais.dbUrl).hostname);
  await seedPlatformPlaybook(pool);
  const email = `sugestao-ui-${randomUUID()}@invariant.test`;
  const criado = await db.auth.admin.createUser({ email, password: senha, email_confirm: true });
  if (criado.error || !criado.data.user) throw criado.error;
  const user = criado.data.user.id;
  usuarios.push(user);
  const org = await inserir("organizations", {
    slug: `sugestao-ui-${randomUUID()}`,
    display_name: "Sugestão local",
    legal_name: "Sugestão local",
    onboarded_at: new Date().toISOString(),
  });
  orgs.push(org);
  await inserir("user_organizations", {
    organization_id: org,
    user_id: user,
    role: "admin",
    accepted_at: new Date().toISOString(),
  });
  const sessionName = randomUUID();
  const channel = await inserir("channel_sessions", {
    organization_id: org,
    waha_session_name: sessionName,
    display_name: "Revisão local",
    status: "WORKING",
    webhook_secret_encrypted: "\\x00",
    metadata: { ai_gate: "allowlist" },
  });
  const knobs = await db.from("channel_knobs").insert({
    organization_id: org,
    channel_session_id: channel,
    throttle_ms: 0,
    jitter_max_ms: 0,
    window_start_hour: 0,
    window_end_hour: 24,
  });
  if (knobs.error) throw knobs.error;
  const contact = await inserir("contacts", {
    organization_id: org,
    name: "Joana Revisão",
    display_name: "Joana Revisão",
    phone_number: "+15557654321",
    force_human: true,
  });
  const conversation = await inserir("conversations", {
    organization_id: org,
    contact_id: contact,
    channel_session_id: channel,
    status: "open",
    assignee_kind: "user",
    assigned_to_user_id: user,
    bot_silenced_until: "infinity",
  });
  const agent = await inserir("ai_agents", {
    organization_id: org,
    name: "Assistente para revisão",
    system_prompt: "Ajude com informações confirmadas.",
    operation_mode: "assisted",
  });
  const version = await inserir("ai_agent_versions", {
    organization_id: org,
    agent_id: agent,
    version_number: 1,
    system_prompt: "Ajude com informações confirmadas.",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    channel_session_id: channel,
    status: "published",
  });
  const source = await inserir("ai_knowledge_sources", {
    organization_id: org,
    agent_id: agent,
    source_type: "faq",
    name: "Atendimento",
    status: "ready",
  });
  const knowledge = await inserir("ai_knowledge_versions", {
    organization_id: org,
    agent_id: agent,
    version_number: 1,
    is_active: true,
  });
  const chunk = randomUUID();
  await pool.query(
    "insert into ai_chunks(id,organization_id,knowledge_source_id,kb_version_id,position,content,content_hash,token_count,embedding,metadata) values($1::uuid,$2,$3,$4,0,'Informações de atendimento disponíveis com confirmação humana.',$1::text,12,array_fill(0.1::real,array[1536])::vector,'{}')",
    [chunk, org, source, knowledge],
  );
  await pool.query(
    "update ai_agents set published_version_id=$1,active_kb_version_id=$2 where organization_id=$3 and id=$4",
    [version, knowledge, org, agent],
  );
  await pool.query(
    "update conversations set active_ai_agent_id=$1 where organization_id=$2 and id=$3",
    [agent, org, conversation],
  );
  const f = { org, user, email, channel, contact, conversation, agent, version };
  await entrada(f, "Quero informações do atendimento");
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function entrada(
  f: Pick<Fixture, "org" | "contact" | "conversation" | "channel">,
  texto: string,
) {
  const at = new Date().toISOString();
  await inserir("messages", {
    organization_id: f.org,
    contact_id: f.contact,
    conversation_id: f.conversation,
    channel_session_id: f.channel,
    direction: "inbound",
    type: "text",
    status: "received",
    external_id: randomUUID(),
    body: texto,
    sent_at: at,
  });
  const r = await db.rpc("fn_mark_conversation_message", {
    p_conv: f.conversation,
    p_direction: "inbound",
    p_preview: texto,
    p_at: at,
  });
  if (r.error) throw r.error;
}

async function entrar(page: Page, f: Fixture) {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(f.email);
  await page.getByLabel(/senha/i).fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(?:\/|$)/, { timeout: 60_000 });
}

const painel = (page: Page) => page.locator('section[aria-label="Assistência do agente"]');

test.afterAll(async () => {
  for (const org of orgs) {
    const r = await db.from("organizations").delete().eq("id", org);
    if (r.error) throw r.error;
  }
  for (const user of usuarios) {
    const r = await db.auth.admin.deleteUser(user);
    if (r.error) throw r.error;
  }
});

test("rejeitar tira a sugestão da tela e diz que rejeitou; sem agente publicado, a falha nomeia o motivo", async ({
  page,
}) => {
  const pool = new pg.Pool({ connectionString: credenciais.dbUrl, max: 5 });
  try {
    const f = await fixture(pool);
    await entrar(page, f);
    await page.goto(`/app/inbox/${f.conversation}`);

    // ── 1) Gera pelo caminho real da rota ──────────────────────────────────
    const gerada = page.waitForResponse(
      (r) => r.url().endsWith("/draft-reply") && r.request().method() === "POST",
    );
    await painel(page).getByRole("button", { name: "Sugerir resposta", exact: true }).click();
    const resposta = await gerada;
    expect(resposta.status(), await resposta.text()).toBe(200);
    // 20s, e não os 5s do padrão: entre o 200 do POST e o rótulo na tela há o
    // `invalidateQueries` do cliente e o poll de 4s do painel. Sob carga a
    // janela estoura, e o vermelho que sai é "o ambiente estava lento", não
    // "a tela não mostrou" — medido numa rodada em que cada caso levou 60s.
    await expect(painel(page).getByText("Sugestão para revisar", { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(painel(page).getByLabel("Resposta sugerida")).toBeVisible({ timeout: 20_000 });
    await page.screenshot({
      path: "evidence/triagem-14set/740-a-sugestao-na-tela.png",
      fullPage: false,
    });

    // ── 2) Rejeitar: a sugestão SAI, e a tela diz que saiu ─────────────────
    //
    // Antes do conserto a rejeitada continuava sendo `drafts[0]` e ficava na
    // tela para sempre — caixa desabilitada, sem botão de fechar.
    await painel(page)
      .getByLabel("Feedback para a próxima sugestão")
      .fill("Muito formal para esta cliente.");
    await painel(page).getByRole("button", { name: "Rejeitar", exact: true }).click();

    await expect(
      painel(page).getByLabel("Resposta sugerida"),
      "cliquei em Rejeitar e o texto recusado continua na tela",
    ).toHaveCount(0, { timeout: 20_000 });
    await expect(
      painel(page).getByRole("button", { name: "Rejeitar", exact: true }),
      "a sugestão rejeitada continua oferecendo os botões de decisão",
    ).toHaveCount(0);
    await expect(
      painel(page).getByText("Assistência do agente", { exact: true }),
      "o painel não voltou ao estado neutro",
    ).toBeVisible();
    // E a confirmação FICA — sem ela, Rejeitar apenas esvaziaria a tela em
    // silêncio, que é o outro meio-conserto que este PR evitou.
    await expect(
      painel(page).getByText("Sugestão rejeitada. O feedback será usado na próxima sugestão.", {
        exact: true,
      }),
      "a tela esvaziou sem dizer que a sugestão foi rejeitada",
    ).toBeVisible();
    expect(
      (
        await pool.query(
          "select status from ai_reply_drafts where organization_id=$1 and conversation_id=$2 order by created_at desc limit 1",
          [f.org, f.conversation],
        )
      ).rows[0].status,
    ).toBe("dismissed");
    await page.screenshot({
      path: "evidence/triagem-14set/740-b-rejeitada-saiu-da-tela.png",
      fullPage: false,
    });

    // ── 3) A falha diz o MOTIVO, não uma frase genérica ────────────────────
    //
    // Despublicar o agente é a causa mais comum do erro relatado. A frase que
    // a tela mostra tem de nomear ESSA causa e dizer o que fazer — antes, toda
    // falha (inclusive provedor de IA fora do ar) virava a mesma frase.
    await pool.query("update ai_agents set published_version_id=null where organization_id=$1 and id=$2", [
      f.org,
      f.agent,
    ]);
    const falhou = page.waitForResponse(
      (r) => r.url().endsWith("/draft-reply") && r.request().method() === "POST",
    );
    await painel(page).getByRole("button", { name: "Sugerir resposta", exact: true }).click();
    const recusa = await falhou;
    expect(recusa.status()).toBe(422);
    expect((await recusa.json()).error.code).toBe("reply_no_agent");
    await expect(
      page.getByText(
        "Nenhum agente publicado atende este canal. Publique uma versão do agente em IA › Agentes.",
        { exact: false },
      ),
      "a falha não disse o motivo na tela",
    ).toBeVisible({ timeout: 15_000 });
    await page.screenshot({
      path: "evidence/triagem-14set/740-c-falha-com-motivo.png",
      fullPage: false,
    });
  } finally {
    await page.close();
    await pool.end();
  }
});
