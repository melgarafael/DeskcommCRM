import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "@playwright/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

import { irParaASemanaSeguinte } from "./helpers/agenda-semana-integra";

/**
 * A OCUPAÇÃO QUE VEM DO GOOGLE APARECE NA GRADE — e continua lá depois do
 * refetch.
 *
 * ─── O defeito que esta spec fecha ───────────────────────────────────────────
 *
 * `app/app/agenda/page.tsx` SEMEAVA os eventos externos na primeira pintura, e
 * `app/app/agenda/_client.tsx` os descartava assim que o GET respondia
 * (`agendamentosVivos ?? semente`) — porque
 * `GET /api/v1/agenda/agendamentos` nunca devolveu ocupação. Em visão Mês nem a
 * semente sobrevivia: o recorte muda, `naJanelaDoServidor` vira falso e o
 * fallback é `[]`.
 *
 * Consequência para quem usa: o horário ficava BLOQUEADO (o motor de slots lê
 * `calendar_external_events`) e a grade mostrava o dia VAZIO. Duas telas do
 * mesmo produto discordando sobre o mesmo horário.
 *
 * ─── Por que a semana SEGUINTE, e não a de hoje ──────────────────────────────
 *
 * A semente do servidor cobre apenas a semana da âncora. Semeando na semana
 * seguinte, o ÚNICO caminho possível para o bloco chegar à tela é a rota — o
 * que torna o caso incapaz de passar por acidente. É também o que faz este
 * arquivo REPROVAR na `main` sem o PR: lá o bloco nunca aparece.
 *
 * ─── O que cada caso mede ────────────────────────────────────────────────────
 *
 *  1. o bloco é DESENHADO (geometria por `getBoundingClientRect`, não a olho),
 *     diz "Ocupado", não vaza o título do evento, e nasce inerte;
 *  2. ele SOBREVIVE ao refetch — ida e volta de semana, e visão Mês;
 *  3. o nosso agendamento, na mesma tela, continua clicável e arrastável.
 */

const RAIZ = path.resolve(__dirname, "../..");

/**
 * O título do evento no Google. Ele é SEGREDO por contrato: a agenda conectada é
 * pessoal e a tela da agenda é vista pela gestão. Se esta frase aparecer no DOM,
 * o produto vazou a consulta médica de alguém para o chefe.
 */
const TITULO_SIGILOSO = "Sessao de terapia QUARTA 15h consultorio";
const EMAIL_DA_CONTA = "agenda-pessoal-qa@gmail.com";

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string } | undefined>;
  agenda?: { tipo_id: string; tipo_nome: string; contato_id: string };
}

function lerCreds(): Creds {
  const p = path.join(RAIZ, ".e2e-creds.json");
  if (!fs.existsSync(p))
    throw new Error("`.e2e-creds.json` ausente — rode `scripts/seed-e2e-credentials.ts`");
  let c = JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
  if (!c.agenda) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-agenda.ts"], { stdio: "inherit", cwd: RAIZ });
    c = JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
  }
  if (!c.agenda) throw new Error("seed-e2e-agenda não gravou o bloco `agenda`");
  return c;
}

function admin() {
  const c = credenciaisSupabaseDeTeste();
  return createClient(c.url, c.serviceRole, { auth: { persistSession: false } });
}

async function entrar(page: Page, creds: Creds) {
  // `manager`, como as irmãs: o admin do seed tem desafio de MFA e esta spec não
  // é sobre login.
  const usuario = creds.users.manager;
  if (!usuario) throw new Error(".e2e-creds.json sem o usuário `manager`");
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(usuario.email);
  await page.getByLabel(/senha/i).fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
  await page.goto("/app/agenda");
  await expect(page.getByTestId("tela-agenda")).toBeVisible({ timeout: 25_000 });
}

/** A conexão do Google que o evento externo pendura. Idempotente. */
async function conexaoDoGoogle(orgId: string, userId: string): Promise<string> {
  const db = admin();
  const { data: existente } = await db
    .from("calendar_connections")
    .select("id")
    .eq("organization_id", orgId)
    .eq("user_id", userId)
    .eq("account_email", EMAIL_DA_CONTA)
    .maybeSingle();
  if (existente) return (existente as { id: string }).id;
  const { data, error } = await db
    .from("calendar_connections")
    .insert({
      organization_id: orgId,
      user_id: userId,
      provider: "google_calendar",
      account_email: EMAIL_DA_CONTA,
      status: "healthy",
    } as never)
    .select("id")
    .single();
  if (error) throw new Error(`calendar_connections: ${error.message}`);
  return (data as { id: string }).id;
}

/**
 * O instante ISO de `dia` às `hora` — calculado DENTRO do browser.
 *
 * A grade formata as colunas no fuso do BROWSER. Montar a data no Node daria um
 * dia diferente sempre que os dois relógios discordassem, e o bloco cairia na
 * coluna errada — que é indistinguível de "o bloco não apareceu".
 */
