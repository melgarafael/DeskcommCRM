/**
 * In-process MCP-tool bridge for the agent runtime (S-13.08).
 *
 * The agent runtime does NOT round-trip through `/api/mcp`; instead it pulls
 * tool definitions from the same catalog (`lib/mcp/tools/index.ts`) and wraps
 * each as an AI SDK `Tool`. Audit, role/scope checks, and PII redaction stay
 * identical because we reuse `auditMcpToolCall` and `ensureRole/ensureScope`.
 *
 * The handoff tool (`crm_request_human_handoff`) is special: when the agent
 * calls it, the runtime needs to know mid-flight so it can short-circuit the
 * loop. We wrap that tool's execute to publish a one-shot signal via
 * `runtimeHandoffSignal`, which `runAgent` checks after each step.
 */
import { tool, type Tool } from "ai";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

import { auditMcpToolCall } from "@/lib/mcp/audit";
import { McpAuthError, ensureRole, ensureScope } from "@/lib/mcp/auth";
import type { McpAuthResult } from "@/lib/mcp/auth";
import { logger } from "@/lib/logger";
import { allTools, getToolByName } from "@/lib/mcp/tools";
import { catalogEntry, deModuloDesligado } from "@/lib/mcp/tools/catalog";
import type { ModuloOpcional } from "@/lib/instalacao/modulos";
import { higienizarUuidsDeAterro } from "@/lib/mcp/uuid-de-aterro";
import { recusaDeCapacidadeParaOModelo } from "@/lib/mcp/recusa-para-o-modelo";
import type { McpContext, McpToolDefinition } from "@/lib/mcp/types";
import { resolveActiveLeadForContact, type LeadCandidate } from "@/lib/leads/active-lead";
import { podeChamarFerramenta, recusaParaOModelo } from "@/lib/leads/escopo-de-funil";

export interface RuntimeHandoffSignal {
  triggered: boolean;
  reason?: string;
  urgency?: string;
}

export interface PickToolsInput {
  supabase: SupabaseClient;
  ctx: McpContext;
  auth: McpAuthResult;
  toolIds: string[];
  handoffToolEnabled: boolean;
  /**
   * Funis em que ESTE agente pode escrever (`ai_agent_versions.pipeline_ids`).
   *
   * `?? []` no chamador, e vazio significa NENHUM: o clone que ainda não aplicou
   * a migration 0125 nasce fechado, pela mesma razão de `operator_tool_ids` — a
   * direção segura é agir de menos.
   */
  pipelineIds?: readonly string[];
  /**
   * Módulos opcionais LIGADOS na instalação (`modulosLigados()`). Ausente vale
   * como nenhum: capacidade de módulo não entra no turno sem que o chamador
   * tenha perguntado — a direção segura, como a de `pipelineIds`.
   */
  modulosLigados?: readonly ModuloOpcional[];
  /** Mutable signal — runtime checks after each step. */
  handoffSignal: RuntimeHandoffSignal;
}

const HANDOFF_TOOL_NAME = "crm_request_human_handoff";

function shapeToZodObject(shape: Record<string, z.ZodTypeAny>): z.ZodTypeAny {
  // The MCP tool inputSchema is a Zod *raw shape* (object of zod types).
  return z.object(shape);
}

