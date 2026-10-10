/**
 * GET /api/v1/message-templates/:id/midias/:indice — devolve OS BYTES de uma
 * imagem do template (#2526).
 *
 * Por que um proxy e não um redirect assinado (o que `messages/:id/media`
 * faz): aqui quem baixa é o COMPOSITOR, que precisa do `Blob` na hora de
 * montar o `File` que o envio de mídia consome. Um 302 para o domínio do
 * Storage cruzaria a origem e dependeria do CORS configurado no bucket — em
 * self-host, que é o chão deste produto, esse CORS é do operador e não nosso.
 * Devolver o corpo pela própria origem tira a dependência inteira.
 *
 * A leitura é pela sessão do usuário (`createClient`, RLS `select` do
 * template) e o objeto é aberto por service role SÓ DEPOIS de a linha estar
 * visível — e o caminho é conferido contra o prefixo do template, porque a
 * coluna é gravável pelo PostgREST.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  BUCKET_DAS_MIDIAS,
  mimeDaMidia,
  midiaPertenceAoTemplate,
  type MidiaDeTemplate,
} from "@/lib/templates/midias";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string; indice: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "message_templates" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org } = authz;
  const { id, indice } = await params;

  const posicao = Number(indice);
  if (!Number.isInteger(posicao) || posicao < 0) {
    return fail("not_found", t("Imagem não encontrada."), 404, { requestId });
  }

  const supabase = await createClient();
  const { data: linha, error: erroLeitura } = await supabase
    .from("message_templates")
    .select("midias")
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (erroLeitura) {
    return fail("internal_error", "Erro ao ler a imagem.", 500, { requestId });
  }
  if (!linha) return fail("not_found", t("Imagem não encontrada."), 404, { requestId });

  const midias = ((linha as { midias: MidiaDeTemplate[] | null }).midias ?? []) as MidiaDeTemplate[];
  const midia = midias[posicao] as MidiaDeTemplate | undefined;
  if (!midia || !midiaPertenceAoTemplate(midia.storage_path, org.orgId, id)) {
    return fail("not_found", t("Imagem não encontrada."), 404, { requestId });
  }

  const { data: objeto, error: erroBaixa } = await createAdminClient()
    .storage.from(BUCKET_DAS_MIDIAS)
    .download(midia.storage_path);
  if (erroBaixa || !objeto) {
    return fail("not_found", t("Imagem não encontrada."), 404, { requestId });
  }

  const corpo = await objeto.arrayBuffer();
  return new Response(corpo, {
    status: 200,
    headers: {
      "Content-Type": mimeDaMidia(midia.storage_path),
      "Content-Length": String(corpo.byteLength),
      // Privado e curto: a imagem é material comercial da organização, não
      // arquivo público. Um cache compartilhado guardaria esse material.
      "Cache-Control": "private, max-age=300",
    },
  });
}
