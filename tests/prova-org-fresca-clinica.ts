/**
 * A RAZÃO DA FEATURE EXISTIR, provada de ponta a ponta numa organização que
 * acabou de nascer.
 *
 * Toda organização criada neste produto recebe, do gatilho
 * `trg_seed_default_pipeline_for_org`, um funil de E-COMMERCE: "Carrinho
 * abandonado", "Aguardando pagamento", "Pago", "Em separacao"… Uma clínica que
 * instalou hoje herda esse vocabulário e, até esta feature, não tinha nenhuma
 * tela para corrigi-lo. Este script vai do banco cru até o agente movendo o card:
 *
 *   1. cria a organização (o gatilho semeia o funil de e-commerce);
 *   2. o dono da clínica RENOMEIA as oito etapas PELA TELA;
 *   3. MARCA pela tela qual delas é o fechamento (a marcação sai de «Pago»);
 *   4. CONTROLE — a ponte do agente ainda recusa, por falta de mapeamento;
 *   5. MAPEIA pela tela os passos do agente nas etapas que ele nomeou;
 *   6. a ponte move o card para a etapa com o NOME QUE ELE DIGITOU;
 *   7. a organização é apagada e as contagens voltam ao que eram.
 *
 * ⚠️ O CAMINHO DE CADA AFIRMAÇÃO, declarado, porque os dois não são a mesma coisa:
 *   • passos 2, 3 e 5 passam por HTTP, no navegador, com sessão de usuário real
 *     (login por senha como MANAGER) — é o clique, não a rota chamada por fora;
 *   • passos 4 e 6 chamam `mirrorLeadStageToCrm`, a MESMA função que o turno
 *     chama em `inbound-turn.ts:1200`, no processo deste script, com o client
 *     Supabase real. NÃO é um turno de IA completo: nenhum modelo é chamado aqui.
 *     Chamar `sincronizaEstagioDoAgente` direto passaria com a ponte desligada —
 *     por isso a ponte é o ponto de entrada.
 *   • a criação da organização é um INSERT em `organizations` com o service role,
 *     o mesmo que `scripts/bootstrap-owner.ts` — e que o bootstrap equivalente
 *     dentro do próprio `install.sh`, que não chama o script — faz.
 *     Quem semeia é o GATILHO do banco, então qualquer caminho de criação passa
 *     por ele.
 *
 * ⚠️ ESCREVE EM BANCO COMPARTILHADO, mas só dentro da organização que ele mesmo
 * cria. O `finally` apaga a organização e o usuário e confere as contagens
 * globais antes/depois.
 *
 * Uso: `npx tsx --env-file=.env.local tests/prova-org-fresca-clinica.ts`
 * (app de produção em http://localhost:3000, build do HEAD).
 */
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";

import { chromium, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { mirrorLeadStageToCrm } from "@/lib/agent-engine/edge/crm/move-lead-stage";

const env = Object.fromEntries(
  fs
    .readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")]),
);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

/** O servidor sob prova. `PROVA_APP` permite apontar para um `next start` recém-buildado do HEAD. */
const APP = process.env.PROVA_APP ?? "http://localhost:3000";
const EVID = ".superpowers/evidence";
const SENHA = "Clinica!Prova1234";

/** O que o gatilho semeia, na ordem. É o fato que motiva a feature inteira. */
const SEMEADO = [
  "Carrinho abandonado",
  "Aguardando pagamento",
  "Pago",
  "Em separacao",
  "Enviado",
  "Entregue",
  "Pos-venda",
  "Cancelado",
];

/** O vocabulário de uma clínica, na mesma ordem — é o que o dono vai digitar. */
const CLINICA = [
  "Primeiro contato",
  "Avaliação",
  "Orçamento enviado",
  "Agendado",
  "Em tratamento",
  "Tratamento concluído",
  "Retorno",
  "Desistiu",
];

/** A etapa que o dono marca como fechamento — NÃO é a que nasceu marcada. */
const FECHAMENTO = "Tratamento concluído";
/** Onde o agente coloca o card no passo «Qualificado». */
const DESTINO_QUALIFICADO = "Avaliação";

interface Etapa {
  id: string;
  name: string;
  slug: string;
  position: number;
  is_won: boolean;
  is_lost: boolean;
  is_archived: boolean;
  agent_stage_hint: string | null;
}

let passos = 0;
let falhas = 0;
function ok(rotulo: string, condicao: boolean, detalhe = ""): void {
  passos++;
  if (!condicao) falhas++;
  console.info(`${condicao ? "  OK  " : " FALHA"} ${rotulo}${detalhe ? ` — ${detalhe}` : ""}`);
}

async function contagens(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of ["organizations", "crm_pipelines", "crm_stages", "crm_leads", "contacts"]) {
    const { count } = await admin.from(t).select("id", { count: "exact", head: true });
    out[t] = count ?? -1;
  }
  return out;
}

