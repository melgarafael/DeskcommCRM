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
    "vai confirmar, não invente um valor." +
    " Em conversa de atendimento, só o contrato do caso do contato desta conversa.",
  inputSchema: contratoInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    // ── O CONTRATO DE QUEM NÃO É DESTA CONVERSA NÃO SE LÊ AQUI (#2184) ─────
    //
    // Mesmo escopo do #2178 nas leituras de conversa, e pela MESMA razão: o
    // contrato traz valor, percentual e repasse — dado que, uma vez lido, vai
    // para o WhatsApp de quem está do outro lado, encaminhável, sem volta. A
    // consulta filtra `organization_id`, então não há vazamento entre
    // ORGANIZAÇÕES; o alcance que muda é o de dentro dela.
    //
    // O contrato é de um CASO (`lead_id` → `crm_leads`), e é pelo CASO que se
    // acha o dono: `crm_leads.contact_id` é a ligação com a pessoa. RECUSA, e
    // não tradução — trocar o `lead_id` pedido pelo do turno faria o modelo
    // perguntar por um caso e receber o contrato de outro.
    //
    // FECHADO PARA BAIXO, e não só quando o dono aparece: caso que não existe
    // nesta organização, caso de outra organização e caso sem contato
    // ligado caem todos no MESMO `fora_da_conversa` — um uuid não vira
    // oráculo de existência, e a resposta de "não é deste cliente" é a mesma
    // nos três casos. Sem contato do turno — rota HTTP, MCP externo, agente
    // sem conversa — o caminho é idêntico ao de antes, e `contrato: null`
    // continua sendo a resposta de "sem contrato" para quem tem o caso na mão.
    if (ctx.contatoDoTurno) {
      const { data: caso, error: casoErr } = await ctx.supabase
        .from("crm_leads")
        .select("id, contact_id")
        .eq("organization_id", ctx.organizationId)
        .eq("id", input.lead_id)
        .maybeSingle();

      if (casoErr) {
        if (ehTabelaInexistente(casoErr)) {
          throw new Error(`honorarios_contrato_falhou: ${MODULO_NAO_INSTALADO_HINT}`);
        }
        throw new Error(`honorarios_contrato_falhou: ${casoErr.message}`);
      }

      if (!caso || caso.contact_id !== ctx.contatoDoTurno) {
        return {
          permitido: false,
          motivo: "fora_da_conversa",
          mensagem:
            "esta conversa é com outra pessoa — o contrato de honorários de um caso que não é " +
            "deste cliente não é seu para ver; siga a conversa com quem está falando.",
        };
      }
    }

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
    "vencimento ou confirmar que um pagamento já foi registrado." +
    " Em conversa de atendimento, só as parcelas do contrato do caso do contato desta conversa.",
  inputSchema: parcelasInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    // ── AS PARCELAS DE QUEM NÃO É DESTA CONVERSA NÃO SÃO DESTA LEITURA (#2184)
    //
    // A MESMA trava do contrato acima, dois saltos adiante: parcela só existe
    // dentro de contrato, contrato é de um caso, e o caso tem dono em
    // `crm_leads.contact_id`. São vencimento, valor e status de pagamento —
    // dado que, lido, vai para o lado de lá encaminhável.
    //
    // FECHADO PARA BAIXO, pela mesma razão: contrato que não existe, contrato
    // de outra organização, caso sem contato ligado e caso de outro cliente
    // caem no MESMO `fora_da_conversa`. Sem contato do turno, nada muda.
    if (ctx.contatoDoTurno) {
      const { data: contrato, error: contratoErr } = await ctx.supabase
        .from("honorarios_contratos")
        .select("id, lead_id")
        .eq("organization_id", ctx.organizationId)
        .eq("id", input.contrato_id)
        .maybeSingle();

      if (contratoErr) {
        if (ehTabelaInexistente(contratoErr)) {
          throw new Error(`honorarios_parcelas_falhou: ${MODULO_NAO_INSTALADO_HINT}`);
        }
        throw new Error(`honorarios_parcelas_falhou: ${contratoErr.message}`);
      }

      const { data: caso, error: casoErr } = contrato?.lead_id
        ? await ctx.supabase
            .from("crm_leads")
            .select("id, contact_id")
            .eq("organization_id", ctx.organizationId)
            .eq("id", contrato.lead_id)
            .maybeSingle()
        : { data: null, error: null };

      if (casoErr) {
        if (ehTabelaInexistente(casoErr)) {
          throw new Error(`honorarios_parcelas_falhou: ${MODULO_NAO_INSTALADO_HINT}`);
        }
        throw new Error(`honorarios_parcelas_falhou: ${casoErr.message}`);
      }

      if (!contrato || !caso || caso.contact_id !== ctx.contatoDoTurno) {
        return {
          permitido: false,
          motivo: "fora_da_conversa",
          mensagem:
            "esta conversa é com outra pessoa — as parcelas de um contrato que não é deste " +
            "cliente não são suas para ver; siga a conversa com quem está falando.",
        };
      }
    }

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
