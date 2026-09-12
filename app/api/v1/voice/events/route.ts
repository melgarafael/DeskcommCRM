/**
 * GET /api/v1/voice/events — relay SSE do pareamento de chamada de voz pro
 * navegador (spec §4.2/§5.1). Escopo único: entregar o QR e o "pareado" da
 * tela de Configurações › Conexões. Status de LIGAÇÃO em andamento não passa
 * por aqui — isso é Supabase Realtime em `voice_calls`
 * (`hooks/voice/useVoiceCallSession.ts`), que já tem RLS por organização.
 *
 * Esta rota existe porque o WaCalls não devolve o QR na resposta do
 * `POST .../pair` (`lib/wacalls/client.ts`): ele empurra por SSE no processo
 * inteiro (`/api/events`, sem filtro por sessão). Filtramos aqui pelo
 * `wacallsSessionId` desta org antes de repassar — nunca vaza o QR de outra
 * sessão pareando ao mesmo tempo.
 */
import { randomUUID } from "node:crypto";

import QRCode from "qrcode";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { resolveWacallsSession } from "@/lib/wacalls/session";
import { getWacallsClient } from "@/lib/wacalls/client";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

function sseLine(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function GET(): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("admin", {
    requestId,
    resource: "channel_sessions",
    allowPlatformAdmin: true,
  });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  if (!getWacallsClient()) {
    return new Response(null, { status: 503 });
  }

  const supabase = await createClient();
  const session = await resolveWacallsSession(supabase, activeOrg.orgId);
  if (!session) {
    return new Response(null, { status: 404 });
  }
  const { wacallsSessionId } = session;

  const upstream = await fetch(`${env.WACALLS_API_BASE_URL}/api/events`, {
    headers: { "X-Client-Id": `web_${activeOrg.orgId.slice(0, 8)}` },
  });
  if (!upstream.ok || !upstream.body) {
    return new Response(null, { status: 502 });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const reader = upstream.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      // Sem este primeiro byte, os headers desta resposta ficam retidos pelo
      // Next até o corpo produzir ALGO — e o corpo só produz algo quando um
      // evento do WaCalls casar com esta sessão. Como o pareamento (spec
      // §5.1) só é disparado pelo NAVEGADOR depois que o `onopen` do
      // `EventSource` confirma a stream aberta, as duas pontas ficavam
      // esperando uma a outra: travamento medido, não hipotético. Comentário
      // SSE (`:`) é ignorado por todo cliente EventSource e existe só para
      // forçar o flush imediato dos headers.
      controller.enqueue(encoder.encode(": conectado\n\n"));
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            let ev: Record<string, unknown>;
            try {
              ev = JSON.parse(payload) as Record<string, unknown>;
            } catch {
              continue;
            }
            if (ev["sessionId"] !== wacallsSessionId) continue;
            if (ev["type"] !== "auth-state") continue;
            const paired = ev["paired"] === true;
            const qr = typeof ev["qr"] === "string" ? ev["qr"] : null;
            if (paired) {
              controller.enqueue(encoder.encode(sseLine({ type: "paired" })));
              controller.close();
              reader.cancel().catch(() => {});
              return;
            }
            if (qr) {
              const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
              controller.enqueue(encoder.encode(sseLine({ type: "qr", dataUrl })));
            }
          }
        }
        controller.close();
      } catch {
        try {
          controller.close();
        } catch {
          // stream já fechada — nada a fazer
        }
      }
    },
    cancel() {
      upstream.body?.cancel().catch(() => {});
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
