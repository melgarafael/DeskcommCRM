import { requireSupportWrite } from "@/lib/impersonate/support";
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
import { donosDaAgenda } from "@/lib/agenda/donos-da-agenda";
import { lerOcupacaoExterna } from "@/lib/agenda/ocupacao-externa";
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
import { resolveAuthDual } from "@/lib/api/auth-dual";
import type { Actor } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";

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

/**
 * O e-mail do convidado — opcional, e a string VAZIA é significativa.
 *
 * Vazio não é "não mandou": é "apague o que estava lá". O formulário devolve
 * `""` quando a pessoa limpa o campo, e sem este ramo não haveria como
 * DESCONVIDAR alguém pela tela — só editando o banco à mão.
 *
 * O `preprocess` apara antes de decidir, então um campo com espaços cai no ramo
 * do vazio em vez de virar recusa de formato — quem apagou o texto e deixou um
 * espaço para trás quis limpar, não errar.
 *
 * 320 é o teto do RFC 5321 (64 da parte local + @ + 255 do domínio). Não é
 * enfeite: sem teto, um campo de texto livre entra inteiro no corpo que vai ao
 * Google, e a recusa viria de lá, em inglês e sem apontar o campo.
 */
const emailDoConvidado = z.preprocess(
  (v) => (typeof v === "string" ? v.trim() : v),
  z.union([z.literal(""), z.string().email().max(320)]),
);

const marcarSchema = z.object({
  event_type_id: z.string().uuid(),
  starts_at: z.string().datetime({ offset: true }),
  owner_user_id: z.string().uuid().optional(),
  contact_id: z.string().uuid().optional(),
  conversation_id: z.string().uuid().optional(),
  title: z.string().min(1).max(200).optional(),
  notes: z.string().max(2000).optional(),
  description: z.string().max(2000).optional(),
  location_details: z.string().max(300).optional(),
  guest_email: emailDoConvidado.optional(),
});

const alterarSchema = z
  .object({
    id: z.string().uuid(),
    revision: z.number().int().positive().optional(),
    outcome_message_id: z.string().uuid().optional(),
    confirmation_next_at: z.string().datetime({ offset: true }).optional(),
    /** Remarcar: o novo início. A duração vem do tipo, como na criação. */
    starts_at: z.string().datetime({ offset: true }).optional(),
    /**
     * `rescheduled` NÃO entra aqui: remarcar se pede mandando `starts_at`, e é
     * movimento próprio — não uma situação que se escolhe.
     */
    status: z.enum(["confirmed", "completed", "no_show"]).optional(),
    notes: z.string().max(2000).optional(),
    guest_email: emailDoConvidado.optional(),
  })
  .refine(
    (c) =>
      c.confirmation_next_at !== undefined ||
      c.starts_at !== undefined ||
      c.status !== undefined ||
      c.notes !== undefined ||
      c.guest_email !== undefined,
    {
      message: "Informe pelo menos um campo para alterar.",
    },
  );

