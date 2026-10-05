import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Caixa de seleção cuja lista vem de dado — `.map(` dentro do menu — cresce
 * com o uso: modelos de IA, atendentes, etapas, credenciais. Sem busca, ela
 * obriga a pessoa a procurar no olho (a reclamação que deu origem a isto foi a
 * lista de modelos do agente). O caminho é `SearchableSelect`, em
 * `components/ui/searchable-select.tsx`, que só mostra a busca a partir de
 * `MINIMO_PARA_BUSCA` opções — migrar lista curta não custa nada.
 *
 * `AINDA_SEM_BUSCA` é o que falta migrar, por arquivo. Esta lista SÓ ENCOLHE:
 * o número de um arquivo pode descer, nunca subir, e arquivo novo não entra.
 * Quem migra uma caixa baixa o número (ou apaga a linha quando chega a zero).
 * Plano: docs/superpowers/plans/2026-10-03-caixas-de-selecao-com-busca.md
 */
const AINDA_SEM_BUSCA: Record<string, number> = {
  "app/admin/(protected)/inbox/_components/InboxList.tsx": 1,
  "app/admin/(protected)/incidents/_client.tsx": 2,
  "app/admin/(protected)/usage/_client.tsx": 1,
  "app/admin/(protected)/users/_client.tsx": 1,
  "app/app/activities/_components/ActivityReportClient.tsx": 1,
  "app/app/activities/_components/TagReportClient.tsx": 1,
  "app/app/ads/meta/_components/MetaAdsClient.tsx": 1,
  "app/app/ai/agents/[id]/_components/AgentForm.tsx": 2,
  "app/app/ai/agents/[id]/_components/LegacyRecovery.tsx": 2,
  "app/app/ai/cases/avisos/_components/AvisoNoWhatsApp.tsx": 1,
  "app/app/ai/credentials/_components/AddCredentialDialog.tsx": 1,
  "app/app/ai/followups/[id]/_components/EdgeConfigPanel.tsx": 1,
  "app/app/ai/followups/[id]/_components/PublishBar.tsx": 1,
  "app/app/ai/followups/[id]/_components/TriggerConfigControl.tsx": 2,
  "app/app/ai/followups/[id]/_components/forms/ActionForm.tsx": 2,
  "app/app/ai/followups/[id]/_components/forms/ClassifyForm.tsx": 1,
  "app/app/ai/followups/[id]/_components/forms/CollectForm.tsx": 1,
  "app/app/ai/followups/[id]/_components/forms/ConditionForm.tsx": 4,
  "app/app/ai/followups/[id]/_components/forms/EndForm.tsx": 3,
  "app/app/ai/followups/[id]/_components/forms/InternalTaskForm.tsx": 2,
  "app/app/ai/followups/[id]/_components/forms/MatchReplyForm.tsx": 1,
  "app/app/ai/followups/[id]/_components/forms/MoveLeadForm.tsx": 1,
  "app/app/ai/followups/[id]/_components/forms/SkillForm.tsx": 1,
  "app/app/ai/followups/[id]/_components/forms/WaitForm.tsx": 1,
  "app/app/ai/followups/_components/ModelosDialog.tsx": 1,
  "app/app/ai/followups/_components/QueueTab.tsx": 2,
  "app/app/ai/providers/_components/PainelDeProvedores.tsx": 2,
  "app/app/ai/routers/[id]/_client.tsx": 5,
  "app/app/ai/routers/_client.tsx": 1,
  "app/app/ai/runs/_components/RoteamentoResultados.tsx": 5,
  "app/app/campaigns/[id]/edit/_client.tsx": 4,
  "app/app/campaigns/_client.tsx": 1,
  "app/app/campaigns/new/_client.tsx": 6,
  "app/app/comandas/_client.tsx": 2,
  "app/app/comandas/_pendentes.tsx": 1,
  "app/app/faturamento/_lancamentos.tsx": 1,
  "app/app/honorarios/_parcelas.tsx": 1,
  "app/app/integracao-dados/[id]/_components/ExploradorDeDados.tsx": 1,
  "app/app/integracao-dados/_components/FormularioDeConexao.tsx": 1,
  "app/app/kanban/_components/ImportarLeads.tsx": 1,
  "app/app/metrics/_components/MetricsClient.tsx": 1,
  "app/app/proposals/[id]/_components/DocumentoCanvas.tsx": 2,
  "app/app/proposals/novo/_client.tsx": 1,
  "app/app/prospecting/_client.tsx": 4,
  "app/app/settings/conversoes/_formGoogle.tsx": 2,
  "app/app/settings/conversoes/_historico.tsx": 3,
  "app/app/settings/conversoes/_regrasGoogle.tsx": 2,
  "app/app/settings/conversoes/_regrasMeta.tsx": 1,
  "app/app/settings/profile/_form.tsx": 2,
  "app/app/settings/security/_client.tsx": 1,
  "app/app/settings/tags/_painel.tsx": 1,
  "app/app/settings/tenant/_form.tsx": 4,
  "app/app/settings/tenant/agenda/_client.tsx": 4,
  "app/app/settings/tenant/financeiro/_client.tsx": 2,
  "app/app/settings/tenant/financeiro/_comissao.tsx": 2,
  "app/app/settings/tenant/financeiro/_recorrencias.tsx": 1,
  "app/app/settings/tenant/pipelines/_client.tsx": 2,
  "app/app/settings/tenant/pipelines/_mapping.tsx": 1,
  "app/app/settings/tenant/pipelines/_stages.tsx": 2,
  "app/app/team/_components/AttendantsClient.tsx": 3,
  "app/app/team/_components/TeamMembersClient.tsx": 1,
  "app/app/team/invite/_components/InviteForm.tsx": 1,
  "app/app/webhooks/_components/ActionConfigForm.tsx": 8,
  "app/app/webhooks/_components/CadastrarCampo.tsx": 1,
  "app/app/webhooks/_components/CapturasTab.tsx": 1,
  "app/app/webhooks/_components/CreateSourceDialog.tsx": 2,
  "app/app/webhooks/_components/RuleEditor.tsx": 8,
  "app/design/components/Switcher.tsx": 3,
  "app/onboarding/invite-team/_form.tsx": 1,
  "app/onboarding/setup-ai/_inteligencia.tsx": 1,
  "app/onboarding/welcome/_form.tsx": 1,
  "components/agenda/DetalheDoCompromisso.tsx": 1,
  "components/agenda/MeetDoCompromisso.tsx": 1,
  "components/agenda/VinculoDaMarcacao.tsx": 1,
  "components/ai/AgentEditor.tsx": 3,
  "components/ai/GuardrailsEditor.tsx": 1,
  "components/ai/UsageFilters.tsx": 1,
  "components/connections/AntiBanSheet.tsx": 1,
  "components/connections/RedesSociaisClient.tsx": 2,
  "components/connections/TelefoniaClient.tsx": 4,
  "components/connections/TemplatesParceiroClient.tsx": 1,
  "components/contacts/CustomFieldsEditor.tsx": 1,
  "components/extensions/ExtensionCatalog.tsx": 1,
  "components/inbox/InboxFilters.tsx": 1,
  "components/inbox/JanelaFechadaAviso.tsx": 1,
  "components/inbox/ReassignDialog.tsx": 1,
  "components/kanban/CamposObrigatoriosDialog.tsx": 1,
  "components/kanban/MoveToOtherPipelineDialog.tsx": 1,
  "components/kanban/NewLeadDialog.tsx": 1,
};

