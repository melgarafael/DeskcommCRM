/**
 * `/api/v1/agenda/agendamentos` — a rota, FINA.
 *
 * Ela faz três coisas e nenhuma delas é regra: autentica, valida a forma do
 * corpo, e traduz o resultado (ou o `ApiError`) em resposta HTTP. A decisão mora
 * em `_handler.ts`, e a razão é que uma ferramenta MCP não chama rota Next — não
 * há `request`, não há cookie, e a rota devolve `Response` em vez de dado. Rota
 * e tool chamam a MESMA função, e nenhuma das duas reimplementa a decisão.
 *
 * Piso `agent` nos três verbos: marcar, remarcar e cancelar são mutação, e quem
 * só olha a agenda não muda nada nela.
 */
import { randomUUID } from "node:crypto";

import { type NextRequest } from "next/server";
import { z } from "zod";

import { listaAgendamentos, type AgendamentoListado } from "@/lib/agenda/consulta";
import { fail, ok } from "@/lib/api/wrappers";
import { logger } from "@/lib/logger";

/**
 * O que ESTA ROTA devolve — o contrato da lista mais a ORIGEM.
 *
 * `AgendamentoListado` não tem origem de propósito: ela é o contrato que a
 * ferramenta MCP do agente também consome, e lá só existe uma origem possível.
 * A tela precisa distinguir, porque bloco vindo do Google não abre, não arrasta
 * e não se clica.
 */
type AgendamentoDaResposta = AgendamentoListado & { origem?: "google_sync" };
import { ApiError } from "@/lib/api/types";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

import {
  alterarAgendamentoHandler,
  cancelarAgendamentoHandler,
  marcarAgendamentoHandler,
} from "./_handler";

const listarSchema = z.object({
  contact_id: z.string().uuid().optional(),
  lead_id: z.string().uuid().optional(),
  owner_user_id: z.string().uuid().optional(),
  dia: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  de: z.string().datetime({ offset: true }).optional(),
  ate: z.string().datetime({ offset: true }).optional(),
  situacao: z.enum(["pending", "confirmed", "cancelled", "completed", "no_show"]).optional(),
  limite: z.coerce.number().int().min(1).max(500).optional(),
});

const marcarSchema = z.object({
  event_type_id: z.string().uuid(),
  starts_at: z.string().datetime({ offset: true }),
  owner_user_id: z.string().uuid().optional(),
  contact_id: z.string().uuid().optional(),
  title: z.string().min(1).max(200).optional(),
  notes: z.string().max(2000).optional(),
});

const alterarSchema = z
  .object({
    id: z.string().uuid(),
    /** Remarcar: o novo início. A duração vem do tipo, como na criação. */
    starts_at: z.string().datetime({ offset: true }).optional(),
    /**
     * `rescheduled` NÃO entra aqui: remarcar se pede mandando `starts_at`, e é
     * movimento próprio — não uma situação que se escolhe.
     */
    status: z.enum(["confirmed", "completed", "no_show"]).optional(),
    notes: z.string().max(2000).optional(),
  })
  .refine((c) => c.starts_at !== undefined || c.status !== undefined || c.notes !== undefined, {
    message: "Informe pelo menos um campo para alterar.",
  });

const cancelarSchema = z.object({
  id: z.string().uuid(),
  /**
   * ⚠️ OBRIGATÓRIO, e não é burocracia: é o que a equipe lê ao ver o horário
   * vago. "Cancelado" sem motivo faz alguém ligar para o cliente perguntando o
   * que houve — ou, pior, não ligar.
   */
  reason: z.string().min(3).max(500),
});

