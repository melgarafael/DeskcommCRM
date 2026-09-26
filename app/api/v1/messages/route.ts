import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/messages — envia mensagem outbound (handler em ./_handler.ts).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { audit } from "@/lib/audit";
import { registrarTrocaDeComando } from "@/lib/inbox/atividade-de-comando";
import { resolveAuthDual } from "@/lib/api/auth-dual";
import { chaveDaRequisicao, comIdempotencia, type DesfechoIdempotente } from "@/lib/api/idempotency";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { roleAtLeast } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { JANELA_SEGUNDOS, TETO_DE_ESCRITA, TETO_POR_ORGANIZACAO } from "@/lib/mcp/rate-limit";
import {
  depsDoRitmo,
  registrarEnvioPorToken,
  segurarEnvioPorToken,
  type EnvioSegurado,
} from "@/lib/messaging/ritmo-do-envio-por-token";
import { sendMessageSchema, validateRequest, type SendMessageInput } from "@/lib/schemas";
import { conversaFicaComQuemAtendeu } from "@/lib/schemas/routing";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Message } from "@/lib/types/messaging";

import { sendMessageHandler } from "./_handler";

export const dynamic = "force-dynamic";

/**
 * Tag do endpoint no recibo de idempotência (#1613, item A). Muda de rota muda
 * de recibo — e o método entra na tag porque a MESMA rota com GET não guarda
 * envio nenhum.
 */
