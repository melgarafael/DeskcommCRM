/**
 * GET /api/v1/voice/events — relay SSE do pareamento de chamada de voz pro
 * navegador (spec §4.2/§5.1). Escopo único: entregar o QR e o "pareado" da
 * tela de Configurações › Conexões. Status de LIGAÇÃO em andamento não passa
 * por aqui — isso é Supabase Realtime em `voice_calls`
 * (`hooks/voice/useVoiceCallSession.ts`), que já tem RLS por organização.
 *
 * Esta rota existe porque o WaCalls não devolve o QR na resposta do
 * `POST /api/sessions` (`lib/wacalls/client.ts`): ele empurra por SSE no
 * processo inteiro (`/api/events`, sem filtro por sessão). Filtramos aqui pela
 * sessão desta org antes de repassar — nunca vaza o QR de outra sessão
 * pareando ao mesmo tempo.
 *
 * ═══ A SESSÃO É RECONHECIDA PELO NOME, NÃO SÓ PELO ID DO BANCO ═══
 *
 * A tela abre esta stream ANTES de pedir o pareamento, e o `POST /api/sessions`
 * do upstream começa a emitir QR antes de a rota de pareamento gravar o id em
 * `channel_sessions`. Filtrar só pelo id do banco perdia esse primeiro QR por
 * construção. A versão anterior contornava com um passo "prepare_only" que só
 * registrava a sessão para este relay ter um id, e deixava o pareamento para um
 * segundo POST — que chamava o `/pair` do upstream, o que prendia o discador a
 * um cliente morto (ver `lib/wacalls/client.ts`). O broker emite `session-list` com
 * `name` na criação e antes de cada QR, e o nome é determinístico
 * (`nomeDaSessaoDeVoz`): é ele que diz "esta sessão é da organização desta
 * stream" no instante certo. O id do banco, quando existe, continua valendo —
 * as duas fontes SOMAM, nenhuma substitui a outra.
 */
import { randomUUID } from "node:crypto";

import QRCode from "qrcode";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { resolveWacallsSession } from "@/lib/wacalls/session";
import { getWacallsClient } from "@/lib/wacalls/client";
import { nomeDaSessaoDeVoz } from "@/lib/wacalls/nome-da-sessao";
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
  // Sem sessão ainda não é erro: é o primeiro pareamento, e a stream precisa
  // estar aberta antes de a sessão existir. O nome fecha a lacuna.
  const nossas = new Set<string>(session ? [session.wacallsSessionId] : []);
  const nome = nomeDaSessaoDeVoz(activeOrg.orgId);
  // A sessão cujo QR está na tela agora. "Venceu" só vale para ELA: o
  // pareamento apaga a sessão anterior antes de criar a nova, e o WaCalls pode
  // emitir `logged_out` para a que está sendo apagada — encerrar a stream por
  // isso esconderia o QR novo que vem logo atrás.
  let sessaoDoQrNaTela: string | null = null;

  const upstream = await fetch(`${env.WACALLS_API_BASE_URL}/api/events`, {
    headers: {
      "X-Client-Id": `web_${activeOrg.orgId.slice(0, 8)}`,
      Authorization: `Bearer ${env.WACALLS_API_TOKEN.trim()}`,
    },
  });
  if (!upstream.ok || !upstream.body) {
    return new Response(null, { status: 502 });
  }

  const reader = upstream.body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
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
            if (ev["type"] === "session-list") {
              const lista = Array.isArray(ev["sessions"])
                ? (ev["sessions"] as Array<Record<string, unknown>>)
                : [];
              for (const s of lista) {
                if (s["name"] === nome && typeof s["id"] === "string") nossas.add(s["id"]);
              }
              continue;
            }
            if (ev["type"] !== "auth-state") continue;
            if (typeof ev["sessionId"] !== "string" || !nossas.has(ev["sessionId"])) continue;
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
              sessaoDoQrNaTela = ev["sessionId"];
              continue;
            }
            // O whatsmeow encerrou o canal de QR sem leitura (`startPairing`,
            // caso "timeout" → `setAuth(logged_out)`). Sem repassar isto, a tela
            // mantinha o último QR — um código morto, que não faz nada ao ser
            // escaneado. A sessão fica para trás sem QR; o próximo "Parear" a
            // apaga e cria outra (ver a rota de pareamento). Só a sessão do QR
            // exibido — ver `sessaoDoQrNaTela`.
            if (ev["state"] === "logged_out" && ev["sessionId"] === sessaoDoQrNaTela) {
              controller.enqueue(encoder.encode(sseLine({ type: "expired" })));
              controller.close();
              reader.cancel().catch(() => {});
              return;
            }
          }
        }
        controller.close();
      } catch {
        // Erro no meio do laço (um QR que não codifica, um enqueue sobre
        // stream já fechada) fecha a ponta do navegador — e precisa fechar a de
        // cima também: sem isto a conexão com `/api/events` ficava aberta, sem
        // leitor, e o WaCalls seguia com o assinante até o app reiniciar.
        reader.cancel().catch(() => {});
        try {
          controller.close();
        } catch {
          // stream já fechada — nada a fazer
        }
      }
    },
    cancel() {
      // O body está travado pelo reader; só ele consegue cancelar a conexão.
      reader.cancel().catch(() => {});
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
