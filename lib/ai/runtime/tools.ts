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
import { definirFerramentasRemotas } from "@/lib/mcp/tools/externo";
import type { FerramentaRemota } from "@/lib/mcp/servidor-externo/chamada";
import type { ServidorMcpExterno } from "@/lib/mcp/servidor-externo/registro";
import { catalogEntry, deCapacidadeDesligada, deModuloDesligado } from "@/lib/mcp/tools/catalog";
import type { CapacidadeDaOrganizacao } from "@/lib/organizacao/capacidades";
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
  proposalAiDraftEnabled?: boolean;
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
  /**
   * Capacidades que a ORGANIZAÇÃO ligou (`capacidadesDaOrganizacao()`). Ausente
   * vale como nenhuma, pela mesma razão de `modulosLigados`.
   */
  capacidadesLigadas?: readonly CapacidadeDaOrganizacao[];
  /** Mutable signal — runtime checks after each step. */
  handoffSignal: RuntimeHandoffSignal;
  /**
   * O CONTATO que este turno atende, quando o turno é de uma conversa.
   *
   * No motor do agente, "lead" é o CONTATO (`job.contact_id`), e é esse id que o
   * modelo vê rotulado como lead. As ferramentas do catálogo chamam de
   * `lead_id` o NEGÓCIO (`crm_leads.id`). Medido em produção: o assistente
   * fechou um pedido e chamou `crm_update_lead` duas vezes com o id do contato
   * — as duas recusadas, e o pedido confirmado ficou sem valor. Com o contato
   * do turno à mão, esse id é traduzido para o negócio aberto dele.
   */
  contatoDoTurno?: string;
  /**
   * Servidor MCP externo REGISTRADO pela instalação, já com as ferramentas que
   * ele anunciou (#2147).
   *
   * Ausente = não existe servidor: o catálogo compilado continua sendo a
   * única fonte de tool do turno, sem nenhuma chamada de rede. Quem monta é
   * `carregarServidorMcpExterno`, ANTES daqui — descobrir é rede e este montador
   * é síncrono.
   */
  servidorMcpExterno?: {
    servidor: ServidorMcpExterno;
    ferramentas: readonly FerramentaRemota[];
  };
}

/**
 * `lead_id` que é o id do CONTATO do turno → o negócio ABERTO desse contato.
 *
 * Só o contato do turno, e só quando o negócio aberto é um só: com dois
 * abertos a escolha não é do runtime e o id segue como veio, para a recusa de
 * sempre. Quem recusa é o guarda abaixo, não `resolveActiveLeadForContact` —
 * ela só chama de ambíguo o EMPATE de atividade; fora dele, escolhe o mais
 * recente, e uma escrita (valor, ganho/perdido) cairia num cartão por palpite.
 * Falha de leitura também devolve o id intacto.
 */
export async function leadIdDoContatoDoTurno(
  supabase: SupabaseClient,
  organizationId: string,
  contatoDoTurno: string | undefined,
  leadId: unknown,
): Promise<string | null> {
  if (!contatoDoTurno || leadId !== contatoDoTurno) return null;
  const { data, error } = await supabase
    .from("crm_leads")
    .select("id, organization_id, pipeline_id, status, last_activity_at, created_at")
    .eq("organization_id", organizationId)
    .eq("contact_id", contatoDoTurno);
  if (error) return null;
  const candidatos = (data ?? []) as LeadCandidate[];
  if (candidatos.filter((l) => l.status === "open").length !== 1) return null;
  const r = resolveActiveLeadForContact(candidatos);
  return r.routed ? r.leadId : null;
}

/**
 * Uma ESCRITA do agente numa conversa só mira um negócio DO CONTATO desta
 * conversa.
 *
 * `leadIdDoContatoDoTurno`, logo acima, conserta a confusão contato × negócio.
 * Ficavam dois casos de fora, e o segundo é o que faz dano calado:
 *
 *  1. o id INVENTADO. Medido em produção (2026-09-15): o assistente ouviu "sim,
 *     já tenho os textos", chamou `crm_update_lead` com a chave certa e um
 *     `lead_id` que não existe em lugar nenhum. O escopo recusou, e a
 *     resposta do cliente se perdeu.
 *  2. o id REAL de OUTRO cliente, no mesmo funil. O escopo aprova (o funil é
 *     do agente), a escrita acontece, a auditoria grava sucesso — e o dado de
 *     um cliente vai para a ficha de outro, sem erro para ninguém investigar.
 *
 * A regra segue a de `leadIdDoContatoDoTurno`: o runtime não escolhe por
 * palpite. Um negócio deste contato segue como veio; fora dele, só se troca
 * quando o contato tem UM negócio aberto; com nenhum ou vários, recusa com o
 * motivo, em texto, para o modelo seguir a conversa.
 */
