/**
 * POST /api/v1/contacts/import/agenda — o "Sincronizar agenda do celular" (#2736).
 *
 * Body: `{ channel_session_id: uuid, offset?: number }` — o número pareado cuja
 * agenda será lida, e de QUAL LINHA da agenda este clique começa. O `offset` é
 * o `proximo_offset` que o clique anterior devolveu: a rota não inventa nem
 * guarda cursor, ela só repassa (a agenda é lida em passadas de 1.000 linhas, e
 * até 500 contatos criados por passada — sem o cursor o segundo clique relia as
 * mesmas mil linhas e o milésimo virava o fim da agenda). A organização vem da
 * sessão autenticada, nunca do body (mesma régua de toda a família `/api/v1`).
 *
 * A escrita de contato é a do webhook (`fn_upsert_wa_contact`, em
 * `lib/contacts/agenda-do-celular.ts`); o que esta rota decide é só quem PODE
 * pedir (agent+, igual ao import de planilha) e o que é recusado ANTES de falar
 * com o aparelho — sessão de outro tenant, canal sem método de agenda ou número
 * desconectado não custam uma chamada ao transporte para virarem 500.
 *
 * ─── Falar com o canal sem nomear provider nenhum ───────────────────────────
 *
 * As duas peças do seam, uma por fronteira: a COLUNA do identificador da
 * sessão vem de `CHANNEL_SESSION_REF_COLUMNS` e é lida por `resolveSessionRef`
 * (a string do `select` não é escrita aqui), e quem TEM agenda é quem
 * implementa `listPhonebook` no adapter — testar a presença do método é a
 * pergunta certa; um `provider === ...` seria exatamente o que o
 * `scripts/lint-channels.ts` reprovou.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import {
  CHANNEL_SESSION_REF_COLUMNS,
  DEFAULT_CHANNEL_PROVIDER,
  getAdapter,
  resolveSessionRef,
  type ChannelProvider,
  type ChannelSessionRef,
} from "@/lib/channels";
import { criarDepsDeAgenda, sincronizarAgendaDoCelular } from "@/lib/contacts/agenda-do-celular";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const corpoSchema = z.object({
  channel_session_id: z.string().uuid(),
  /**
   * O `proximo_offset` do clique anterior. Ausente = primeiro clique (zero).
   * Teto alto de propósito: o offset é uma linha de uma agenda de celular, não
   * uma página de listagem — quem pedir 10^9 recebe a página vazia e o resumo
   * fecha em `truncado: false`, sem varredura nenhuma.
   */
  offset: z.number().int().min(0).max(100_000_000).default(0),
});

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  // Escrita agent+ — a mesma régua de `POST /api/v1/contacts/import`: sincronizar
  // a agenda cria contato em bloco tanto quanto a planilha.
  const authz = await requireRole("agent", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;

  const corpo = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!corpo.success) {
    return fail("validation_failed", "Informe o número conectado (channel_session_id).", 422, { requestId });
  }

  const admin = createAdminClient();
  const { data: sessao, error } = await admin
    .from("channel_sessions")
    .select(`${CHANNEL_SESSION_REF_COLUMNS}, status`)
    .eq("id", corpo.data.channel_session_id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  // A ausência (outro tenant, id que não existe) e o erro de banco têm o MESMO
  // desfecho visível aqui — não vazar que o id existe em outra organização.
  if (error) {
    logger.warn("sync-agenda: não consegui ler o número", { requestId, detail: error.message });
    return fail("internal_error", "Não foi possível ler o número conectado.", 500, { requestId });
  }
  const canal = sessao as (ChannelSessionRef & { status: string | null }) | null;
  if (!canal) {
    return fail("session_not_found", "Número não encontrado nesta organização.", 404, { requestId });
  }

  // Só quem implementa `listPhonebook` tem uma agenda do aparelho para ler —
  // e o adapter LANÇA para provider que esta imagem ainda não conhece (falhar
  // fechado é o certo aqui): os dois desfechos são o MESMO 409, porque a
  // pergunta é a mesma ("este número tem agenda?") e a resposta não é da conta
  // de quem pediu.
  const adapter = (() => {
    try {
      return getAdapter((canal.provider ?? DEFAULT_CHANNEL_PROVIDER) as ChannelProvider);
    } catch {
      return null;
    }
  })();
  const listar = adapter?.listPhonebook ?? null;
  if (!listar) {
    return fail(
      "channel_without_phonebook",
      "A agenda do celular só existe para números pareados com o aplicativo do WhatsApp.",
      409,
      { requestId },
    );
  }
  if (canal.status !== "WORKING") {
    return fail(
      "channel_not_working",
      "Este número não está conectado. Reconecte-o em Conexões e tente de novo.",
      409,
      { requestId },
    );
  }

  const sessionRef = resolveSessionRef(canal);
  try {
    const resumo = await sincronizarAgendaDoCelular(
      criarDepsDeAgenda(admin, (session, pagina) =>
        listar({
          organizationId: authz.org.orgId,
          sessionRef: session,
          limit: pagina.limit,
          offset: pagina.offset,
        }),
      ),
      {
        organizationId: authz.org.orgId,
        session: sessionRef,
        actorUserId: authz.user.id,
        requestId,
        // O cursor do clique anterior: a rota só repassa, quem lê é o serviço.
        offset: corpo.data.offset,
      },
    );
    return ok(resumo, { requestId });
  } catch (err) {
    // O transporte (fora do ar, sem configuração, teto estourado) vira a MESMA
    // frase de saída da rota de grupos — aponta para a conexão e nunca vaza
    // status/corpo do provedor (mesma doutrina do cabeçalho do cliente do
    // transporte: o erro de lá carrega só o status HTTP).
    logger.warn("sync-agenda: o transporte do canal não respondeu", {
      requestId,
      causa: err instanceof Error ? err.message.slice(0, 160) : String(err),
    });
    return fail(
      "channel_unavailable",
      "O WhatsApp deste número não respondeu. Confira se ele está conectado e tente de novo.",
      502,
      { requestId },
    );
  }
}