const cancelarSchema = z.object({
  id: z.string().uuid(),
  revision: z.number().int().positive().optional(),
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
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
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
    return fail("validation_failed", t("Consulta inválida."), 422, {
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
    // ⚠️ DUAS DAS TRÊS RECUSAS SÃO ERRO DE QUEM CHAMA — e o `else` de antes
    // chamava todas de falha do servidor.
    //
    // `sem_alvo` (falta recorte) e `alvo_nao_e_lead` (o `lead_id` veio com o id
    // de um CONTATO — a confusão medida em #509) são consulta malformada: o
    // servidor está inteiro, e 500 diz ao cliente server-to-server que a culpa é
    // nossa. Pior: acorda o Sentry por requisição malformada, que é ruído.
    //
    // O mapa é explícito — mesmo desenho de `CODIGO_DA_RECUSA` em `_handler.ts`
    // — porque status e código andam juntos, e a indexação pelo código faz o
    // compilador reclamar se `consulta.ts` ganhar uma recusa sem desfecho aqui.
    const recusa = {
      sem_alvo: { status: 422, code: "agenda_listagem_sem_recorte" },
      alvo_nao_e_lead: { status: 422, code: "agenda_listagem_alvo_nao_e_lead" },
      erro_interno: { status: 500, code: "internal_error" },
    } as const;
    const { status, code } = recusa[resultado.codigo];
    return fail(code, t(resultado.motivoParaOperador), status, { requestId });
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
    // Leitura ÚNICA da ocupação da tela (`lib/agenda/ocupacao-externa`): a
    // semente do servidor faz a MESMA pergunta e recebe a MESMA resposta. A
    // regra — recorte por INTERSEÇÃO de intervalos, como no motor de
    // disponibilidade — mora num lugar só (#525).
    // A ocupação é perguntada POR DONO (`p_owner`): sem a lista, o Atendente só
    // recebia a ocupação de quem a RLS da sessão deixava ver — isto é, a dele —
    // e a grade desenhava livre o horário que o Google da dona já ocupa (#896,
    // item 3). `organization_id` continua vindo do cookie validado; os donos são
    // membros DESSA organização, com filtro explícito (mesmo caminho de
    // `app/api/v1/agenda/pessoas/route.ts`).
    const { donos, erro: erroDosDonos } = await donosDaAgenda(activeOrg.orgId);
    if (erroDosDonos) {
      logger.warn("[agenda.agendamentos] donos da agenda não vieram", {
        erro: erroDosDonos,
        requestId,
      });
    }

    const { blocos, erro } = await lerOcupacaoExterna(
      supabase,
      {
        organizationId: activeOrg.orgId,
        de: parsed.data.de,
        ate: parsed.data.ate,
      },
      donos,
    );

    if (erro) {
      logger.warn("[agenda.agendamentos] ocupação do Google não veio", {
        erro,
        requestId,
      });
    }
    for (const e of blocos) {
      externos.push({
        id: e.id,
        // Rótulo, NUNCA o título do evento: a tabela tem a coluna `title` e esta
        // resposta não o lê. Despejar o conteúdo da agenda pessoal na tela de
        // trabalho é o que a consulta da semente também recusa.
        titulo: "Ocupado",
        donoId: e.donoId,
        iniciaEm: e.iniciaEm,
        terminaEm: e.terminaEm,
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
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  return despachar(req, marcarSchema, marcarAgendamentoHandler, 201);
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  return despachar(req, alterarSchema, alterarAgendamentoHandler, 200);
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  return despachar(req, cancelarSchema, cancelarAgendamentoHandler, 200);
}

/**
 * O caminho comum dos três verbos: identidade, forma, handler, tradução.
 *
 * Um só, e não três cópias, porque a diferença entre eles é o schema e a função
 * — o resto é idêntico, e três cópias divergiriam no primeiro ajuste, que é
 * exatamente o defeito que a extração do handler veio consertar.
 *
 * Aceita sessão de navegador OU token de servidor (`dsk_…` com `mcp:write`),
 * mesma dualidade de `/api/v1/messages` e `/api/v1/leads/[id]`: a integração de
 * monitoramento processual marca a audiência/perícia por aqui, sem navegador.
 * `_handler.ts` já esperava `Actor` completo (é a mesma função que a tool MCP
 * chama) — só a rota restringia o tipo a `{type:"user"}` antes desta troca.
 *
 * ⚠️ Token de servidor sem o scope `actor:ai_agent` vira `actor.type ===
 * "api_token"` (`lib/mcp/auth.ts`, `deriveActor`), e `podeMarcarForaDaGrade`
 * só libera `"user"` para marcar fora da grade de disponibilidade. Uma
 * audiência que o juiz marcou não respeita a agenda do advogado — se a
 * integração precisar disso, é decisão de produto a abrir (ampliar
 * `podeMarcarForaDaGrade`), não algo para contornar aqui.
 */
async function despachar<T>(
  req: NextRequest,
  schema: z.ZodType<T>,
  handler: (
    supabase: Awaited<ReturnType<typeof createClient>>,
    ctx: { organization_id: string; actor: Actor; requestId: string },
    input: T,
  ) => Promise<Record<string, unknown>>,
  status: 200 | 201,
): Promise<Response> {
  const requestId = randomUUID();

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "agenda",
    role: "agent",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  // `idioma` só vem no ramo de sessão (`resolveAuthDual`); o ramo de token não
  // tem preferência de idioma de pessoa nenhuma — degrada para o padrão.
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const { supabase, organizationId, actor } = authz;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      details: (parsed.error as z.ZodError).flatten().fieldErrors as Record<string, unknown>,
      requestId,
    });
  }

  try {
    const resultado = await handler(
      supabase,
      {
        // A organização vem do COOKIE VALIDADO ou da LINHA DO TOKEN, nunca do
        // corpo. Pela tool MCP nativa, ela vem do contexto do agente.
        organization_id: organizationId,
        actor,
        requestId,
      },
      parsed.data,
    );
    return ok(resultado, { requestId, status });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, t(err.message), err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }
}