export async function negocioDaEscritaDoTurno(
  supabase: SupabaseClient,
  organizationId: string,
  contatoDoTurno: string,
  leadId: string,
): Promise<
  | { ok: true; leadId: string; trocado: boolean }
  | { ok: false; motivo: "indisponivel" | "sem_negocio" | "negocio_ambiguo"; mensagem: string }
> {
  const { data, error } = await supabase
    .from("crm_leads")
    .select("id, status")
    .eq("organization_id", organizationId)
    .eq("contact_id", contatoDoTurno);
  if (error) {
    // Falha de leitura nunca vira "não é seu negócio": o modelo leria como
    // veredito e pararia de tentar. Mesma disciplina do escopo de funil.
    return {
      ok: false,
      motivo: "indisponivel",
      mensagem: "não consegui conferir o negócio desta conversa agora; tente de novo.",
    };
  }
  const negocios = (data ?? []) as Array<{ id: string; status: string }>;
  if (negocios.some((n) => n.id === leadId)) return { ok: true, leadId, trocado: false };
  const abertos = negocios.filter((n) => n.status === "open");
  if (abertos.length === 1) return { ok: true, leadId: abertos[0]!.id, trocado: true };
  if (abertos.length === 0) {
    return {
      ok: false,
      motivo: "sem_negocio",
      mensagem: "esta pessoa ainda não tem um negócio aberto — siga a conversa normalmente.",
    };
  }
  return {
    ok: false,
    motivo: "negocio_ambiguo",
    mensagem:
      "esta pessoa tem mais de um negócio aberto e o id enviado não é de nenhum deles — " +
      "siga a conversa e deixe que alguém da equipe registre.",
  };
}

const HANDOFF_TOOL_NAME = "crm_request_human_handoff";
const DRAFT_PROPOSAL_TOOL_NAME = "crm_draft_proposal";
const PREPARAR_PROPOSTA_TOOL_NAME = "crm_preparar_proposta";

