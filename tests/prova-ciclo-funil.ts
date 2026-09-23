/**
 * A CORRENTE INTEIRA, num único processo: o dono do negócio escolhe a etapa
 * NA TELA e, depois disso, o agente move o card para a etapa que ELE escolheu.
 *
 * ⚠️ Por que este script existe se a Task 2 já provou a rota e a Task 3 já provou
 * a tela: as duas mediram METADES. A rota provou que o `PUT` grava; a tela provou
 * que o clique chega à rota. Ninguém tinha exercitado a única propriedade que dá
 * sentido à feature — a configuração do usuário CHEGA AO COMPORTAMENTO DO AGENTE.
 * Aqui os dois lados se tocam: o destino é escolhido pelo NOME visível na tela e
 * conferido pelo `stage_id` que o card assume depois que a ponte roda.
 *
 * ⚠️ A ponte chamada é `mirrorLeadStageToCrm` — a MESMA função que o turno chama
 * (`inbound-turn.ts`), não o motor por baixo dela. Chamar `sincronizaEstagioDoAgente`
 * direto passaria com a ponte desligada.
 *
 * Antes: o passo «Qualificado» não tem etapa nenhuma no funil da clínica, e a
 * ponte responde `not_configured`. Depois do clique na tela, o mesmo passo move
 * o card. O estado do tenant é restaurado PELA PRÓPRIA TELA no fim.
 *
 * Uso: `npx tsx --env-file=.env.local tests/prova-ciclo-funil.ts`
 * (app de produção em http://localhost:3000, build do HEAD).
 */
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";

import { chromium, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { mirrorLeadStageToCrm } from "@/lib/agent-engine/edge/crm/move-lead-stage";
import { carregarEnvLocal } from "../scripts/lib/env-de-teste";

const env = carregarEnvLocal();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});
const creds = JSON.parse(fs.readFileSync(".e2e-creds.json", "utf8")) as {
  password: string;
  users: Record<string, { email: string }>;
};

const APP = "http://localhost:3000";
const ORG = "6e567068-fd1c-4f94-ae1f-40e0334be190";
const CLINICA = "35bf4ac9-c5e0-4f7d-846a-99b1bcc92d69";
/** O passo que hoje não tem destino — é o que a tela vai passar a mapear. */
const PASSO = "qualified" as const;
const ROTULO = "Qualificado";

interface Etapa {
  id: string;
  name: string;
  is_won: boolean;
  is_lost: boolean;
  agent_stage_hint: string | null;
}

async function etapas(): Promise<Etapa[]> {
  const { data } = await admin
    .from("crm_stages")
    .select("id, name, is_won, is_lost, agent_stage_hint")
    .eq("pipeline_id", CLINICA)
    .order("position");
  return (data ?? []) as Etapa[];
}

async function contagens(): Promise<Record<string, number>> {
  const conta = async (tabela: string) => {
    const { count } = await admin
      .from(tabela)
      .select("id", { count: "exact", head: true })
      .eq("organization_id", ORG);
    return count ?? -1;
  };
  return {
    contacts: await conta("contacts"),
    crm_leads: await conta("crm_leads"),
    crm_lead_activities: await conta("crm_lead_activities"),
  };
}

/** O mapa como a tela o mostra: passo → nome da etapa. */
function mapaLegivel(lista: Etapa[]): Record<string, string> {
  return Object.fromEntries(
    lista.filter((e) => e.agent_stage_hint).map((e) => [e.agent_stage_hint!, e.name]),
  );
}