const RAIZ = join(__dirname, "..", "..");
/** Diretórios cuja saída um cliente vê. `api` não renderiza tela. */
const AREAS = ["app", "components"];
const PASTAS_IGNORADAS = new Set(["api", "node_modules"]);

const BLOCO_DE_SELECAO = /<SelectContent[\s>][\s\S]*?<\/SelectContent>|<select[\s>][\s\S]*?<\/select>/g;

function contarSelecoesDinamicas(fonte: string): number {
  return [...fonte.matchAll(BLOCO_DE_SELECAO)].filter((m) => m[0].includes(".map(")).length;
}

function telas(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (PASTAS_IGNORADAS.has(e.name) || e.name.startsWith(".")) continue;
    const caminho = join(dir, e.name);
    if (e.isDirectory()) telas(caminho, acc);
    else if (e.name.endsWith(".tsx") && !e.name.endsWith(".test.tsx")) acc.push(caminho);
  }
  return acc;
}

function medir(): Record<string, number> {
  const medido: Record<string, number> = {};
  for (const area of AREAS) {
    for (const arquivo of telas(join(RAIZ, area))) {
      const n = contarSelecoesDinamicas(readFileSync(arquivo, "utf8"));
      if (n > 0) medido[relative(RAIZ, arquivo).split(sep).join("/")] = n;
    }
  }
  return medido;
}

const COMO_CONSERTAR =
  "Caixa de seleção com lista vinda de dado (`.map(` dentro do menu) precisa de busca. " +
  "Use SearchableSelect de components/ui/searchable-select.tsx — com menos de 8 opções a busca nem aparece. " +
  "Confira com: pnpm vitest run tests/unit/selecao-longa-tem-busca.test.ts";

describe("caixa de seleção de lista dinâmica tem busca", () => {
  const medido = medir();

  it("nenhuma caixa nova de lista dinâmica nasce sem busca", () => {
    const excedentes = Object.entries(medido)
      .filter(([arquivo, n]) => n > (AINDA_SEM_BUSCA[arquivo] ?? 0))
      .map(([arquivo, n]) => `${arquivo}: ${n} sem busca (registrado: ${AINDA_SEM_BUSCA[arquivo] ?? 0})`);
    expect(excedentes, COMO_CONSERTAR).toEqual([]);
  });

  it("a lista de pendências só encolhe: número velho reprova", () => {
    const folgas = Object.entries(AINDA_SEM_BUSCA)
      .filter(([arquivo, n]) => (medido[arquivo] ?? 0) < n)
      .map(
        ([arquivo, n]) =>
          `${arquivo}: registrado ${n}, medido ${medido[arquivo] ?? 0} — baixe o número (ou apague a linha se chegou a 0)`,
      );
    expect(folgas).toEqual([]);
  });

  // Controle: sem ele, um detector que nunca contasse nada passaria nos dois
  // casos acima com a lista inteira em zero.
  it("controle: conta lista dinâmica, ignora lista fixa e SearchableSelect", () => {
    const dinamica = `<SelectContent>{agents.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent>`;
    const nativa = `<select value={v}>{opcoes.map((o) => <option key={o}>{o}</option>)}</select>`;
    const fixa = `<SelectContent><SelectItem value="a">A</SelectItem><SelectItem value="b">B</SelectItem></SelectContent>`;
    const migrada = `<SearchableSelect options={agents.map((a) => ({ value: a.id, label: a.name }))} />`;

    expect(contarSelecoesDinamicas(dinamica)).toBe(1);
    expect(contarSelecoesDinamicas(nativa)).toBe(1);
    expect(contarSelecoesDinamicas(fixa)).toBe(0);
    expect(contarSelecoesDinamicas(migrada)).toBe(0);
  });
});