function wrapMcpTool(
  def: McpToolDefinition,
  input: PickToolsInput,
): Tool {
  const inputSchema = shapeToZodObject(def.inputSchema as Record<string, z.ZodTypeAny>);

  return tool({
    description: def.description,
    inputSchema,
    execute: async (args: unknown) => {
      const startedAt = Date.now();
      // ── O UUID QUE O MODELO INVENTA PARA "NÃO SEI" ────────────────────────
      //
      // Aqui, na fronteira, e não em cada handler. Medido em produção: um
      // agente mandou `owner_user_id: "00000000-…"` num campo OPCIONAL, o
      // `?? tipo.default_owner_user_id` do outro lado não caiu no default
      // porque o valor não era `undefined`, e a agenda de um usuário que não
      // existe voltou vazia. A paciente ficou sem consulta e a chamada está no
      // audit com `success: true` — não havia erro para investigar.
      //
      // O catálogo tem 28 campos de uuid que aceitam ausência, e todos vazavam
      // a mesma sentinela. Consertar por handler seria consertar por instância:
      // o 29º nasceria fora. Ver `lib/mcp/uuid-de-aterro.ts`.
      const higiene = higienizarUuidsDeAterro(
        def.inputSchema as Record<string, z.ZodTypeAny>,
        (args ?? {}) as Record<string, unknown>,
      );
      const argsRecord = higiene.limpos;
      // O que vai ao audit não é necessariamente o que vai ao handler: a tool
      // pode declarar como tirar PII dos args (ex.: valores de filtro).
      const argsAudit = def.redigirParaAuditoria ? def.redigirParaAuditoria(argsRecord) : argsRecord;
      if (higiene.descartados.length > 0) {
        // Não é cosmético: sem esta linha o defeito passa a se curar em
        // silêncio e ninguém descobre que um modelo faz isso o tempo todo.
        logger.info("uuid de aterro descartado do payload da tool", {
          tool: def.name,
          campos: higiene.descartados.join(","),
        });
      }
      try {
        ensureScope(input.auth.scopes, def.requiresScope);
        ensureRole(input.auth.role, def.requiresRole);

        // ── ESCOPO DE FUNIL (spec 17 passo 3) ────────────────────────────────
        //
        // Aqui, e não dentro de cada handler: `moveLeadHandler` e irmãos servem
        // o agente, a rota HTTP sob sessão E as automações. Um gate lá dentro
        // cobraria de uma regra de automação cujo funil foi escolhido por um
        // humano de propósito, e de um atendente fazendo o trabalho dele.
        //
        // Este ponto sabe que quem age é o AGENTE — é o que torna a restrição
        // aplicável sem atingir quem não deve ser atingido.
        const veredito = await podeChamarFerramenta({
          ferramenta: def.name,
          argumentos: argsRecord,
          escopo: input.pipelineIds,
          ehEscrita: def.category === "write",
          resolvePipelineDoLead: async (leadId) => {
            const { data, error } = await input.supabase
              .from("crm_leads")
              .select("pipeline_id")
              .eq("organization_id", input.ctx.organizationId)
              .eq("id", leadId)
              .maybeSingle();
            // `throw` e não `null`: erro de consulta precisa virar
            // `indisponivel` lá dentro, nunca "fora do escopo". Traduzir falha
            // de banco em recusa de permissão ensinaria ao modelo que o card
            // não é dele, e ele pararia de tentar para sempre.
            if (error) throw new Error(error.message);
            return (data as { pipeline_id: string } | null)?.pipeline_id ?? null;
          },
          /**
           * O negócio ABERTO de um contato — para `funil_vem_do_contato`.
           *
           * A agenda opera por CONTATO (quem é atendido), não por lead. Sem este
           * resolvedor, `crm_book_appointment` só poderia ser `sem_funil` e o escopo
           * não valeria para ela em caso nenhum.
           *
           * ⚠️ A DECISÃO de qual negócio é do contato NÃO nasce aqui: é de
           * `resolveActiveLeadForContact`, a MESMA que o roteamento de atividade usa.
           * Reimplementar "qual negócio da pessoa está em jogo" faria o escopo e a
           * timeline discordarem sobre o mesmo cliente.
           */
          resolveLeadDoContato: async (contactId) => {
            const { data, error } = await input.supabase
              .from("crm_leads")
              .select("id, organization_id, pipeline_id, status, last_activity_at, created_at")
              .eq("organization_id", input.ctx.organizationId)
              .eq("contact_id", contactId);
            // `throw` e não desfecho: erro de consulta vira `indisponivel` lá dentro,
            // nunca "fora do escopo" — a mesma razão do irmão acima.
            if (error) throw new Error(error.message);

            const r = resolveActiveLeadForContact((data ?? []) as LeadCandidate[]);
            if (r.routed) return { tipo: "lead" as const, leadId: r.leadId };
            return r.reason === "ambiguous_open_leads"
              ? { tipo: "ambiguo" as const, quantos: r.candidateIds.length }
              : { tipo: "sem_lead" as const };
          },
        });

        if (!veredito.permitido) {
          const explicacao = recusaParaOModelo(veredito) ?? "ação não permitida.";
          void auditMcpToolCall({
            ctx: input.ctx,
            toolName: def.name,
            args: argsAudit,
            durationMs: Date.now() - startedAt,
            success: false,
            errorMessage: `escopo_de_funil:${veredito.motivo}`,
          });
          // Devolve TEXTO em vez de lançar: o modelo lê, entende por que foi
          // recusado e segue a conversa. Uma exceção viraria erro de execução e
          // o turno morreria — para o cliente, o assistente teria emudecido.
          return { permitido: false, motivo: veredito.motivo, mensagem: explicacao };
        }

        const result = await def.handler(argsRecord as never, input.ctx);

        // Capture handoff signal so the runtime can short-circuit the loop.
        if (def.name === HANDOFF_TOOL_NAME) {
          input.handoffSignal.triggered = true;
          input.handoffSignal.reason = String(argsRecord.reason ?? "requested_human");
          input.handoffSignal.urgency = String(argsRecord.urgency ?? "normal");
        }

        // "Não achei" NÃO é sucesso (#484).
        //
        // A tool declara (`motivoDoVazio`) quando a resposta é um vazio: a busca
        // de produtos que não achou nada terminava bem e era auditada com
        // `success: true`, então o painel de capacidades contava `falhas: 0` —
        // "nenhuma falha" — enquanto o agente nunca achava um produto. O número
        // não mentia; ele não existia. Aqui o vazio declarado vira
        // `success: false` e o motivo sobe em `metadata.desfecho`/`metadata.motivo`,
        // que é o que separa "não achei" de "quebrou" no dado gravado.
        //
        // Só quem declara é afetado: sem `motivoDoVazio` nada muda.
        const motivoDoVazio = def.motivoDoVazio?.(result) ?? null;

        void auditMcpToolCall({
          ctx: input.ctx,
          toolName: def.name,
          args: argsAudit,
          durationMs: Date.now() - startedAt,
          success: motivoDoVazio === null,
          ...(motivoDoVazio === null
            ? {}
            : { desfecho: "sem_resultado" as const, motivo: motivoDoVazio }),
        });
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : "unknown_error";
        void auditMcpToolCall({
          ctx: input.ctx,
          toolName: def.name,
          args: argsAudit,
          durationMs: Date.now() - startedAt,
          success: false,
          errorMessage: message,
        });
        // Recusa por papel/scope NAO e erro de execucao — e defeito de
        // configuracao: o humano ligou a capacidade na tela e ela nao existe na
        // pratica. Devolver so ao modelo faz a promessa quebrada sumir sem
        // alarme (o modelo le o erro, segue conversando, e ninguem fica
        // sabendo). Emite sinal proprio para que apareca na observabilidade.
        if (err instanceof McpAuthError) {
          logger.error("capacidade ligada na tela e inalcancavel em execucao", {
            tool_name: def.name,
            requires_role: def.requiresRole,
            requires_scope: def.requiresScope,
            actor_role: input.auth.role,
            organization_id: input.ctx.organizationId,
            request_id: input.ctx.requestId,
          });
        }
        // ⚠️ O QUE VOLTA AO MODELO NÃO É A MENSAGEM TÉCNICA quando a recusa é de
        // papel. Medido com LLM real: `Role 'agent' insufficient (required:
        // 'manager')` virou "SEU perfil atual é agent" na cara de quem perguntou
        // — o modelo não tinha como saber que o papel era DELE, não do leitor. A
        // mensagem original continua no log e na observabilidade acima, onde
        // serve; para o modelo vai uma instrução que já sabe o que é.
        if (err instanceof McpAuthError) {
          return { error: recusaDeCapacidadeParaOModelo(def.name) };
        }
        // Return error to the model rather than throwing — keeps the loop alive.
        return { error: message };
      }
    },
  });
}