async function instanteNoDia(page: Page, dia: string, hora: number): Promise<string> {
  return page.evaluate(
    ([d, h]) => {
      const [ano, mes, diaDoMes] = (d as string).split("-").map(Number);
      return new Date(ano!, mes! - 1, diaDoMes!, h as number, 0, 0, 0).toISOString();
    },
    [dia, hora] as [string, number],
  );
}

test.describe("a ocupação do Google na grade da agenda", () => {
  test("é desenhada, diz apenas «Ocupado», e não vaza o título do evento", async ({ page }) => {
    const creds = lerCreds();
    const dono = creds.users.agent!;
    await entrar(page, creds);

    // 1ª passada: descobrir QUE dias a semana seguinte desenha.
    const dias = await irParaASemanaSeguinte(page);
    const alvo = dias[3]!; // quarta-feira da semana desenhada
    const comeca = await instanteNoDia(page, alvo, 15);
    const termina = await instanteNoDia(page, alvo, 16);

    const conexaoId = await conexaoDoGoogle(creds.org_id, dono.id);
    const db = admin();
    await db
      .from("calendar_external_events")
      .delete()
      .eq("organization_id", creds.org_id)
      .eq("external_event_id", "qa-visual-ocupacao");
    const { data: evento, error } = await db
      .from("calendar_external_events")
      .insert({
        organization_id: creds.org_id,
        connection_id: conexaoId,
        external_calendar_id: "primary",
        external_event_id: "qa-visual-ocupacao",
        title: TITULO_SIGILOSO,
        starts_at: comeca,
        ends_at: termina,
        status: "confirmed",
        transparency: "opaque",
      } as never)
      .select("id")
      .single();
    if (error) throw new Error(`calendar_external_events: ${error.message}`);
    const eventoId = (evento as { id: string }).id;

    // 2ª passada: RECARREGA e navega de novo. Depois disto a semente do servidor
    // não cobre mais a semana em tela — o que estiver desenhado veio da rota.
    await page.reload();
    await expect(page.getByTestId("tela-agenda")).toBeVisible({ timeout: 25_000 });
    const diasDepois = await irParaASemanaSeguinte(page);
    expect(diasDepois, "a semana desenhada mudou entre as duas passadas").toContain(alvo);

    const bloco = page.getByTestId(`agendamento-${eventoId}`);
    await expect(
      bloco,
      "a ocupação vinda do Google não foi desenhada na grade depois do refetch",
    ).toBeVisible({ timeout: 20_000 });

    // ── GEOMETRIA POR FERRAMENTA ──────────────────────────────────────────────
    const caixa = await bloco.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height, top: r.top };
    });
    expect(caixa.w, "o bloco tem largura zero — está no DOM e não na tela").toBeGreaterThan(20);
    // 1h de evento × 48px/hora, menos os 2px de respiro.
    expect(caixa.h, "a altura do bloco não corresponde a uma hora de grade").toBeGreaterThan(40);

    // ── O RÓTULO, E O SEGREDO ────────────────────────────────────────────────
    await expect(bloco).toContainText(/ocupado/i);
    await expect(bloco).toHaveAttribute("data-origem", "google_sync");
    expect(
      await page.content(),
      "o título do evento do Google VAZOU para o DOM da tela de trabalho",
    ).not.toContain(TITULO_SIGILOSO);
    const rotulo = (await bloco.getAttribute("aria-label")) ?? "";
    expect(rotulo, "o rótulo acessível não avisa que a origem é o Google").toMatch(
      /ocupado na agenda do google/i,
    );
    expect(rotulo, "o rótulo acessível carrega o título do evento").not.toContain(TITULO_SIGILOSO);

    // ── NÃO ABRE, NÃO ARRASTA ────────────────────────────────────────────────
    await expect(bloco, "o bloco do Google aceita clique").toBeDisabled();
    await expect(bloco).toHaveAttribute("data-arrastavel", "false");

    await page.screenshot({
      path: path.join(RAIZ, ".superpowers/evidence/agenda-ocupacao-google-desenhada.png"),
      fullPage: false,
    });
  });

  test("sobrevive à troca de semana e à visão Mês", async ({ page }) => {
    const creds = lerCreds();
    const dono = creds.users.agent!;
    await entrar(page, creds);

    const dias = await irParaASemanaSeguinte(page);
    const alvo = dias[3]!;
    const comeca = await instanteNoDia(page, alvo, 15);
    const termina = await instanteNoDia(page, alvo, 16);
    const conexaoId = await conexaoDoGoogle(creds.org_id, dono.id);
    const db = admin();
    await db
      .from("calendar_external_events")
      .delete()
      .eq("organization_id", creds.org_id)
      .eq("external_event_id", "qa-visual-ocupacao");
    const { data: evento, error } = await db
      .from("calendar_external_events")
      .insert({
        organization_id: creds.org_id,
        connection_id: conexaoId,
        external_calendar_id: "primary",
        external_event_id: "qa-visual-ocupacao",
        title: TITULO_SIGILOSO,
        starts_at: comeca,
        ends_at: termina,
        status: "confirmed",
        transparency: "opaque",
      } as never)
      .select("id")
      .single();
    if (error) throw new Error(`calendar_external_events: ${error.message}`);
    const eventoId = (evento as { id: string }).id;

    await page.reload();
    await expect(page.getByTestId("tela-agenda")).toBeVisible({ timeout: 25_000 });
    await irParaASemanaSeguinte(page);
    await expect(page.getByTestId(`agendamento-${eventoId}`)).toBeVisible({ timeout: 20_000 });

    // Vai para a semana +2 e VOLTA. O `useAgendamentos` refaz a busca a cada
    // troca de recorte — é exatamente aqui que a semente do servidor morria.
    await page.getByTestId("periodo-seguinte").click();
    await expect(page.getByTestId(`agendamento-${eventoId}`)).toHaveCount(0, { timeout: 15_000 });
    await page.getByTestId("periodo-anterior").click();
    await expect(
      page.getByTestId(`agendamento-${eventoId}`),
      "o bloco do Google sumiu ao voltar para a semana dele — o refetch o apagou",
    ).toBeVisible({ timeout: 20_000 });

    // Visão MÊS: outro recorte, outra busca. Aqui nem a semente do servidor
    // chegava, porque `naJanelaDoServidor` vira falso.
    await page.getByTestId("visao-mes").click();
    await expect(
      page.getByTestId(`chip-mes-${eventoId}`),
      "a ocupação do Google não aparece na visão Mês",
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId(`chip-mes-${eventoId}`)).toContainText(/ocupado/i);
    expect(
      await page.content(),
      "o título do evento do Google VAZOU na visão Mês",
    ).not.toContain(TITULO_SIGILOSO);

    await page.screenshot({
      path: path.join(RAIZ, ".superpowers/evidence/agenda-ocupacao-google-mes.png"),
      fullPage: false,
    });
  });

  test("não estraga o nosso agendamento, que continua vivo na mesma tela", async ({ page }) => {
    const creds = lerCreds();
    const dono = creds.users.agent!;
    await entrar(page, creds);

    const dias = await irParaASemanaSeguinte(page);
    const alvo = dias[3]!;
    const db = admin();
    const conexaoId = await conexaoDoGoogle(creds.org_id, dono.id);

    await db
      .from("calendar_external_events")
      .delete()
      .eq("organization_id", creds.org_id)
      .eq("external_event_id", "qa-visual-ocupacao");
    const { data: evento } = await db
      .from("calendar_external_events")
      .insert({
        organization_id: creds.org_id,
        connection_id: conexaoId,
        external_calendar_id: "primary",
        external_event_id: "qa-visual-ocupacao",
        title: TITULO_SIGILOSO,
        starts_at: await instanteNoDia(page, alvo, 15),
        ends_at: await instanteNoDia(page, alvo, 16),
        status: "confirmed",
        transparency: "opaque",
      } as never)
      .select("id")
      .single();
    const eventoId = (evento as { id: string }).id;

    await db
      .from("calendar_appointments")
      .delete()
      .eq("organization_id", creds.org_id)
      .eq("title", "Compromisso nosso QA");
    const { data: nosso, error: erroNosso } = await db
      .from("calendar_appointments")
      .insert({
        organization_id: creds.org_id,
        event_type_id: creds.agenda!.tipo_id,
        title: "Compromisso nosso QA",
        starts_at: await instanteNoDia(page, alvo, 10),
        ends_at: await instanteNoDia(page, alvo, 11),
        time_zone: "America/Sao_Paulo",
        status: "confirmed",
        owner_user_id: dono.id,
        contact_id: creds.agenda!.contato_id,
      } as never)
      .select("id")
      .single();
    if (erroNosso) throw new Error(`calendar_appointments: ${erroNosso.message}`);
    const nossoId = (nosso as { id: string }).id;

    await page.reload();
    await expect(page.getByTestId("tela-agenda")).toBeVisible({ timeout: 25_000 });
    await irParaASemanaSeguinte(page);

    const doGoogle = page.getByTestId(`agendamento-${eventoId}`);
    const meu = page.getByTestId(`agendamento-${nossoId}`);
    await expect(doGoogle).toBeVisible({ timeout: 20_000 });
    await expect(meu, "o nosso agendamento sumiu da grade").toBeVisible({ timeout: 20_000 });

    // O CONTRASTE, na mesma tela e no mesmo instante.
    await expect(doGoogle).toBeDisabled();
    await expect(meu, "o nosso agendamento nasceu inerte junto com o do Google").toBeEnabled();
    await expect(meu).toHaveAttribute("data-origem", "ui");
    await expect(
      meu,
      "o nosso agendamento perdeu o arraste — a origem contaminou o que era nosso",
    ).toHaveAttribute("data-arrastavel", "true");
    await expect(doGoogle).toHaveAttribute("data-arrastavel", "false");
    await expect(meu).toContainText(/compromisso nosso qa/i);

    await page.screenshot({
      path: path.join(RAIZ, ".superpowers/evidence/agenda-nosso-x-google.png"),
      fullPage: false,
    });
  });
});