const ENDPOINT = "POST /api/v1/messages";
/** Escopo que o token precisa para enviar `on_behalf_of_user_id` (#1613, item C). */
const SCOPE_EM_NOME_DE = "messages:on_behalf";
/** Papel mínimo de quem é apontado "em nome de": atendente ou acima. */
const PAPEL_MINIMO_EM_NOME_DE = "agent";

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  // spec 13 §4: escrita é agent+ (viewer é read-only).
  //
  // Aceita sessão de navegador OU token de servidor (`dsk_…` com `mcp:write`),
  // porque esta rota é a porta de envio de quem não tem navegador: o gateway do
  // CRM que está sendo absorvido, e qualquer integração server-to-server. A org
  // nunca vem do corpo; no ramo do token ela sai da linha do token.
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "messages",
    role: "agent",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const { supabase, organizationId, actor, idioma } = authz;

  let input;
  try {
    input = await validateRequest(sendMessageSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const t = (texto: string) => traduzir(texto, idioma ?? "pt-BR");

  // Idempotency-Key, quando vem, tem de ser UUID — mesma régua de
  // `message-templates` e do contrato (spec 01 §7.3). Chave malformada não vira
  // recibo: recusar cedo é mais honesto que gravar lixo e devolver 201.
  const chave = chaveDaRequisicao(req);
  if (chave !== null && !z.string().uuid().safeParse(chave).success) {
    return fail("validation_error", "Idempotency-Key deve ser UUID", 400, { requestId });
  }

  /**
   * ─── Item C: autoria "em nome de" (#1613) ─────────────────────────────────
   *
   * O token é da organização, não de uma pessoa. Quando a mensagem foi
   * DECIDIDA por alguém no outro sistema, a conversa tem de guardar quem
   * decidiu — sem forjar autoria: o token continua sendo quem envia, e a
   * pessoa entra como "em nome de".
   *
   * Duas checagens, e nenhuma vem do corpo: o escopo mora na LINHA DO TOKEN e
   * o membership, no banco. Quem não tem escopo não grava nada; quem aponta
   * para usuário de outra organização, revogado ou abaixo de atendente não
   * passa daqui — e o handler ainda recusa alto se o campo chegar sem este
   * ctx, porque a mesma entrada atravessa o MCP (item B, fora deste PR).
   */
  let onBehalf: HandlerCtx["onBehalfOf"];
  if (input.on_behalf_of_user_id) {
    // A sessão do navegador não tem escopos — e não precisa: quem digita no
    // CRM já É a pessoa, e "em nome de" só existe para quem envia por token.
    if (authz.via !== "token" || !(authz.scopes ?? []).includes(SCOPE_EM_NOME_DE)) {
      return fail(
        "forbidden",
        t("Envio em nome de outro usuário exige o escopo messages:on_behalf."),
        403,
        { requestId },
      );
    }

    // Membro ATIVO desta organização com papel de atendente ou acima. A org
    // vem da linha do token, então usuário de OUTRA organização não é nem
    // encontrado — a pergunta "é daqui?" já está no filtro. `roleAtLeast` não
    // decide o gate da rota (isso foi `requireRole` lá em cima): é a régua do
    // ALVO, a mesma que as rotas usam para regra extra sobre um role já
    // resolvido.
    const { data: membro, error: erroDeMembro } = await supabase
      .from("user_organizations")
      .select("user_id, role, revoked_at")
      .eq("organization_id", organizationId)
      .eq("user_id", input.on_behalf_of_user_id)
      .is("revoked_at", null)
      .maybeSingle();
    if (erroDeMembro) {
      return fail(
        "internal_error",
        t("Não foi possível ler o membro apontado em on_behalf_of_user_id."),
        500,
        { requestId },
      );
    }
    const papel = (membro as { role?: string } | null)?.role;
    if (!papel || !roleAtLeast(papel, PAPEL_MINIMO_EM_NOME_DE)) {
      return fail(
        "forbidden",
        t("on_behalf_of_user_id precisa apontar para um atendente ativo desta organização."),
        403,
        { requestId },
      );
    }

    // Os dois NOMES são lidos aqui, no servidor, para irem gravados na linha
    // junto da autoria: o balão desenha "Fulano · via {token}" sem join, e um
    // nome que o balão tivesse de buscar seria um nome que ele não mostra.
    // São enfeite — se a leitura falhar, a autoria continua na coluna.
    const tokenId =
      actor.type === "api_token"
        ? actor.id
        : actor.type === "ai_agent"
          ? (actor.api_token_id ?? actor.id)
          : null;
    const [usuario, linhaDoToken] = await Promise.all([
      supabase.auth.admin.getUserById(input.on_behalf_of_user_id).catch(() => null),
      // O builder do PostgREST é thenable, mas o TIPO dele não declara
      // `.catch` — o envolvimento tem de ser por fora. E é enfeite: se a
      // leitura falhar, a autoria continua gravada na coluna, e o balão cai
      // para o rótulo de sempre.
      Promise.resolve(
        supabase
          .from("api_tokens")
          .select("name")
          .eq("id", tokenId ?? "")
          .eq("organization_id", organizationId)
          .maybeSingle(),
      ).then(
        (r) => r,
        () => null,
      ),
    ]);
    onBehalf = {
      userId: input.on_behalf_of_user_id,
      userName: (usuario?.data.user?.user_metadata?.full_name as string | undefined) ?? null,
      tokenName: (linhaDoToken?.data as { name?: string } | null)?.name ?? null,
    };
  }

  /**
   * O efeito — o envio de verdade, e a ÚNICA coisa que a idempotência protege.
   *
   * O freio de chamadas do token mora DENTRO dele, e não antes: uma
   * RETENTATIVA com a mesma chave não envia nada, e portanto não pode gastar
   * cota nem levar 429 no lugar do recibo — a promessa da chave é devolver a
   * MESMA resposta, e um contador de chamada que não aconteceu seria mentira.
   * Sem chave, o caminho é o de sempre: uma checagem por requisição, depois
   * de validar o corpo, como dava antes de existir chave nenhuma.
   */
  const enviar = async (): Promise<Message> => {
    // Por token, esta rota é a mesma porta de escrita do MCP — e leva o mesmo
    // teto por token e agregado por organização (`lib/mcp/rate-limit.ts`, #1491).
    // Pela sessão do navegador não há teto: quem digita é uma pessoa.
    if (authz.via === "token") {
      const tokenId = actor.type === "ai_agent" ? (actor.api_token_id ?? actor.id) : actor.id;
      const teto = await checkRateLimit(`messages:tok:${tokenId}`, TETO_DE_ESCRITA, JANELA_SEGUNDOS);
      if (!teto.allowed) {
        throw new ApiError(429, "rate_limited", { retry_after_seconds: JANELA_SEGUNDOS }, requestId, "Too many requests.");
      }

      const tetoOrg = await checkRateLimit(
        `messages:org:${organizationId}`,
        TETO_POR_ORGANIZACAO,
        JANELA_SEGUNDOS,
      );
      if (!tetoOrg.allowed) {
        throw new ApiError(
          429,
          "rate_limited",
          { retry_after_seconds: JANELA_SEGUNDOS },
          requestId,
          "Too many requests for organization.",
        );
      }
    }

    // Freio anti-ban do número (espaçamento + teto diário), só para token:
    // ver o cabeçalho de `lib/messaging/ritmo-do-envio-por-token.ts`.
    const ritmo = authz.via === "token" ? await depsDoRitmo(createAdminClient()) : null;
    const segurado: EnvioSegurado = ritmo
      ? await segurarEnvioPorToken(ritmo, {
          organizationId,
          conversationId: (input as SendMessageInput).conversation_id,
          requestId,
        })
      : null;

    const message = await sendMessageHandler(
      supabase,
      {
        organization_id: organizationId,
        actor,
        requestId,
        idioma,
        // Só chega aqui com o escopo e o membership já validados acima; o
        // handler recusa se `on_behalf_of_user_id` vier sem este ctx (#1613).
        ...(onBehalf ? { onBehalfOf: onBehalf } : {}),
      },
      input as SendMessageInput,
    );
    // Uma resposta humana pelo inbox assume uma conversa livre — SÓ quando a
    // empresa ligou "a conversa fica com quem atendeu" (settings.routing,
    // desligado por padrão). A RPC faz o claim condicional e registra a troca
    // de dono na mesma transação; se outro atendente chegou primeiro, não
    // tomamos a conversa dele. O envio já pode ter sido aceito pelo canal,
    // portanto falha do claim nunca vira erro de envio (o operador poderia
    // reenviar e duplicar a mensagem).
    if (authz.via === "session" && actor.type === "user" && message.status !== "failed") {
      try {
        const { data: org, error: orgError } = await supabase
          .from("organizations")
          .select("settings")
          .eq("id", organizationId)
          .maybeSingle();
        if (orgError) throw orgError;
        if (conversaFicaComQuemAtendeu(org?.settings)) {
          const { data: claimed, error: claimError } = await supabase.rpc("fn_conversation_assign", {
            p_organization_id: organizationId,
            p_conversation_id: message.conversation_id,
            p_to_user_id: actor.id,
            p_reason: "claim",
            p_enforce_expected: true,
          });
          if (claimError) throw claimError;
          if (claimed?.[0]) {
            await audit({
              action: "conversation.claimed",
              actorUserId: actor.id,
              organizationId,
              resourceType: "conversation",
              resourceId: message.conversation_id,
              requestId,
            });
            // A mesma linha na linha do tempo que o botão Assumir deixa: sem ela,
            // a conversa mudaria de dono sem nenhum registro à vista de quem atende.
            await registrarTrocaDeComando({
              supabase,
              organizationId,
              conversationId: message.conversation_id,
              contactId: (claimed[0] as { contact_id: string | null }).contact_id,
              tipo: "conversation_claimed",
              actor,
              motivo: "Assumiu o atendimento desta conversa",
            });
            // O mesmo evento que o botão Assumir emite.
            const { error: emitErr } = await supabase.rpc("emit_event", {
              p_event_type: "conversation.claimed",
              p_entity_kind: "conversation",
              p_entity_id: message.conversation_id,
              p_payload: { assigned_to_user_id: actor.id },
              p_metadata: { request_id: requestId },
              p_organization_id: organizationId,
            });
            if (emitErr) console.error("[messages.send] emit_event failed", emitErr.message);
          }
        }
      } catch (claimError) {
        console.error("[messages.send] claim after reply failed", claimError);
      }
    }
    if (ritmo) await registrarEnvioPorToken(ritmo, organizationId, segurado, message.status);
    return message;
  };

  try {
    // ─── Item A: idempotência (#1613) ────────────────────────────────────────
    //
    // Sem chave, o caminho é o de sempre: envia, sem recibo nenhum — é o caso
    // que impede o conserto degenerado de "exigir chave sempre", que
    // quebraria todo chamador atual. Com chave, o helper reserva ANTES do
    // efeito (`lib/api/idempotency.ts`, migration 0321), então uma retentativa
    // devolve o recibo gravado sem reenviar, e a mesma chave com corpo
    // DIFERENTE vira 409: a chave é que está errada, não o pedido.
    const desfecho: DesfechoIdempotente<Message> =
      chave === null
        ? { tipo: "executou", resposta: await enviar(), status: 201 }
        : await comIdempotencia({
            db: supabase,
            organizationId,
            endpoint: ENDPOINT,
            chave,
            // O corpo VALIDADO define a identidade da operação.
            corpo: input,
            executar: async () => ({ resposta: await enviar(), status: 201 }),
          });

    if (desfecho.tipo === "conflito") {
      return fail(
        "idempotency_conflict",
        t("Esta chave de idempotência já foi usada com outro conteúdo."),
        409,
        { requestId },
      );
    }
    // Mesma chave, MESMO corpo, primeira execução ainda em curso: a chave está
    // reservada e a resposta ainda não existe. Código próprio, e não
    // `idempotency_conflict`: aqui a chave está CERTA e retentar resolve.
    if (desfecho.tipo === "em_curso") {
      return fail(
        "idempotency_in_progress",
        t("A mesma requisição ainda está em curso. Tente de novo em instantes."),
        409,
        { requestId },
      );
    }

    // 201, e não `desfecho.status`: o efeito desta rota termina sempre em 201
    // (a mensagem aceita) e é esse número que o recibo guarda — o replay
    // responde 201 também, que é a MESMA resposta da primeira chamada.
    return ok(desfecho.resposta, { status: 201, requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      const retryAfter = (err.details as { retry_after_seconds?: number } | undefined)
        ?.retry_after_seconds;
      return fail(err.code, err.message, err.status, {
        requestId,
        // `details` saía SÓ no 429, e a recusa da janela (#1614) é um 422 que
        // PROMETE detalhe: `use: "template"` e a última mensagem do cliente
        // são a resposta inteira para quem integra. Repassar o que existe não
        // muda resposta nenhuma anterior — os outros `ApiError` desta rota
        // chamam o construtor com `details: undefined`.
        ...(err.details !== undefined
          ? { details: err.details as Record<string, unknown> }
          : {}),
        ...(err.status === 429 && retryAfter
          ? {
              headers: { "Retry-After": String(retryAfter) },
            }
          : {}),
      });
    }
    throw err;
  }
}
