/**
 * QUEM MANDA NESTA CONVERSA — provado pela tela, como o atendente faz.
 *
 * As quatro confusões relatadas ("não sei quem está no controle", "não sei se o
 * automático está ligado nem como desligar", "não há badge do atendente", "as
 * atividades não mostram a transferência") não se provam por `curl`: elas são
 * sobre o que a pessoa VÊ. Este spec dirige o browser logado e mede o que está
 * na tela em cada passo.
 *
 * A asserção mais importante não é visual, e é de propósito: depois de clicar
 * "Assumir", o spec vai ao BANCO conferir `bot_silenced_until`. Sem isso o teste
 * provaria que a tela MUDOU DE COR, não que o atendimento automático parou — e o
 * defeito que esta entrega conserta é exatamente uma tela que dizia uma coisa
 * enquanto o motor fazia outra.
 *
 * Pré-requisitos (banco local, app buildada):
 *   pnpm exec tsx scripts/seed-e2e-credentials.ts
 *   pnpm e2e:env && pnpm e2e:build
 *   E2E_PORT=3021 pnpm exec playwright test tests/e2e/inbox-quem-manda.spec.ts
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), ".superpowers/evidence/inbox-quem-manda");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

const env = carregarEnvLocal();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let creds: Creds;
let conversaId = "";
let contatoId = "";
const NOME_DO_CONTATO = `Quem Manda ${Date.now()}`;

async function login(page: Page, email: string, senha: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(senha);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
}

async function captura(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: true });
}

/** O valor CRU da coluna — `infinity` não é data, é literal do Postgres. */
async function silencioNoBanco(): Promise<string> {
  const { data, error } = await admin
    .from("conversations")
    .select("bot_silenced_until")
    .eq("id", conversaId)
    .maybeSingle();
  if (error) throw new Error(`leitura do silêncio falhou: ${error.message}`);
  return (data as { bot_silenced_until: string | null } | null)?.bot_silenced_until ?? "(null)";
}

