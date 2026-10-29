/**
 * Semente do módulo "LGPD (Admin)": pedidos de titular de várias empresas do
 * servidor, para a lista da plataforma mostrar os tipos, os selos de risco, os
 * status e o aviso vermelho.
 *
 *  - Clínica Bem Viver: os 4 pedidos do módulo "LGPD" da empresa (a semente
 *    dele, chamada aqui para a lista não depender de qual módulo rodou antes;
 *    ela só apaga e recria os 4 pedidos de id fixo dela).
 *  - Odonto Sorriso Leve: exportação em "Revisão" — o arquivo foi gerado, mas a
 *    instalação não tem e-mail configurado (o que o worker grava,
 *    workers/lgpd-export-worker.ts). É o pedido que a lição 3 abre.
 *  - NutriBem Consultório: exportação recebida e não aprovada, prazo vencido.
 *  - FisioVida Reabilitação: uma exclusão em andamento com mais da metade do
 *    prazo gasta ("Alerta") e uma exportação já concluída.
 *
 * As empresas são de exemplo (ids fixos, sem Helena/Ana/Carlos como membros) e a
 * base apaga organizações extras antes de cada lição — os pedidos delas vão
 * junto. O pedido da Odonto ganha id NOVO a cada rodada: abrir a ficha grava uma
 * linha de "visualizado" na trilha de auditoria, que é só-acréscimo, e com id
 * fixo a trilha da foto cresceria a cada captura.
 *
 * Os prazos saem de `computeDueAt` (7 dias úteis para exportação, 15 para
 * exclusão, como nos webhooks da Nuvemshop) e o dia de recebimento é escolhido
 * com `computeRiskLevel`, a régua da própria tela.
 */
import { randomUUID } from "node:crypto";

import { computeRiskLevel, type RiskLevel } from "../../lib/lgpd/balde-de-sla";
import { computeDueAt } from "../../lib/lgpd/sla";
import { type Contexto, ha, semErro } from "../semear-demonstracao";
import { semear as semearPedidosDaClinica } from "./lgpd";

export const ORG = {
  odonto: "a7d00000-0000-4000-8000-000000000001",
  nutri: "a7d00000-0000-4000-8000-000000000002",
  fisio: "a7d00000-0000-4000-8000-000000000003",
};
const DIA = 24 * 60;

/** O primeiro "recebido há N dias" (N >= minimo) cujo prazo cai no risco pedido. */
function recebidoNoRisco(diasUteis: number, risco: RiskLevel, minimo = 0) {
  for (let n = minimo; n <= 40; n++) {
    const recebido = new Date(ha(n * DIA + 130));
    const prazo = computeDueAt(recebido, diasUteis).toISOString();
    if (computeRiskLevel(prazo, recebido.toISOString()) !== risco) continue;
    return { received_at: recebido.toISOString(), due_at: prazo };
  }
  throw new Error(`nenhum dia de recebimento cai no risco ${risco}`);
}

const cliente = (id: string, nome: string, email: string, loja: string, comEntrega: boolean) => ({
  customer: { id: Number(id), name: nome, email },
  store_id: loja,
  orders_requested: [],
  ...(comEntrega ? { delivery: { method: "email", address: email } } : {}),
});

export async function semear(c: Contexto) {
  await semearPedidosDaClinica(c);

  semErro(await c.db.from("organizations").delete().in("id", Object.values(ORG)), "apagar empresas de exemplo");
  semErro(
    await c.db.from("organizations").insert([
      {
        id: ORG.odonto, slug: "odonto-sorriso-leve", display_name: "Odonto Sorriso Leve",
        legal_name: "Odonto Sorriso Leve Clínica Odontológica Ltda", status: "active",
        onboarded_at: ha(58 * DIA), created_at: ha(60 * DIA),
      },
      {
        id: ORG.nutri, slug: "nutribem-consultorio", display_name: "NutriBem Consultório",
        legal_name: "NutriBem Consultório de Nutrição Ltda", status: "active",
        onboarded_at: ha(40 * DIA), created_at: ha(41 * DIA),
      },
      {
        id: ORG.fisio, slug: "fisiovida-reabilitacao", display_name: "FisioVida Reabilitação",
        legal_name: "FisioVida Fisioterapia e Reabilitação Ltda", status: "active",
        onboarded_at: ha(30 * DIA), created_at: ha(32 * DIA),
      },
    ]),
    "empresas de exemplo",
  );

  const odonto = { id: randomUUID(), ...recebidoNoRisco(7, "ok", 2) };
  const nutri = recebidoNoRisco(7, "expired");
  const fisioExclusao = recebidoNoRisco(15, "warning");
  const fisioConcluida = recebidoNoRisco(7, "ok", 3);

  const linhas = [
    {
      id: odonto.id, organization_id: ORG.odonto, request_type: "data_request", external_customer_id: "51830277",
      received_at: odonto.received_at, due_at: odonto.due_at, status: "pending_review", attempts: 1,
      error_message: "email_not_configured",
      request_payload: cliente("51830277", "Renata Albuquerque", "renata.albuquerque@gmail.com", "sorrisoleve-loja", true),
    },
    {
      organization_id: ORG.nutri, request_type: "data_request", external_customer_id: "50214468",
      ...nutri, status: "received", attempts: 0,
      request_payload: cliente("50214468", "Fernanda Rocha", "fe.rocha@hotmail.com", "nutribem-loja", true),
    },
    {
      organization_id: ORG.fisio, request_type: "redact", external_customer_id: "49377105",
      ...fisioExclusao, status: "processing", attempts: 1,
      request_payload: cliente("49377105", "Rogério Bastos", "rogerio.bastos@uol.com.br", "fisiovida-loja", false),
    },
    {
      organization_id: ORG.fisio, request_type: "data_request", external_customer_id: "49390012",
      ...fisioConcluida, status: "completed", attempts: 1, completed_at: ha(DIA + 300),
      request_payload: cliente("49390012", "Débora Antunes", "debora.antunes@gmail.com", "fisiovida-loja", true),
    },
  ].map((l) => ({
    // colunas iguais em todas as linhas: no insert em lote, coluna ausente vira null, não o default
    id: randomUUID(), source: "nuvemshop", scope: "contact", emergency: false, contact_id: null,
    error_message: null, completed_at: null, ...l,
  }));
  semErro(await c.db.from("lgpd_requests").insert(linhas), "pedidos LGPD das empresas de exemplo");

  // ---------- trilha do pedido da Odonto: o que o webhook, a aprovação e o worker gravam ----------
  const recebido = new Date(odonto.received_at).getTime();
  const depois = (min: number) => new Date(recebido + min * 60_000).toISOString();
  semErro(
    await c.db.from("api_audit_log").insert(
      [
        {
          action: "lgpd.data_request_received", created_at: odonto.received_at,
          metadata: { source: "nuvemshop", store_id: "sorrisoleve-loja", external_customer_id: "51830277" },
        },
        {
          action: "lgpd.manually_approved", created_at: depois(26 * 60),
          metadata: { approved_reason: "Paciente confirmou o pedido por telefone.", request_type: "data_request" },
        },
        {
          action: "lgpd.export_generated", created_at: depois(26 * 60 + 2),
          metadata: { warning: "email_not_configured", signed_pades: false },
        },
      ].map((t) => ({ ...t, organization_id: ORG.odonto, resource_type: "lgpd_request", resource_id: odonto.id, actor_user_id: null })),
    ),
    "trilha do pedido da Odonto",
  );
}
