/**
 * POST /api/v1/assistente/chat — um turno do assistente interno.
 *
 * Não-streaming de propósito (fase 1): a resposta vem com `atividade` (o que
 * ele consultou) e `propostas` (o que ele montou para confirmar). Leitura
 * executa na hora; escrita NUNCA acontece aqui — só na `/executar`, depois do
 * OK humano no botão Confirmar.
 *
 * Sem modelo (sem chave de IA na instalação nem binding da org): 503 com
 * `ai_indisponivel` — o chat cai para as regras locais e avisa. Chat morto
 * com spinner infinito seria pior que chat básico funcionando.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";
import { generateText, stepCountIs } from "ai";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { DEFAULT_BOT_MODEL } from "@/lib/ai/gateway";
import { resolverModeloDoPonto } from "@/lib/ai/gateway-binding";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { montarFerramentas, type PropostaMontada } from "@/lib/assistente/ferramentas";
import { SYSTEM_PROMPT_DO_ASSISTENTE } from "@/lib/assistente/prompt";
import type { LanguageModel } from "ai";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const mensagemSchema = z.object({
  papel: z.enum(["user", "assistente"]),
  texto: z.string().trim().min(1).max(2000),
});

const chatSchema = z.object({
  mensagens: z.array(mensagemSchema).min(1).max(30),
});

const ROTULO_DA_FERRAMENTA: Record<string, string> = {
  buscar_cliente: "buscou o cliente",
  buscar_produto: "consultou o catálogo",
  ver_pedidos: "listou pedidos",
  ver_pedido: "abriu o pedido",
  diagnosticar_nota: "diagnosticou a nota",
  ver_tarefas: "listou tarefas",
  ver_agenda: "consultou a agenda",
  listar_tipos_agenda: "listou tipos de compromisso",
  ver_funis: "listou funis",
  guia: "consultou o guia",
  propor_pedido: "montou o pedido",
  propor_nota: "montou a emissão",
  propor_tarefa: "montou a tarefa",
  propor_lead: "montou o negócio",
  propor_contato: "montou o cadastro",
  propor_agendamento: "montou o compromisso",
};

/**
 * Um turno isolado para o `generateText` inferir o ToolSet das ferramentas
 * passadas — sem esta fronteira, anotar o resultado com os genéricos padrão
 * quebra a atribuição.
 */
function rodarTurno(input: {
  model: LanguageModel;
  mensagens: { papel: "user" | "assistente"; texto: string }[];
  ferramentas: ReturnType<typeof montarFerramentas>;
}) {
  return generateText({
    model: input.model,
    system: SYSTEM_PROMPT_DO_ASSISTENTE,
    messages: input.mensagens.map((m) => ({
      role: m.papel === "user" ? ("user" as const) : ("assistant" as const),
      content: m.texto,
    })),
    tools: input.ferramentas,
    stopWhen: stepCountIs(8),
  });
}

export async function POST(req: NextRequest): Promise<Response> {  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "assistente" });
  if (!authz.ok) return authz.response;

  const parsed = chatSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Conversa inválida.", 422, { requestId });
  }

  const resolvido = await resolverModeloDoPonto("assistente", authz.org.orgId, DEFAULT_BOT_MODEL);
  if (!resolvido) {
    return fail("ai_indisponivel", "A IA está desligada — cadastre a chave em IA → Credenciais.", 503, {
      requestId,
    });
  }

  const supabase = await createClient();
  const ferramentas = montarFerramentas({
    organizationId: authz.org.orgId,
    userId: authz.user.id,
    role: authz.org.role,
    requestId,
    supabase,
    admin: createAdminClient(),
  });

  // Sem anotação de tipo no resultado: o `generateText` infere o ToolSet das
  // ferramentas passadas, e anotar com os genéricos padrão quebra a
  // atribuição (mesmo motivo de `lib/ai/runtime/agent.ts` não anotar).
  let resultado: Awaited<ReturnType<typeof rodarTurno>>;
  try {
    resultado = await rodarTurno({
      model: resolvido.model,
      mensagens: parsed.data.mensagens,
      ferramentas,
    });
  } catch (err) {
    logger.warn("[assistente] falha no modelo", {
      organization_id: authz.org.orgId,
      model_id: resolvido.modelId,
      motivo: err instanceof Error ? err.message : String(err),
    });
    return fail("ai_indisponivel", "Não consegui pensar agora. Tente de novo em instantes.", 503, {
      requestId,
    });
  }

  const atividade: { ferramenta: string; fez: string }[] = [];
  const propostas: (PropostaMontada & { id: string })[] = [];
  for (const passo of resultado.steps) {
    for (const chamada of passo.toolCalls) {
      atividade.push({
        ferramenta: chamada.toolName,
        fez: ROTULO_DA_FERRAMENTA[chamada.toolName] ?? "consultou o sistema",
      });
    }
    for (const r of passo.toolResults) {
      const valor = (r as { output?: unknown }).output as { proposta?: PropostaMontada } | undefined;
      if (valor && typeof valor === "object" && "proposta" in valor && valor.proposta) {
        propostas.push({ ...valor.proposta, id: randomUUID() });
      }
    }
  }

  return ok(
    {
      resposta: resultado.text,
      atividade,
      propostas,
      modelo: { id: resolvido.modelId, origem: resolvido.origem },
    },
    { requestId },
  );
}