export function pickToolsFromMcp(input: PickToolsInput): Record<string, Tool> {
  const result: Record<string, Tool> = {};

  for (const id of input.toolIds) {
    const def = getToolByName(id);
    if (!def) continue;
    if (def.name === HANDOFF_TOOL_NAME && !input.handoffToolEnabled) continue;

    // Capacidade `apenasHumano` NÃO é montada no turno do agente.
    //
    // Medido com IA real: `crm_create_stage` aparecia no painel como "1
    // tentativa, 1 falha". O que acontecia: o dono liga na tela, a ponte monta
    // a tool, o modelo GASTA uma chamada, e só então o servidor recusa por
    // papel. A trava existia (requiresRole acima do papel do agente) mas só
    // agia DEPOIS da tentativa — o modelo aprendia o limite errando, e o painel
    // registrava falha onde não havia defeito.
    //
    // A marca era declaração sem efeito no runtime: eu a criei no catálogo e
    // não a apliquei aqui. Não montar é o que faz a declaração valer.
    if (catalogEntry(def.name)?.apenasHumano) continue;

    // Módulo opcional desligado nesta instalação (doc 37): a capacidade não
    // existe aqui, então nem chega ao modelo — mesmo que a versão publicada do
    // agente a tenha marcada de quando o módulo estava ligado.
    if (deModuloDesligado(def.name, input.modulosLigados ?? [])) continue;

    result[def.name] = wrapMcpTool(def, input);
  }

  // Auto-inject handoff tool when enabled even if not in tool_ids — Spec 10
  // §6 step 8 has it conditional on `handoff_tool_enabled` only.
  if (input.handoffToolEnabled && !result[HANDOFF_TOOL_NAME]) {
    const handoff = allTools.find((t) => t.name === HANDOFF_TOOL_NAME);
    if (handoff) {
      result[HANDOFF_TOOL_NAME] = wrapMcpTool(handoff, input);
    }
  }

  return result;
}