/**
 * GET — o que a grade desenha.
 *
 * ⚠️ RECORTE OBRIGATÓRIO, herdado de `listaAgendamentos` de propósito. Sem ele a
 * consulta varreria a agenda inteira da organização, e a recusa vem com ENSINO
 * em vez de lista vazia: vazio faria a tela dizer "nada marcado" quando a
 * verdade é que a pergunta não tinha alvo. A régua é do MaestroConexoes, e vale
 * igual para a tela e para a IA.
 *
 * O recorte que a grade usa é `de`+`ate`, em INSTANTES. A tela é semanal e
 * mensal (seis semanas), então o filtro por `dia` não a serve — e ele tem um
 * corte em UTC que, para fuso negativo, não é o dia de quem olha: medido para
 * São Paulo, o "dia 12" pega três horas do dia 11 e perde as três últimas do 12.
 * Mandando instante, quem chama calcula os limites no fuso de APRESENTAÇÃO e
 * esta rota não precisa adivinhar em que fuso o dia foi pedido.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  // `viewer`: olhar a agenda é o menor privilégio desta feature.
  const authz = await requireRole("viewer", { requestId, resource: "agenda" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const url = new URL(req.url);
  const parsed = listarSchema.safeParse({
    contact_id: url.searchParams.get("contact_id") ?? undefined,
    lead_id: url.searchParams.get("lead_id") ?? undefined,
    owner_user_id: url.searchParams.get("owner_user_id") ?? undefined,
    dia: url.searchParams.get("dia") ?? undefined,
    de: url.searchParams.get("de") ?? undefined,
    ate: url.searchParams.get("ate") ?? undefined,
    situacao: url.searchParams.get("situacao") ?? undefined,
    limite: url.searchParams.get("limite") ?? undefined,
  });
  if (!parsed.success) {
    return fail("validation_failed", "Consulta inválida.", 422, {
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
      requestId,
    });
  }

  const supabase = await createClient();
  const resultado = await listaAgendamentos(supabase, activeOrg.orgId, {
    contactId: parsed.data.contact_id ?? null,
    leadId: parsed.data.lead_id ?? null,
    ownerUserId: parsed.data.owner_user_id ?? null,
    dia: parsed.data.dia ?? null,
    de: parsed.data.de ?? null,
    ate: parsed.data.ate ?? null,
    situacao: parsed.data.situacao ?? null,
    limite: parsed.data.limite ?? 200,
  });

  if (!resultado.ok) {
    return fail(
      resultado.codigo === "sem_alvo" ? "agenda_listagem_sem_recorte" : "internal_error",
      resultado.motivoParaOperador,
      resultado.codigo === "sem_alvo" ? 422 : 500,
      { requestId },
    );
  }

  // ─── A OCUPAÇÃO DO GOOGLE ENTRA AQUI, e não em `listaAgendamentos` ────────
  //
  // O defeito, medido em produção em 2026-09-01: 114 eventos vindos do Google no
  // banco, 1 deles na semana desenhada, e a tela mostrando a agenda vazia.
  //
  // O servidor SEMEAVA os externos (`app/app/agenda/page.tsx`), e o cliente os
  // jogava fora: `agendamentosVivos ?? semente` — assim que este GET responde,
  // ele SUBSTITUI a semente inteira, e esta rota nunca devolveu ocupação. Em
  // visão Mês nem a semente sobrevive, porque o recorte muda e o fallback é `[]`.
  // Resultado: o bloco aparecia no primeiro instante da semana corrente e sumia.
  //
  // ⚠️ POR QUE NÃO DENTRO DE `listaAgendamentos`. Aquela função é compartilhada
  // com a ferramenta MCP do agente de IA (`lib/mcp/tools/agendamento.ts`). Pôr
  // "Ocupado" na resposta dela faria o agente enxergar compromisso onde há um
  // bloco anônimo do Google — e falar sobre ele com o cliente. A tela precisa da
  // ocupação; o agente, não. Fontes diferentes para consumidores diferentes.
  //
  // Falha aqui NÃO derruba a listagem: sem ocupação a grade fica pobre; sem
  // agendamento ela fica errada. São consequências de tamanhos diferentes.
  const externos: AgendamentoDaResposta[] = [];
  if (parsed.data.de && parsed.data.ate) {
    const { data: ocupacao, error: erroOcupacao } = await supabase
      .from("calendar_external_events")
      .select("id, starts_at, ends_at, calendar_connections!inner(user_id)")
      .eq("organization_id", activeOrg.orgId)
      .gte("starts_at", parsed.data.de)
      .lt("starts_at", parsed.data.ate)
      // `transparent` no Google é "livre": existe e não ocupa. Mesmo filtro que
      // a semente do servidor já aplicava — a regra é uma só.
      .neq("transparency", "transparent")
      .neq("status", "cancelled")
      .order("starts_at");

    if (erroOcupacao) {
      logger.warn("[agenda.agendamentos] ocupação do Google não veio", {
        erro: erroOcupacao.message,
        requestId,
      });
    }
    for (const e of ocupacao ?? []) {
      const conexao = e.calendar_connections as { user_id: string } | { user_id: string }[] | null;
      const dono = Array.isArray(conexao) ? conexao[0]?.user_id : conexao?.user_id;
      externos.push({
        id: e.id,
        // Rótulo, NUNCA o título do evento: a tabela guarda o `title` e esta
        // resposta não o lê. Despejar o conteúdo da agenda pessoal na tela de
        // trabalho é o que a consulta da semente também recusa.
        titulo: "Ocupado",
        donoId: dono ?? null,
        iniciaEm: e.starts_at,
        terminaEm: e.ends_at,
        situacao: "confirmed",
        // Os três abaixo existem para satisfazer o contrato da lista, e são
        // vazios porque ocupação do Google não tem nenhum deles: o fuso vive na
        // conexão, e contato é coisa de agendamento nosso. Preenchê-los com
        // invenção faria a tela mostrar dado que não existe.
        fuso: "",
        contatoId: null,
        contatoNome: null,
        origem: "google_sync",
      });
    }
  }

  return ok([...resultado.agendamentos, ...externos], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  return despachar(req, marcarSchema, marcarAgendamentoHandler, 201);
}

export async function PATCH(req: NextRequest): Promise<Response> {
  return despachar(req, alterarSchema, alterarAgendamentoHandler, 200);
}

export async function DELETE(req: NextRequest): Promise<Response> {
  return despachar(req, cancelarSchema, cancelarAgendamentoHandler, 200);
}

/**
 * O caminho comum dos três verbos: papel, forma, handler, tradução.
 *
 * Um só, e não três cópias, porque a diferença entre eles é o schema e a função
 * — o resto é idêntico, e três cópias divergiriam no primeiro ajuste, que é
 * exatamente o defeito que a extração do handler veio consertar.
 */
async function despachar<T>(
  req: NextRequest,
  schema: z.ZodType<T>,
  handler: (
    supabase: Awaited<ReturnType<typeof createClient>>,
    ctx: { organization_id: string; actor: { type: "user"; id: string }; requestId: string },
    input: T,
  ) => Promise<Record<string, unknown>>,
  status: 200 | 201,
): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("agent", { requestId, resource: "agenda" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg, user } = authz;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      details: (parsed.error as z.ZodError).flatten().fieldErrors as Record<string, unknown>,
      requestId,
    });
  }

  const supabase = await createClient();
  try {
    const resultado = await handler(
      supabase,
      {
        // A organização vem do COOKIE VALIDADO, nunca do corpo. Pela tool, ela
        // vem do contexto do agente — e é por isso que o handler a recebe como
        // parâmetro em vez de resolvê-la sozinho.
        organization_id: activeOrg.orgId,
        actor: { type: "user", id: user.id },
        requestId,
      },
      parsed.data,
    );
    return ok(resultado, { requestId, status });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }
}