async function login(page: Page): Promise<void> {
  await page.goto(`${APP}/login`);
  await page.locator("#email").fill(creds.users.manager!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\//);
}

/**
 * O clique de verdade: abre a lista do passo e escolhe pelo NOME VISÍVEL. Nada
 * aqui conhece `stage_id` — é exatamente o que o dono da clínica tem à mão.
 */
async function escolherNaTela(page: Page, nomeDaEtapa: string): Promise<void> {
  await page.goto(`${APP}/app/settings/tenant/pipelines`);
  const secao = page.locator(`[data-testid="mapeamento-${CLINICA}"]`);
  await secao.locator(`[data-testid="etapa-${PASSO}"]`).waitFor({ state: "visible" });
  await secao.locator(`[data-testid="etapa-${PASSO}"]`).click();
  await page.getByRole("option", { name: nomeDaEtapa, exact: true }).click();
  await secao.locator('[data-testid="salvar-mapeamento"]').click();
  await page.getByText("Escolhas salvas.").waitFor({ state: "visible", timeout: 15_000 });
}

async function main(): Promise<void> {
  const antes = await etapas();
  const contagensAntes = await contagens();
  const alvo = antes.find((e) => !e.agent_stage_hint && !e.is_won && !e.is_lost);
  if (!alvo) throw new Error("o funil não tem etapa livre — a prova precisa de uma");
  if (antes.some((e) => e.agent_stage_hint === PASSO)) {
    throw new Error(`«${ROTULO}» já tem etapa; a prova depende de partir de "não mover"`);
  }
  console.info("MAPA ANTES:", mapaLegivel(antes));
  console.info(`ETAPA ESCOLHIDA NA TELA: «${alvo.name}» para o passo «${ROTULO}»`);

  // ---- o MESMO card e a MESMA chamada, com e sem a escolha do usuário ----
  // Uma variável só muda entre as duas medições: o clique na tela. Sem o
  // controle negativo, «o card foi para Negociação» seria compatível com um
  // mapeamento que já existisse por outro caminho.
  const contactId = randomUUID();
  await admin
    .from("contacts")
    .insert({ id: contactId, organization_id: ORG, name: "prova ciclo funil" });
  const leadId = randomUUID();
  const primeiro = antes[0]!;
  await admin.from("crm_leads").insert({
    id: leadId,
    organization_id: ORG,
    pipeline_id: CLINICA,
    stage_id: primeiro.id,
    contact_id: contactId,
    title: "prova ciclo funil",
    position_in_stage: 1,
  });

  // `leadId` do engine = contact_id do CRM (o funil do agente é por contato).
  const ponte = () =>
    mirrorLeadStageToCrm({} as never, { supabase: admin }, {
      tenantId: ORG,
      leadId: contactId,
      toStage: PASSO,
    });
  const ondeEsta = async (lista: Etapa[]) => {
    const { data } = await admin.from("crm_leads").select("stage_id").eq("id", leadId).maybeSingle();
    return lista.find((e) => e.id === (data as { stage_id: string }).stage_id)!;
  };

  const controle = await ponte();
  const posControle = await ondeEsta(antes);
  console.info(`\nCONTROLE (antes de qualquer clique): ${JSON.stringify(controle)}`);
  console.info(`CARD: continua em «${posControle.name}»`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await login(page);
  await escolherNaTela(page, alvo.name);
  await page.screenshot({ path: ".superpowers/evidence/ciclo-funil-tela.png", fullPage: true });

  const depoisDoClique = await etapas();
  const gravada = depoisDoClique.find((e) => e.agent_stage_hint === PASSO);
  console.info(
    `\nBANCO DEPOIS DO CLIQUE: «${ROTULO}» → ${gravada ? `«${gravada.name}»` : "nenhuma etapa"}`,
  );
  if (gravada?.id !== alvo.id) throw new Error("a tela não gravou a etapa escolhida");

  const r = await ponte();
  const onde = await ondeEsta(depoisDoClique);
  console.info(`PONTE (mirrorLeadStageToCrm, passo "${PASSO}"): ${JSON.stringify(r)}`);
  console.info(`CARD: «${primeiro.name}» → «${onde.name}»`);
  const { data: ativ } = await admin
    .from("crm_lead_activities")
    .select("type, reason, actor_kind")
    .eq("lead_id", leadId)
    .maybeSingle();
  if (ativ) {
    const a = ativ as { type: string; reason: string; actor_kind: string };
    console.info(`TIMELINE: ${a.type} · ${a.reason} · ator=${a.actor_kind}`);
  }

  // O controle precisa ter RECUSADO por falta de mapeamento: se ele tivesse
  // movido, o "depois" não estaria medindo o clique.
  const controleMudo =
    !controle.ok && controle.reason === "not_configured" && posControle.id === primeiro.id;
  const fechou = controleMudo && r.ok && onde.id === alvo.id;
  console.info(
    fechou
      ? `\n✅ CICLO FECHADO: mesma chamada, mesmo card — sem a escolha na tela o agente recusou (${controle.ok ? "?" : controle.reason}); com ela o card foi para «${onde.name}», a etapa escolhida.`
      : `\n❌ CICLO ABERTO: controle=${JSON.stringify(controle)} · card em «${onde.name}», esperado «${alvo.name}».`,
  );

  // ---- limpeza: o tenant volta ao estado anterior, e pela PRÓPRIA TELA ----
  await admin.from("crm_lead_activities").delete().eq("lead_id", leadId);
  await admin.from("crm_leads").delete().eq("id", leadId);
  await admin.from("contacts").delete().eq("id", contactId);
  await escolherNaTela(page, "Não mover o card");
  await browser.close();

  const depois = await etapas();
  const contagensDepois = await contagens();
  console.info("MAPA DEPOIS DA RESTAURAÇÃO:", mapaLegivel(depois));
  console.info("CONTAGENS antes:", contagensAntes, "depois:", contagensDepois);
  const mapaIgual = JSON.stringify(mapaLegivel(antes)) === JSON.stringify(mapaLegivel(depois));
  const contagemIgual = JSON.stringify(contagensAntes) === JSON.stringify(contagensDepois);
  console.info(`ESTADO RESTAURADO: mapa ${mapaIgual ? "igual" : "DIFERENTE"} · contagens ${contagemIgual ? "iguais" : "DIFERENTES"}`);
  if (!fechou || !mapaIgual || !contagemIgual) process.exitCode = 1;
}

void main();
