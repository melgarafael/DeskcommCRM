import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET /api/v1/channel-sessions/[id]/qr — proxy do QR de UM canal específico.
 *
 * Como o onboarding, faz proxy do WAHA para o browser poder <img src="..." />
 * sem expor a API key — mas resolve a sessão por `id` (multi-número), não pelo
 * nome derivado do org. organization_id vem da sessão autenticada.
 *
 * Canal EXCLUÍDO (arquivado) é recusado aqui, e não lá no WAHA. Escanear um QR é
 * o ato que RELIGA um número: se ele aparecer para um canal arquivado, o operador
 * pareia o aparelho e a linha continua arquivada — o mesmo "vivo e surdo" que a
 * rota de reconectar recusa, só que consumado no celular, fora do nosso alcance.
 *
 * Hoje o WAHA responderia 404 (a exclusão deslogou e apagou a sessão lá), mas
 * essa é uma correção EMPRESTADA do estado de um sistema externo, não uma decisão
 * nossa: basta a sessão sobreviver do outro lado para o QR voltar a aparecer.
 * Quem resolve um canal para religá-lo decide sobre `archived_at` — as três rotas
 * irmãs (conectar oficial, reconectar, retomar o onboarding) decidem, esta
 * faltava.
 *
 * Canal OFICIAL também não passa daqui: ele não tem sessão no transporte (nem QR
 * a mostrar), e o `null` seguia para a URL como se fosse nome de sessão.
 */
import { NextResponse } from "next/server";

import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const { id } = await params;

  const user = await loadAuthUser();
  if (!user) return new NextResponse(null, { status: 401 });
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) return new NextResponse(null, { status: 403 });

  const supabase = await createClient();
  const buscar = (colunas: string) =>
    supabase
      .from("channel_sessions")
      .select(colunas)
      .eq("organization_id", activeOrg.orgId)
      .eq("id", id)
      .maybeSingle();
  // Tolerante à coluna ausente: num clone sem a migration 0106 nada está
  // arquivado, e exigir a coluna aqui apagaria o QR de quem está pareando agora
  // — o passo mais frágil da primeira instalação.
  const { data: sessionRaw } = await queryTolerantToMissingArchived(
    () => buscar(`waha_session_name, ${ARCHIVED_AT}`),
    () => buscar("waha_session_name"),
  );
  const session = sessionRaw as {
    waha_session_name: string | null;
    archived_at?: string | null;
  } | null;
  if (!session) return new NextResponse(null, { status: 404 });
  // 409, não 404: o canal ESTÁ na organização — foi excluído. O corpo é vazio
  // porque quem consome isto é um <img>; o cabeçalho é para quem depura.
  if (session.archived_at) {
    return new NextResponse(null, {
      status: 409,
      headers: { "x-channel-state": "archived" },
    });
  }
  // Canal oficial não pareia por QR: `waha_session_name` é NULL nele por CHECK.
  // Afirmar `string` aqui (era um cast) só adiava a mentira até a URL, que virava
  // `/api/null/auth/qr` — 404 do transporte, indistinguível de "o QR ainda não
  // ficou pronto", que é exatamente o estado em que a tela fica insistindo.
  if (!session.waha_session_name) {
    return new NextResponse(null, {
      status: 409,
      headers: { "x-channel-state": "no-session" },
    });
  }

  const baseUrl = process.env.WAHA_API_BASE_URL;
  const apiKey = process.env.WAHA_API_KEY;
  if (!baseUrl || !apiKey || apiKey === "dev_plaintext_change_me") {
    return new NextResponse(null, { status: 503 });
  }

  const upstream = await fetch(
    `${baseUrl}/api/${encodeURIComponent(session.waha_session_name)}/auth/qr?format=image`,
    { headers: { "X-Api-Key": apiKey }, cache: "no-store" },
  );
  if (!upstream.ok) {
    return new NextResponse(null, {
      status: upstream.status,
      headers: { "x-waha-status": String(upstream.status) },
    });
  }

  const ct = upstream.headers.get("content-type") ?? "image/png";
  const buf = await upstream.arrayBuffer();
  return new NextResponse(buf, {
    status: 200,
    headers: { "content-type": ct, "cache-control": "no-store, max-age=0" },
  });
}
