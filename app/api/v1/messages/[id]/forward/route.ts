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

import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { encaminharMensagem } from "@/lib/inbox/encaminhar-mensagem";
import { createClient } from "@/lib/supabase/server";

interface Ctx {
  params: Promise<{ id: string }>;
}

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

  const supabase = await createClient();
  try {
    const mensagem = await encaminharMensagem(
      supabase,
      {
        organization_id: authz.org.orgId,
        actor: { type: "user", id: authz.user.id },
        requestId,
        idioma: authz.user.idioma,
      },
      { messageId: id, conversationIdDestino: corpo.conversation_id },
    );
    return ok(mensagem, { status: 201, requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, { requestId });
    }
    throw err;
  }
}