async function etapas(pipelineId: string): Promise<Etapa[]> {
  const { data } = await admin
    .from("crm_stages")
    .select("id, name, slug, position, is_won, is_lost, is_archived, agent_stage_hint")
    .eq("pipeline_id", pipelineId)
    .order("position");
  return (data ?? []) as Etapa[];
}

async function login(page: Page, email: string): Promise<void> {
  await page.goto(`${APP}/login`);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(SENHA);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 30_000 });
}

async function main(): Promise<void> {
  const antes = await contagens();
  console.info(`contagens antes: ${JSON.stringify(antes)}\n`);

  const orgId = randomUUID();
  const sufixo = orgId.slice(0, 8);
  const email = `clinica-prova-${sufixo}@deskcomm.test`;
  let userId: string | null = null;
  const browser = await chromium.launch();

  try {
    // ---- 1. a organização nasce. O GATILHO semeia o funil de e-commerce ----
    const { error: eOrg } = await admin.from("organizations").insert({
      id: orgId,
      slug: `clinica-prova-${sufixo}`,
      display_name: "Clínica Prova (org fresca)",
      legal_name: "Clínica Prova (org fresca)",
      timezone: "America/Sao_Paulo",
      locale: "pt-BR",
      // A tela de funis não é onboarding; sem isto o app manda o usuário para o
      // fluxo de primeiros passos, que não é o que está sendo provado aqui.
      onboarded_at: new Date().toISOString(),
    } as never);
    if (eOrg) throw new Error(`criar org: ${eOrg.message}`);

    const { data: pipes } = await admin
      .from("crm_pipelines")
      .select("id, name")
      .eq("organization_id", orgId);
    ok("o gatilho criou exatamente 1 funil", (pipes ?? []).length === 1, JSON.stringify(pipes));
    const pipelineId = (pipes as { id: string; name: string }[])[0]!.id;
    ok("e ele se chama «Pedidos»", (pipes as { name: string }[])[0]!.name === "Pedidos");

    const semeadas = await etapas(pipelineId);
    ok(
      "as 8 etapas semeadas têm vocabulário de E-COMMERCE",
      JSON.stringify(semeadas.map((e) => e.name)) === JSON.stringify(SEMEADO),
      semeadas.map((e) => e.name).join(" · "),
    );
    ok(
      "a etapa de fechamento que veio de fábrica é «Pago»",
      semeadas.filter((e) => e.is_won).map((e) => e.name).join() === "Pago",
    );
    ok(
      "NENHUMA etapa semeada tem passo do assistente (agent_stage_hint)",
      semeadas.every((e) => e.agent_stage_hint === null),
    );

    // ---- 2. o dono da clínica: usuário manager de verdade ----
    const { data: u, error: eU } = await admin.auth.admin.createUser({
      email,
      password: SENHA,
      email_confirm: true,
      user_metadata: { full_name: "Dona da Clínica" },
    });
    if (eU || !u?.user) throw new Error(`criar usuário: ${eU?.message}`);
    userId = u.user.id;
    const { error: eM } = await admin.from("user_organizations").insert({
      user_id: userId,
      organization_id: orgId,
      role: "manager",
      accepted_at: new Date().toISOString(),
    } as never);
    if (eM) throw new Error(`membership: ${eM.message}`);

    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await login(page, email);
    await page.goto(`${APP}/app/settings/tenant/pipelines`);
    const secaoEtapas = page.locator(`[data-testid="etapas-${pipelineId}"]`);
    await secaoEtapas.waitFor({ state: "visible", timeout: 30_000 });
    await page.screenshot({ path: `${EVID}/org-fresca-1-ecommerce.png`, fullPage: true });

    // ---- 3. RENOMEAR as oito etapas PELA TELA ----
    //
    // ⚠️ O DETECTOR É O BANCO, e a primeira versão deste script errou aqui: ela
    // esperava o `value` do próprio campo virar o nome novo, o que o `fill()`
    // já satisfaz ANTES de qualquer ida ao servidor. Sete renomeações passaram
    // por sorte (a iteração seguinte dava tempo do PATCH voltar) e a oitava —
    // a última, sem ninguém depois dela — reprovou. O instrumento media o
    // rascunho local, não a gravação.
    for (let i = 0; i < semeadas.length; i++) {
      const campo = page.getByTestId(`nome-${semeadas[i]!.id}`);
      await campo.fill(CLINICA[i]!);
      await campo.blur();
      const limite = Date.now() + 15_000;
      let gravado = false;
      while (Date.now() < limite && !gravado) {
        const { data } = await admin
          .from("crm_stages")
          .select("name")
          .eq("id", semeadas[i]!.id)
          .maybeSingle();
        gravado = (data as { name: string } | null)?.name === CLINICA[i]!;
        if (!gravado) await page.waitForTimeout(300);
      }
      if (!gravado) {
        const erro = page.getByTestId(`etapa-erro-${semeadas[i]!.id}`);
        const texto = (await erro.isVisible().catch(() => false))
          ? await erro.innerText()
          : "(a tela não mostrou erro)";
        console.info(`  ...«${semeadas[i]!.name}» → «${CLINICA[i]!}» não gravou: ${texto}`);
      }
    }
    const renomeadas = await etapas(pipelineId);
    ok(
      "as 8 etapas foram renomeadas para o vocabulário da clínica PELA TELA",
      JSON.stringify(renomeadas.map((e) => e.name)) === JSON.stringify(CLINICA),
      renomeadas.map((e) => e.name).join(" · "),
    );
    ok(
      "renomear NÃO mexeu no slug (a identidade da coluna é estável)",
      JSON.stringify(renomeadas.map((e) => e.slug)) ===
        JSON.stringify(semeadas.map((e) => e.slug)),
    );

    // ---- 4. MARCAR o fechamento PELA TELA (a marcação sai de «Pago») ----
    const novoFechamento = renomeadas.find((e) => e.name === FECHAMENTO)!;
    const fechamentoDeFabrica = renomeadas.find((e) => e.is_won)!;
    ok(
      "antes do clique, o fechamento ainda é a etapa que nasceu marcada",
      fechamentoDeFabrica.slug === "pago" && novoFechamento.is_won === false,
      `«${fechamentoDeFabrica.name}» (slug ${fechamentoDeFabrica.slug})`,
    );
    await page.getByTestId(`papel-${novoFechamento.id}`).click();
    await page.getByRole("option", { name: "Aqui o cliente fecha" }).click();
    const confirmacao = page.getByTestId(`confirmar-papel-${novoFechamento.id}`);
    if (await confirmacao.isVisible().catch(() => false)) {
      await page.getByTestId(`confirmar-papel-sim-${novoFechamento.id}`).click();
    }
    await page.waitForTimeout(1500);
    const comFechamento = await etapas(pipelineId);
    const ganho = comFechamento.filter((e) => e.is_won);
    ok(
      `o fechamento passou a ser «${FECHAMENTO}», e só ele`,
      ganho.length === 1 && ganho[0]!.id === novoFechamento.id,
      ganho.map((e) => e.name).join() || "nenhuma",
    );
    await page.screenshot({ path: `${EVID}/org-fresca-2-clinica.png`, fullPage: true });

    // ---- 5. um negócio de verdade, parado na primeira etapa ----
    const contactId = randomUUID();
    await admin
      .from("contacts")
      .insert({ id: contactId, organization_id: orgId, name: "Paciente da prova" } as never);
    const leadId = randomUUID();
    const primeira = comFechamento[0]!;
    await admin.from("crm_leads").insert({
      id: leadId,
      organization_id: orgId,
      pipeline_id: pipelineId,
      stage_id: primeira.id,
      contact_id: contactId,
      title: "Consulta da prova",
      position_in_stage: 1,
    } as never);

    /** A ponte que o turno chama (`inbound-turn.ts`), com o client real. */
    const ponte = (passo: "qualified" | "won") =>
      mirrorLeadStageToCrm({} as never, { supabase: admin } as never, {
        // O funil do agente é por CONTATO: `leadId` aqui é o contact_id do CRM.
        tenantId: orgId,
        leadId: contactId,
        toStage: passo,
      });
    const ondeEstaOCard = async (lista: Etapa[]) => {
      const { data } = await admin
        .from("crm_leads")
        .select("stage_id")
        .eq("id", leadId)
        .maybeSingle();
      return lista.find((e) => e.id === (data as { stage_id: string }).stage_id)!;
    };

    // ---- 6. CONTROLE: sem mapeamento, o agente NÃO move (e diz por quê) ----
    const cQual = await ponte("qualified");
    const cWon = await ponte("won");
    const cardNoControle = await ondeEstaOCard(comFechamento);
    ok(
      "CONTROLE «Qualificado»: a ponte recusa por falta de mapeamento",
      !cQual.ok && cQual.reason === "not_configured",
      JSON.stringify(cQual),
    );
    ok(
      "CONTROLE «Ganho»: a ponte recusa por falta de mapeamento",
      !cWon.ok && cWon.reason === "not_configured",
      JSON.stringify(cWon),
    );
    ok(
      "CONTROLE: o card não saiu do lugar",
      cardNoControle.id === primeira.id,
      `«${cardNoControle.name}»`,
    );

    // ---- 7. MAPEAR os passos PELA TELA, escolhendo pelo NOME visível ----
    const secaoMap = page.locator(`[data-testid="mapeamento-${pipelineId}"]`);
    await secaoMap.locator('[data-testid="etapa-qualified"]').waitFor({ state: "visible" });
    await secaoMap.locator('[data-testid="etapa-qualified"]').click();
    await page.getByRole("option", { name: DESTINO_QUALIFICADO, exact: true }).click();
    await secaoMap.locator('[data-testid="etapa-won"]').click();
    await page.getByRole("option", { name: FECHAMENTO, exact: true }).click();
    await secaoMap.locator('[data-testid="salvar-mapeamento"]').click();
    await page.getByText("Escolhas salvas.").waitFor({ state: "visible", timeout: 20_000 });
    await page.screenshot({ path: `${EVID}/org-fresca-3-mapeado.png`, fullPage: true });

    const mapeadas = await etapas(pipelineId);
    const porHint = (h: string) => mapeadas.find((e) => e.agent_stage_hint === h);
    ok(
      `«Qualificado» ficou gravado em «${DESTINO_QUALIFICADO}»`,
      porHint("qualified")?.name === DESTINO_QUALIFICADO,
      porHint("qualified")?.name ?? "nenhuma",
    );
    ok(
      `«Ganho» ficou gravado em «${FECHAMENTO}»`,
      porHint("won")?.name === FECHAMENTO,
      porHint("won")?.name ?? "nenhuma",
    );

    // ---- 8. A MESMA CHAMADA, agora movendo — para o nome que ele digitou ----
    const rQual = await ponte("qualified");
    const depoisQual = await ondeEstaOCard(mapeadas);
    ok(
      `a ponte move o card para «${DESTINO_QUALIFICADO}» — nome digitado na tela`,
      rQual.ok && depoisQual.name === DESTINO_QUALIFICADO,
      `${JSON.stringify(rQual)} · card em «${depoisQual.name}»`,
    );

    const rWon = await ponte("won");
    const depoisWon = await ondeEstaOCard(mapeadas);
    ok(
      `a ponte move o card para «${FECHAMENTO}» — etapa marcada na tela`,
      rWon.ok && depoisWon.name === FECHAMENTO,
      `${JSON.stringify(rWon)} · card em «${depoisWon.name}»`,
    );
    ok(
      "nenhuma dessas etapas existia no funil de e-commerce que veio de fábrica",
      !SEMEADO.includes(DESTINO_QUALIFICADO) && !SEMEADO.includes(FECHAMENTO),
    );

    // A timeline usa a MESMA gramática do arrasto humano de propósito
    // (`agent-stage-sync.ts`: "quem moveu está no ATOR"), e o passo do agente
    // vive no payload. Medir "o texto cita o assistente" reprovaria uma decisão
    // de produto deliberada em vez de medir o rastro.
    const { data: ativs } = await admin
      .from("crm_lead_activities")
      .select("type, reason, actor_kind, payload")
      .eq("lead_id", leadId)
      .order("created_at");
    const linhas = (ativs ?? []) as {
      type: string;
      reason: string;
      actor_kind: string;
      payload: { passo_do_agente?: string } | null;
    }[];
    console.info(`\nTIMELINE do negócio (${linhas.length} linhas):`);
    for (const a of linhas)
      console.info(
        `  · ${a.type} · ator=${a.actor_kind} · ${a.reason} · passo=${a.payload?.passo_do_agente}`,
      );
    ok(
      "as duas mudanças deixaram rastro nomeando as etapas do TENANT e o passo do agente",
      linhas.length === 2 &&
        linhas.every((a) => a.type === "stage_changed") &&
        linhas[0]!.reason.includes(DESTINO_QUALIFICADO) &&
        linhas[0]!.payload?.passo_do_agente === "qualified" &&
        linhas[1]!.reason.includes(FECHAMENTO) &&
        linhas[1]!.payload?.passo_do_agente === "won",
      linhas.map((a) => `${a.reason} [${a.payload?.passo_do_agente}]`).join(" | "),
    );

    await page.goto(`${APP}/app/settings/tenant/pipelines`);
    await secaoEtapas.waitFor({ state: "visible", timeout: 30_000 });
    await page.screenshot({ path: `${EVID}/org-fresca-4-final.png`, fullPage: true });
  } finally {
    await browser.close();
    // ---- 9. a organização de teste some, e as contagens voltam ----
    await admin.from("organizations").delete().eq("id", orgId);
    if (userId) await admin.auth.admin.deleteUser(userId);
    const depois = await contagens();
    console.info(`\ncontagens depois: ${JSON.stringify(depois)}`);
    ok(
      "a organização de teste foi apagada e TODAS as contagens voltaram ao valor de antes",
      JSON.stringify(antes) === JSON.stringify(depois),
      `antes ${JSON.stringify(antes)} · depois ${JSON.stringify(depois)}`,
    );
  }

  console.info(`\n${falhas === 0 ? "✅" : "❌"} ${passos - falhas}/${passos}`);
  if (falhas > 0) process.exitCode = 1;
}

void main();
