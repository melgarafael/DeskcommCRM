/**
 * Semente do módulo "LGPD": quatro pedidos de titular, como chegam pela loja
 * virtual (Nuvemshop) da clínica — o único caminho que cria pedido hoje
 * (app/api/v1/webhooks/nuvemshop/*). Cada um num balde de prazo diferente, para a
 * lista mostrar os selos e o aviso vermelho:
 *
 *   1. exclusão (anonimização) da Juliana, recebida, prazo já passou → "Vencido"
 *      (e não "Crítico": num sábado nenhum prazo em dia útil cai em menos de 2 dias)
 *   2. exportação da Mariana, recebida, mais da metade do prazo gasta → "Alerta"
 *   3. exportação do Pedro, recebida ontem → "OK"
 *   4. exclusão de um cliente antigo, já concluída → "Concluído"
 *
 * O prazo sai de `computeDueAt` (o mesmo do produto), e a busca pelo dia de
 * recebimento usa `computeSlaBucket` (a mesma régua da tela): o balde é o da
 * tela em qualquer dia em que a captura rodar.
 *
 * Idempotente: apaga e recria só os 4 pedidos de id fixo. A trilha de auditoria
 * (`api_audit_log`) é só-acréscimo — nenhum papel apaga —, então cada entrada é
 * gravada uma vez só, se ainda não existir.
 */
import { computeSlaBucket } from "../../lib/lgpd/balde-de-sla";
import { computeDueAt } from "../../lib/lgpd/sla";
import { type Contexto, contatoId, exigir, ha, semErro } from "../semear-demonstracao";

export const PEDIDO = {
  julianaExclusao: "7c41e9a2-5b10-4d3e-9f21-be7000000001",
  marianaExportacao: "2a8f03d6-91c4-4e7a-8b55-be7000000002",
  pedroExportacao: "d415b7e0-3a62-4f19-a8c3-be7000000003",
  antigoExclusao: "9e06c2f8-7d35-4b81-b6e4-be7000000004",
} as const;

const DIA = 24 * 60;
const LOJA = "bemviver-suplementos";

/** O primeiro "recebido há N dias" cujo prazo cai no balde pedido. */
function recebidoNoBalde(diasUteis: number, balde: string) {
  const agora = new Date();
  for (let n = 0; n <= 40; n++) {
    const recebido = new Date(ha(n * DIA + 95));
    const prazo = computeDueAt(recebido, diasUteis).toISOString();
    if (computeSlaBucket(prazo, recebido.toISOString(), agora) !== balde) continue;
    return { received_at: recebido.toISOString(), due_at: prazo };
  }
  throw new Error(`nenhum dia de recebimento cai no balde ${balde}`);
}

export async function semear(c: Contexto) {
  const { db, org, pessoa } = c;
  const ids = Object.values(PEDIDO);
  semErro(await db.from("lgpd_requests").delete().eq("organization_id", org).in("id", ids), "limpar pedidos LGPD");

  const juliana = recebidoNoBalde(15, "overdue");
  const mariana = recebidoNoBalde(7, "warning");
  const pedro = recebidoNoBalde(7, "ok");
  const antigoRecebido = new Date(ha(6 * DIA + 200));
  const antigo = { received_at: antigoRecebido.toISOString(), due_at: computeDueAt(antigoRecebido, 15).toISOString() };

  const cliente = (id: string, nome: string, email: string) => ({ id: Number(id), name: nome, email });
  const linhas = [
    {
      id: PEDIDO.julianaExclusao, request_type: "redact", contact_id: contatoId(3), external_customer_id: "48213907", ...juliana,
      request_payload: { customer: cliente("48213907", "Juliana Castro", "juliana.castro@gmail.com"), store_id: LOJA, orders_requested: [] },
    },
    {
      id: PEDIDO.marianaExportacao, request_type: "data_request", contact_id: contatoId(1), external_customer_id: "48190544", ...mariana,
      request_payload: {
        customer: cliente("48190544", "Mariana Souza", "mariana.souza@outlook.com"), store_id: LOJA, orders_requested: [],
        delivery: { method: "email", address: "mariana.souza@outlook.com" },
      },
    },
    {
      id: PEDIDO.pedroExportacao, request_type: "data_request", contact_id: contatoId(4), external_customer_id: "48227316", ...pedro,
      request_payload: {
        customer: cliente("48227316", "Pedro Henrique Lima", "pedrohlima@gmail.com"), store_id: LOJA, orders_requested: [],
        delivery: { method: "email", address: "pedrohlima@gmail.com" },
      },
    },
    {
      id: PEDIDO.antigoExclusao, request_type: "redact", contact_id: null, external_customer_id: "47960281", ...antigo,
      status: "completed", completed_at: ha(3 * DIA + 40), attempts: 1,
      request_payload: { customer: { id: 47960281 }, store_id: LOJA, orders_requested: [] },
    },
  ].map((l) => ({ status: "received", attempts: 0, completed_at: null, source: "nuvemshop", scope: "contact", emergency: false, organization_id: org, ...l }));
  semErro(await db.from("lgpd_requests").insert(linhas), "pedidos LGPD");

  // ---------- trilha de auditoria: o que o webhook e a aprovação gravam ----------
  const trilha = [
    ...linhas.map((l) => ({
      action: l.request_type === "redact" ? "lgpd.redact_received" : "lgpd.data_request_received",
      resource_id: l.id, actor_user_id: null as string | null, created_at: l.received_at,
      metadata: { source: "nuvemshop", store_id: LOJA, external_customer_id: l.external_customer_id, contact_id: l.contact_id },
    })),
    {
      action: "lgpd.manually_approved", resource_id: PEDIDO.antigoExclusao, actor_user_id: pessoa.helena, created_at: ha(5 * DIA + 30),
      metadata: { approved_reason: "Pedido de exclusão conferido com o cliente por telefone.", request_type: "redact" },
    },
    {
      action: "lgpd.redact_completed", resource_id: PEDIDO.antigoExclusao, actor_user_id: null, created_at: ha(3 * DIA + 40),
      metadata: { request_id: PEDIDO.antigoExclusao },
    },
  ];
  const existentes = exigir(
    await db.from("api_audit_log").select("action, resource_id").eq("organization_id", org).in("resource_id", ids),
    "trilha existente",
  ) as Array<{ action: string; resource_id: string }>;
  const faltando = trilha.filter((t) => !existentes.some((e) => e.action === t.action && e.resource_id === t.resource_id));
  if (faltando.length) {
    semErro(await db.from("api_audit_log").insert(faltando.map((t) => ({ ...t, organization_id: org, resource_type: "lgpd_request" }))), "trilha LGPD");
  }
}
