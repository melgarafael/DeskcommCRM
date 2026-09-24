/**
 * Capacidades de HONORÁRIOS — módulo opcional de advocacia (ADR-0002).
 *
 * As tabelas só existem depois que o administrador da instalação instala `honorarios` em
 * `/admin/modulos`. Uma organização que liga esta capacidade sem o módulo instalado é erro de
 * configuração, não "não achei" — por isso as duas tools aqui LANÇAM (não devolvem vazio
 * silencioso) quando a tabela não existe, com uma mensagem que aponta a causa.
 *
 * Service role bypassa RLS: TODA query filtra `organization_id` manualmente.
 */
import { z } from "zod";

import type { McpToolDefinition } from "../types";

const MODULO_NAO_INSTALADO_HINT =
  "módulo de honorários não está instalado nesta instalação (peça ao administrador para " +
  "instalar em Configurações da instalação › Módulos) — esta capacidade não deveria estar " +
  "ligada em nenhum agente enquanto isso";

function ehTabelaInexistente(error: { code?: string } | null): boolean {
  return error?.code === "42P01";
}

// ---------------------------------------------------------------------------
// contrato de um lead
// ---------------------------------------------------------------------------

const contratoInputShape = {
  lead_id: z.string().uuid().describe("O caso (lead) cujo contrato de honorários se quer ver."),
};

export const crmGetHonorariosContrato: McpToolDefinition<typeof contratoInputShape> = {
  name: "crm_get_honorarios_contrato",
  description:
    "Traz o contrato de honorários de um caso: modelo (fixo, êxito ou misto), valor fixo e/ou " +
    "percentual de êxito. Use antes de falar de valor com o cliente — nunca estime ou lembre um " +
    "número. Se não houver contrato para este caso, devolve `contrato: null`: diga que o time " +
    "vai confirmar, não invente um valor.",
  inputSchema: contratoInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const { data, error } = await ctx.supabase
      .from("honorarios_contratos")
      .select("id, modelo, valor_fixo_cents, percentual_exito, repasse_advogado_pct")
      .eq("organization_id", ctx.organizationId)
      .eq("lead_id", input.lead_id)
      .maybeSingle();

    if (error) {
      if (ehTabelaInexistente(error)) {
        throw new Error(`honorarios_contrato_falhou: ${MODULO_NAO_INSTALADO_HINT}`);
      }
      throw new Error(`honorarios_contrato_falhou: ${error.message}`);
    }

    return { contrato: data ?? null };
  },
};

// ---------------------------------------------------------------------------
// parcelas de um contrato
// ---------------------------------------------------------------------------

const parcelasInputShape = {
  contrato_id: z.string().uuid().describe("O contrato cujas parcelas se quer ver."),
};

export const crmListHonorariosParcelas: McpToolDefinition<typeof parcelasInputShape> = {
  name: "crm_list_honorarios_parcelas",
  description:
    "Lista as parcelas de um contrato de honorários, em ordem, com vencimento, valor e status " +
    "(pendente, pago ou atrasado). Use para responder sobre parcela em aberto, data de " +
    "vencimento ou confirmar que um pagamento já foi registrado.",
  inputSchema: parcelasInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const { data, error } = await ctx.supabase
      .from("honorarios_parcelas")
      .select("id, numero, vencimento, valor_cents, status")
      .eq("organization_id", ctx.organizationId)
      .eq("contrato_id", input.contrato_id)
      .order("numero", { ascending: true });

    if (error) {
      if (ehTabelaInexistente(error)) {
        throw new Error(`honorarios_parcelas_falhou: ${MODULO_NAO_INSTALADO_HINT}`);
      }
      throw new Error(`honorarios_parcelas_falhou: ${error.message}`);
    }

    return { parcelas: data ?? [] };
  },
};
