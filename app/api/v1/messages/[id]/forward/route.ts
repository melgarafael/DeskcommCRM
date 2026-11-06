/**
 * POST /api/v1/messages/[id]/forward — encaminha uma mensagem para outra
 * conversa da organização (#2835).
 *
 * ─── Curta de propósito: o trabalho mora em `lib/inbox/encaminhar-mensagem` ──
 *
 * A rota só faz o que é papel de rota: autentica, valida entrada, monta o
 * `HandlerCtx` e traduz o desfecho. O CORAÇÃO — ler a origem, recusar destino
 * sem canal, e mandar o conteúdo pelo MESMO caminho de envio do Inbox
 * (`sendMessageHandler`) — está no módulo, para ser testável sem subir um
 * Route Handler. A prova de que o caminho é o mesmo é o spy do handler no
 * teste, não esta rota.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { chaveDaRequisicao, comIdempotencia, type DesfechoIdempotente } from "@/lib/api/idempotency";
import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { encaminharMensagem } from "@/lib/inbox/encaminhar-mensagem";
import { createClient } from "@/lib/supabase/server";
import type { Message } from "@/lib/types/messaging";

interface Ctx {
  params: Promise<{ id: string }>;
}

const ENDPOINT = "POST /api/v1/messages/[id]/forward";

/** O corpo: só a conversa de destino. O conteúdo vem da mensagem de origem. */
const corpoSchema = z.object({ conversation_id: z.string().uuid() });

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  // Escrita é agent+ — a MESMA régua de `POST /api/v1/messages` (quem pode
  // enviar pode encaminhar; encaminhar é enviar).
  const authz = await requireRole("agent", { requestId, resource: "messages" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return fail("validation_failed", t("Dados inválidos."), 422, { requestId });
  }

  let corpo: z.infer<typeof corpoSchema>;
  try {
    corpo = corpoSchema.parse(await req.json());
  } catch {
    return fail("validation_failed", t("Escolha uma conversa de destino."), 422, { requestId });
  }

  // O `apiClient` carimba Idempotency-Key em todo POST — mas sorteia uma chave
  // NOVA quando nenhuma vem (`lib/api/client.ts`: `opts.idempotencyKey ??
  // randomId()`). Sem chave ESTÁVEL, dois cliques chegavam aqui como duas
  // chaves e o `comIdempotencia` abaixo não reconhecia repetição nenhuma. Quem
  // garante a estabilidade é `hooks/inbox/useEncaminharMensagem.ts`: uma chave
  // por INTENÇÃO (mensagem + destino), guardada em ref e reusada na retentativa
  // de rede — e o mesmo ref barra o segundo clique antes do POST. Mesma régua
  // de `POST /api/v1/messages`: chave, quando vem, é UUID.
  const chave = chaveDaRequisicao(req);
  if (chave !== null && !z.string().uuid().safeParse(chave).success) {
    return fail("validation_error", "Idempotency-Key deve ser UUID", 400, { requestId });
  }

  const supabase = await createClient();
  const encaminhar = () =>
    encaminharMensagem(
      supabase,
      {
        organization_id: authz.org.orgId,
        actor: { type: "user", id: authz.user.id },
        requestId,
        idioma: authz.user.idioma,
      },
      // A rota é de SESSÃO (navegador): é o que permite a regra "a conversa
      // fica com quem atendeu" valer no encaminhamento, como no envio.
      { messageId: id, conversationIdDestino: corpo.conversation_id, via: "session" },
    );
  try {
    const desfecho: DesfechoIdempotente<Message> =
      chave === null
        ? { tipo: "executou", resposta: await encaminhar(), status: 201 }
        : await comIdempotencia({
            db: supabase,
            organizationId: authz.org.orgId,
            endpoint: ENDPOINT,
            chave,
            // A mensagem de origem vem do path: ela faz parte da identidade.
            corpo: { message_id: id, conversation_id: corpo.conversation_id },
            executar: async () => ({ resposta: await encaminhar(), status: 201 }),
          });

    if (desfecho.tipo === "conflito") {
      return fail(
        "idempotency_conflict",
        t("Esta chave de idempotência já foi usada com outro conteúdo."),
        409,
        { requestId },
      );
    }
    if (desfecho.tipo === "em_curso") {
      return fail(
        "idempotency_in_progress",
        t("A mesma requisição ainda está em curso. Tente de novo em instantes."),
        409,
        { requestId },
      );
    }
    return ok(desfecho.resposta, { status: 201, requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        requestId,
        // A recusa da janela de 24h leva `use: "template"` em `details`.
        ...(err.details !== undefined ? { details: err.details as Record<string, unknown> } : {}),
      });
    }
    throw err;
  }
}