test.describe("Inbox — quem manda nesta conversa", () => {
  test.describe.configure({ timeout: 180_000 });

  test.beforeAll(async () => {
    if (!fs.existsSync(CREDS_PATH)) {
      execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
    }
    creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;

    // Um canal qualquer da org serve: o que este spec mede não depende de
    // provider. Se a org ainda não tem nenhum, cria um — a instalação fresca é
    // justamente o estado que a doutrina manda testar.
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
          waha_session_name: `e2e-quem-manda-${Date.now()}`,
          webhook_secret_encrypted: "e2e",
        })
        .select("id")
        .single();
      if (error) throw new Error(`channel_sessions: ${error.message}`);
      sessaoId = (data as { id: string }).id;
    }

    // A PRECONDIÇÃO DO PASSO (1): esta org PRECISA ter automático no ar.
    //
    // "No ar" passou a significar VERSÃO PUBLICADA (`lib/ai/agents/no-ar.ts`):
    // o estado `no_ar_legado` saiu, `agenteAtende` não conta mais o `rag_bot`
    // ativo e nunca publicado, e o worker legado deixou de responder por ele —
    // quem cuida desse agente agora é a recuperação de legado. O agente que
    // `scripts/seed-e2e-credentials.ts` cria é exatamente esse: ativo, sem
    // publicação. SEM esta publicação a tela escreve "Sem responsável" e
    // ACERTA — não há automático de quem a pessoa possa assumir o comando —, e
    // o teste morre na precondição sem nunca exercitar o handoff, que é o que
    // ele existe para medir. Publicar aqui devolve o cenário; a asserção
    // `/autom/i` continua exatamente como estava.
    const { data: agente } = await admin
      .from("ai_agents")
      .select("id, published_version_id")
      .eq("organization_id", creds.org_id)
      .eq("is_default", true)
      .maybeSingle();
    const agenteDefault = agente as { id: string; published_version_id: string | null } | null;
    if (!agenteDefault) throw new Error("a org de teste não tem agente default");
    if (!agenteDefault.published_version_id) {
      // `version_number` é único por agente: numerar a partir do que já existe,
      // senão um rascunho deixado por outra spec faz colidir em vez de publicar.
      const { data: ultima } = await admin
        .from("ai_agent_versions")
        .select("version_number")
        .eq("agent_id", agenteDefault.id)
        .order("version_number", { ascending: false })
        .limit(1)
        .maybeSingle();
      const proximo = ((ultima as { version_number: number } | null)?.version_number ?? 0) + 1;
      const { data: versao, error: erroVersao } = await admin
        .from("ai_agent_versions")
        .insert({
          organization_id: creds.org_id,
          agent_id: agenteDefault.id,
          version_number: proximo,
          system_prompt: "Atendimento automático do E2E.",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          // Nulo = a chave da instalação; a coluna é nullable de propósito.
          credential_id: null,
          channel_session_id: sessaoId,
          status: "published",
          published_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      if (erroVersao) throw new Error(`ai_agent_versions: ${erroVersao.message}`);
      const { error: erroPtr } = await admin
        .from("ai_agents")
        .update({ published_version_id: (versao as { id: string }).id })
        .eq("id", agenteDefault.id);
      if (erroPtr) throw new Error(`published_version_id: ${erroPtr.message}`);
    }

    const { data: contato, error: erroContato } = await admin
      .from("contacts")
      .insert({
        organization_id: creds.org_id,
        display_name: NOME_DO_CONTATO,
        // E.164 com o `+`: `contacts_phone_e164_format` exige `^\+\d{8,15}$`.
        phone_number: `+55119${String(Date.now()).slice(-8)}`,
      })
      .select("id")
      .single();
    if (erroContato) throw new Error(`contacts: ${erroContato.message}`);
    contatoId = (contato as { id: string }).id;

    // O ESTADO DE PARTIDA é o normal: aberta, sem dono, sem silêncio — que é
    // exatamente o que a ingestão do WhatsApp cria e o que o automático atende.
    const { data: conversa, error: erroConversa } = await admin
      .from("conversations")
      .insert({
        organization_id: creds.org_id,
        contact_id: contatoId,
        channel_session_id: sessaoId,
        status: "open",
        last_message_preview: "Oi, queria saber o preço",
        last_message_at: new Date().toISOString(),
        last_inbound_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (erroConversa) throw new Error(`conversations: ${erroConversa.message}`);
    conversaId = (conversa as { id: string }).id;

    // UM NEGÓCIO ABERTO, porque `crm_lead_activities.lead_id` é NOT NULL.
    //
    // Não é conveniência de teste: é a limitação REAL, documentada em
    // `lib/inbox/atividade-de-comando.ts`. Conversa sem negócio não tem onde
    // pendurar a linha da timeline, e é a MESMA limitação que a ida e a volta
    // IA↔humano já têm. Semear o lead aqui é o que faz o passo (5) medir o
    // caminho que existe, em vez de reprovar por uma ausência que já era conhecida.
    const { data: funil } = await admin
      .from("crm_pipelines")
      .select("id, crm_stages(id)")
      .eq("organization_id", creds.org_id)
      .eq("is_archived", false)
      .limit(1)
      .maybeSingle();
    const funilId = (funil as { id: string } | null)?.id;
    const etapaId = (funil as { crm_stages?: Array<{ id: string }> } | null)?.crm_stages?.[0]?.id;
    if (!funilId || !etapaId) throw new Error("a org de teste não tem funil com etapa");

    const { error: erroLead } = await admin.from("crm_leads").insert({
      organization_id: creds.org_id,
      contact_id: contatoId,
      pipeline_id: funilId,
      stage_id: etapaId,
      title: `Negócio de ${NOME_DO_CONTATO}`,
    });
    if (erroLead) throw new Error(`crm_leads: ${erroLead.message}`);
  });

  test("o automático atende, a pessoa assume, o automático PARA, e a volta existe", async ({
    page,
  }) => {
    const atendente = creds.users.agent!;
    await login(page, atendente.email, creds.password);

    // -----------------------------------------------------------------
    // (1) Estado de partida: quem manda é o automático — e a tela diz.
    // -----------------------------------------------------------------
    await page.goto(`/app/inbox/${conversaId}`);
    const comando = page.getByTestId("comando-da-conversa");
    await expect(comando).toBeVisible({ timeout: 30_000 });
    await expect(comando).toContainText(/autom/i);
    // O CONTROLE: sem silêncio no banco, nada de selo de pausa na tela. Sem esta
    // asserção, o selo do passo (3) não distinguiria "apareceu agora" de "já
    // estava lá desde o começo".
    await expect(page.getByTestId("badge-atendimento-humano")).toHaveCount(0);
    expect(await silencioNoBanco()).toBe("(null)");
    await captura(page, "1-automatico-no-comando");

    // -----------------------------------------------------------------
    // (2) A pessoa assume — pelo botão, como ela faria.
    // -----------------------------------------------------------------
    await page.getByRole("button", { name: /^Assumir$/i }).click();

    // -----------------------------------------------------------------
    // (3) A tela passa a dizer QUEM manda, e o selo explica o porquê.
    // -----------------------------------------------------------------
    // O NOME DE VERDADE, não o rótulo genérico.
    //
    // A primeira versão aceitava `/atendente|e2e/i` — e "Atendente" é exatamente o
    // fallback que a tela usa quando o nome NÃO foi resolvido (self-host sem
    // service role, ou lookup que falhou). Ou seja: o teste que existe para provar
    // a reclamação nº 3 passava no estado degradado, que é o estado em que a
    // feature não funciona. Agora ele exige o `full_name` que o seed grava…
    await expect(comando).toContainText("E2E Agent", { timeout: 30_000 });
    // …e recusa o genérico. Sem esta metade, um dia em que o nome voltasse null e
    // a tela caísse no fallback passaria despercebido.
    await expect(comando).not.toContainText(/^Atendente$/);
    await expect(page.getByTestId("badge-atendimento-humano")).toContainText(/assumiu/i);
    await captura(page, "2-pessoa-no-comando");

    // -----------------------------------------------------------------
    // (4) A PROVA QUE IMPORTA: o automático parou de verdade.
    //
    // Sem esta linha, tudo acima provaria que a tela mudou — não que o motor
    // parou. `bot_silenced_until` é o gate que os três guards do motor leem.
    // -----------------------------------------------------------------
    await expect.poll(async () => silencioNoBanco(), { timeout: 30_000 }).toMatch(/infinity/);

    // -----------------------------------------------------------------
    // (5) A troca de comando aparece na linha do tempo do painel.
    // -----------------------------------------------------------------
    // Sem `if`: com o negócio semeado a linha TEM de aparecer. Uma asserção
    // condicional aqui passaria calada justamente no caso em que a feature não
    // funciona — que é o modo de falha que esta entrega existe para acabar.
    await expect(page.getByText("Atividade", { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(/Assumiu a conversa/i).first()).toBeVisible({
      timeout: 30_000,
    });
    // E com o NOME de quem agiu, não "Você/time" — é a diferença entre saber que
    // uma pessoa mexeu e saber QUAL pessoa.
    await expect(page.getByText(/Você\/time/).first()).toHaveCount(0);

    // -----------------------------------------------------------------
    // (6) A VOLTA existe e funciona — o interruptor tem os dois lados.
    // -----------------------------------------------------------------
    const voltar = page.getByTestId("devolver-ao-automatico");
    await expect(voltar).toBeVisible();
    await voltar.click();

    await expect.poll(async () => silencioNoBanco(), { timeout: 30_000 }).toBe("(null)");
    await expect(comando).toContainText(/autom/i, { timeout: 30_000 });
    await expect(page.getByTestId("badge-atendimento-humano")).toHaveCount(0);
    await captura(page, "3-devolvido-ao-automatico");
  });

  test("a conversa que o automático escalou APARECE na Fila", async ({ page }) => {
    // ESTE CASO É A ÚLTIMA PONTA DA RECLAMAÇÃO Nº 1, e ela não era de tela.
    //
    // `performHumanHandoff` deixa a conversa em `status='pending'` sem dono, e a
    // definição de "fila" estava copiada em SEIS sítios que não concordavam: o
    // trigger de roteamento do banco enfileirava `pending` (por isso o rodízio a
    // atribuía), mas a aba, o badge e o painel do gerente pediam só `open`. A
    // conversa que mais precisa de uma pessoa era a única invisível.
    const escalada = await admin
      .from("conversations")
      .update({
        status: "pending",
        bot_silenced_until: "infinity",
        last_handoff_at: new Date().toISOString(),
        last_handoff_reason: "cliente pediu para falar com uma pessoa",
        assigned_to_user_id: null,
      })
      .eq("id", conversaId)
      .select("id, status")
      .maybeSingle();
    if (escalada.error) throw new Error(`escalar: ${escalada.error.message}`);
    expect((escalada.data as { status: string } | null)?.status).toBe("pending");

    await login(page, creds.users.agent!.email, creds.password);
    await page.goto("/app/inbox?filter=unassigned");

    // A conversa está na lista da Fila, pelo nome do contato.
    const naFila = page.getByText(NOME_DO_CONTATO, { exact: false }).first();
    await expect(naFila).toBeVisible({ timeout: 30_000 });
    await captura(page, "4-escalada-aparece-na-fila");

    // E o BADGE da aba a conta — badge que não bate com a lista manda o atendente
    // procurar um trabalho que a aba não mostra (ou o contrário, que é este caso).
    const abaFila = page.getByRole("tab", { name: /Fila/i }).first();
    await expect(abaFila).toContainText(/[1-9]/, { timeout: 30_000 });

    // Abrindo, a tela diz que ninguém está no comando — nem pessoa, nem automático.
    await naFila.click();
    await expect(page.getByTestId("comando-da-conversa")).toContainText(/sem respons/i, {
      timeout: 30_000,
    });
  });
});
