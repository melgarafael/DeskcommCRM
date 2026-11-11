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

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { comIdDaRequisicao, fail } from "@/lib/api/wrappers";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";
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

export async function GET(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "message_templates",
    role: "agent",
    scope: "config:read",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "message_templates.midia", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const { id, indice } = await params;

  const posicao = Number(indice);
  if (!Number.isInteger(posicao) || posicao < 0) {
    return fail("not_found", t("Imagem não encontrada."), 404, { requestId });
  }

  let consulta = authz.supabase
    .from("message_templates")
    .select("midias")
    .eq("id", id)
    .eq("organization_id", authz.organizationId);
  // No token não há pessoa: só o compartilhado (`owner_user_id` nulo) é alcançável.
  if (authz.via === "token") consulta = consulta.is("owner_user_id", null);
  const { data: linha, error: erroLeitura } = await consulta.maybeSingle();
  if (erroLeitura) {
    return fail("internal_error", "Erro ao ler a imagem.", 500, { requestId });
  }
  if (!linha) return fail("not_found", t("Imagem não encontrada."), 404, { requestId });

  const midias = ((linha as { midias: MidiaDeTemplate[] | null }).midias ?? []) as MidiaDeTemplate[];
  const midia = midias[posicao] as MidiaDeTemplate | undefined;
  if (!midia || !midiaPertenceAoTemplate(midia.storage_path, authz.organizationId, id)) {
    return fail("not_found", t("Imagem não encontrada."), 404, { requestId });
  }

  const { data: objeto, error: erroBaixa } = await createAdminClient()
    .storage.from(BUCKET_DAS_MIDIAS)
    .download(midia.storage_path);
  if (erroBaixa || !objeto) {
    return fail("not_found", t("Imagem não encontrada."), 404, { requestId });
  }

  const corpo = await objeto.arrayBuffer();
  return comIdDaRequisicao(new Response(corpo, {
    status: 200,
    headers: {
      "Content-Type": mimeDaMidia(midia.storage_path),
      "Content-Length": String(corpo.byteLength),
      // `no-store`: a URL é a POSIÇÃO na lista, e a posição muda de imagem
      // quando o operador troca ou remove uma. Com cache, o navegador servia
      // os bytes da imagem antiga sob a URL da nova (prova pela tela do #2704).
      "Cache-Control": "private, no-store",
    },
  }), requestId);
}
