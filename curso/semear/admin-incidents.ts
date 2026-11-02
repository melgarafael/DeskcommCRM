/**
 * Semente do módulo Incidents (Admin): cinco incidentes de exemplo — quatro
 * abertos (um de cada severidade, um da instalação inteira, sem empresa) e um já
 * resolvido —, mais uma empresa de exemplo para a coluna "Tenant" ter mais de
 * um nome.
 *
 * ⚠️ Nenhum código do produto grava em `incidents` (só a tela lê e resolve):
 * numa instalação de verdade a lista vem vazia. Os tipos daqui são exemplos e as
 * lições dizem isso ao aluno.
 *
 * Os incidentes ganham id NOVO a cada rodada, de propósito: a trilha de
 * auditoria da página de detalhe é o `api_audit_log` filtrado pelo id do
 * incidente, e esse registro não se apaga. Com id fixo, cada recaptura
 * empilharia mais um "incident.resolved" no mesmo incidente. As lições chegam ao
 * detalhe pelo "Ver" da linha, nunca por rota com id.
 */
import { type Contexto, exigir, ha, semErro } from "../semear-demonstracao";

const FISIO = "a1c00000-0000-4000-8000-000000000001";
const TIPOS = [
  "whatsapp.session_disconnected",
  "ai.budget_threshold_reached",
  "worker.queue_backlog",
  "webhook.delivery_failing",
];
const DIA = 60 * 24;

export async function semear(c: Contexto) {
  const { db, org, pessoa } = c;
  semErro(await db.from("incidents").delete().in("type", TIPOS), "apagar incidentes de exemplo");
  semErro(await db.from("organizations").delete().eq("id", FISIO), "apagar empresa de exemplo");

  // depois da principal: a base trata a org mais antiga como a da instalação
  const principal = exigir(await db.from("organizations").select("created_at").eq("id", org).single(), "criação da org principal") as { created_at: string };
  const criada = new Date(Math.min(new Date(principal.created_at).getTime() + 60_000, Date.now() - 5_000)).toISOString();
  semErro(
    await db.from("organizations").insert({
      id: FISIO, slug: "fisiovida-reabilitacao", display_name: "FisioVida Reabilitação",
      legal_name: "FisioVida Fisioterapia e Reabilitação Ltda", cnpj: "34.567.890/0001-21",
      status: "active", onboarded_at: criada, created_at: criada, settings: { plan: "standard" },
    }),
    "empresa de exemplo",
  );

  semErro(
    // inserção em lote: coluna ausente numa linha vira null (não o default), então todas levam updated_at
    await db.from("incidents").insert([
      {
        organization_id: org, type: "whatsapp.session_disconnected", severity: "critical", status: "open", created_at: ha(25),
        payload: { canal: "Recepção Bem Viver", numero: "+55 31 3333-4521", ultima_situacao: "desconectado", minutos_fora: 25 },
      },
      {
        organization_id: FISIO, type: "ai.budget_threshold_reached", severity: "warning", status: "open", created_at: ha(3 * 60),
        payload: { teto_mensal: "R$ 150,00", gasto_no_mes: "R$ 138,00", percentual: 92 },
      },
      {
        organization_id: null, type: "worker.queue_backlog", severity: "warning", status: "open", created_at: ha(DIA + 40),
        payload: { tarefas_na_fila: 312, mais_antiga_ha_minutos: 18 },
      },
      {
        organization_id: org, type: "webhook.delivery_failing", severity: "info", status: "open", created_at: ha(2 * DIA),
        payload: { destino: "https://agenda.clinicabemviver.com.br/avisos", tentativas: 3, ultima_resposta: 503 },
      },
      {
        organization_id: FISIO, type: "whatsapp.session_disconnected", severity: "critical", status: "resolved",
        created_at: ha(5 * DIA), resolved_at: ha(5 * DIA - 50), resolved_by: pessoa.helena, updated_at: ha(5 * DIA - 50),
        resolution_note: "O celular da recepção ficou sem internet. Reconectamos o número lendo o QR de novo.",
        payload: { canal: "Recepção FisioVida", numero: "+55 31 3444-8812", ultima_situacao: "desconectado", minutos_fora: 47 },
      },
    ].map((i) => ({ updated_at: i.created_at, ...i }))),
    "incidentes de exemplo",
  );
}