function shapeToZodObject(shape: Record<string, z.ZodTypeAny>): z.ZodTypeAny {
  // The MCP tool inputSchema is a Zod *raw shape* (object of zod types).
  //
  // Shape VAZIO vira registro livre, e não `z.object({})`: um servidor MCP
  // externo pode anunciar ferramenta sem `properties` (#2147), e `z.object({})`
  // faria o Zod DESCARTAR todo argumento antes do handler ver — a chamada
  // sairia vazia para o ERP, sem erro em lugar nenhum. Nenhuma tool compilada
  // tem shape vazio, então isto só muda o que é novo.
  if (Object.keys(shape).length === 0) return z.record(z.string(), z.unknown());
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
      if ("lead_id" in argsRecord) {
        const traduzido = await leadIdDoContatoDoTurno(
          input.supabase,
          input.ctx.organizationId,
          input.contatoDoTurno,
          argsRecord.lead_id,
        );
        if (traduzido) {
          logger.info("lead_id era o contato do turno — traduzido para o negócio aberto", {
            tool: def.name,
          });
          argsRecord.lead_id = traduzido;
        }
      }
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

        // ── DE QUE NEGÓCIO É ESTA ESCRITA — do contato da conversa ──────────
        //
        // Só ESCRITA: `crm_list_followups`, `crm_list_appointments` e irmãs têm
        // `lead_id` e são leituras; trocar ali faria o modelo perguntar por um
        // negócio e receber outro. Só com contato do turno — que o turno de
        // atendimento E o do Operador recebem (`operator-turn.ts` passa
        // `contactId: job.contact_id`): a rota HTTP e as automações seguem com o
        // `lead_id` de quem chamou. Antes do escopo, para o escopo julgar o
        // negócio que de fato vai ser escrito.
        //
        // A LEITURA não traduz — ela ESCOPA, e o faz no handler, com o
        // `ctx.contatoDoTurno` que passamos na chamada abaixo (#2158): trocar o
        // id mudaria a pergunta do modelo, escopar muda só quem a resposta
        // alcança. Quem recebe identificador de contato e é do turno segue
        // abrindo; quem é de outro cliente é recusado com o motivo em texto.
        if (
          input.contatoDoTurno &&
          def.category === "write" &&
          typeof argsRecord.lead_id === "string"
        ) {
          const alvo = await negocioDaEscritaDoTurno(
            input.supabase,
            input.ctx.organizationId,
            input.contatoDoTurno,
            argsRecord.lead_id,
          );
          if (!alvo.ok) {
            void auditMcpToolCall({
              ctx: input.ctx,
              toolName: def.name,
              args: argsAudit,
              durationMs: Date.now() - startedAt,
              success: false,
              errorMessage: `negocio_da_conversa:${alvo.motivo}`,
            });
            return { permitido: false, motivo: alvo.motivo, mensagem: alvo.mensagem };
          }
          if (alvo.trocado) {
            // Não é cosmético: é a única forma de saber que o modelo chuta, e
            // com que frequência.
            logger.info("lead_id fora do contato do turno — trocado pelo negócio aberto dele", {
              tool: def.name,
            });
            argsRecord.lead_id = alvo.leadId;
          }
        }

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

        // O contato do turno como CONTEXTO ao lado de `ctx.organizationId`, e
        // não como argumento que o modelo escreve: é o handler que precisa
        // saber com quem a conversa está, e quem sabe é o runtime. Injetado
        // aqui, no único ponto que tem `input`, para valer para todo chamador
        // de `pickToolsFromMcp` — quem não tem contato de turno (rota HTTP,
        // MCP externo, agente sem conversa) continua com o ctx de antes (#2158).
        const result = await def.handler(
          argsRecord as never,
          input.contatoDoTurno ? { ...input.ctx, contatoDoTurno: input.contatoDoTurno } : input.ctx,
        );

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

        // Recusa devolvida PELO HANDLER também não é sucesso (#2158): a ficha de
        // outro cliente recusada em `crm_get_contact` volta no mesmo formato da
        // recusa de escrita acima, e entra no audit como ela — `success: false`
        // e o motivo em `error` —, senão a recusa some contada como acerto.
        const recusa = recusaDoHandler(result);
        if (recusa !== null) {
          void auditMcpToolCall({
            ctx: input.ctx,
            toolName: def.name,
            args: argsAudit,
            durationMs: Date.now() - startedAt,
            success: false,
            errorMessage: `contato_da_conversa:${recusa}`,
          });
          return result;
        }

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

/** O `motivo` de uma recusa `{ permitido: false, motivo }` devolvida pelo handler, ou `null`. */
function recusaDoHandler(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const r = result as { permitido?: unknown; motivo?: unknown };
  return r.permitido === false && typeof r.motivo === "string" ? r.motivo : null;
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

    // Capacidade que a ORGANIZAÇÃO desligou: a ferramenta não é oferecida ao
    // modelo, mesmo marcada na versão do agente.
    if (deCapacidadeDesligada(def.name, input.capacidadesLigadas ?? [])) continue;

    // A chave da VERSÃO DO AGENTE manda nos dois sentidos: antes ela só
    // impedia o acréscimo automático, e a ferramenta vinda do pacote `vender`
    // passava com a chave desligada. Vale para o rascunho e para o preparo —
    // os dois andam juntos, nas mesmas condições.
    if (
      (def.name === DRAFT_PROPOSAL_TOOL_NAME || def.name === PREPARAR_PROPOSTA_TOOL_NAME) &&
      !input.proposalAiDraftEnabled
    )
      continue;

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

  // A ferramenta de rascunho entra sozinha quando a chave da versão está
  // ligada — o preparo vai junto, nas mesmas condições: sem ele o modelo não
  // tem como saber o que perguntar antes de rascunhar.
  if (input.proposalAiDraftEnabled) {
    for (const nome of [DRAFT_PROPOSAL_TOOL_NAME, PREPARAR_PROPOSTA_TOOL_NAME]) {
      if (deCapacidadeDesligada(nome, input.capacidadesLigadas ?? []) || result[nome]) continue;
      const tool = allTools.find((t) => t.name === nome);
      if (tool) {
        result[nome] = wrapMcpTool(tool, input);
      }
    }
  }

  // ── Servidor MCP externo registrado pela instalação (#2147) ──────────────
  //
  // Depois de tudo: as remotas somam às compiladas e nunca substituem nenhuma
  // (o nome colidindo é descartado lá em `definirFerramentasRemotas`, com o
  // motivo no log). Passam pelo MESMO `wrapMcpTool`, então auditoria, papel,
  // escopo e a devolução de texto em vez de exceção valem para elas.
  //
  // Fora dos filtros de `tool_ids`, módulo e capacidade de ORGANIZAÇÃO por
  // desenho: quem registra o servidor é a instalação, o endereço não vem de
  // pacote nenhum e o catálogo compilado não sabe que essas ferramentas
  // existem — filtrá-las por chave que só existe dentro dele as deixaria
  // invisíveis para sempre.
  if (input.servidorMcpExterno) {
    const ocupados = new Set(allTools.map((t) => t.name));
    const remotas = definirFerramentasRemotas(
      input.servidorMcpExterno.servidor,
      input.servidorMcpExterno.ferramentas,
      ocupados,
    );
    for (const def of remotas) {
      result[def.name] = wrapMcpTool(def, input);
    }
  }

  return result;
}
