// app/api/v1/proposals/[id]/previa/route.ts
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { comIdDaRequisicao, fail } from "@/lib/api/wrappers";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";
import { sePropostasDesligadas } from "@/lib/propostas/porta";
import { montarPdfDaProposta, type PropostaParaPdf } from "@/lib/propostas/pdf-da-proposta";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/**
 * "VER COMO O CLIENTE RECEBE" — o PDF que o envio faria AGORA, sem enviar.
 *
 * É LEITURA, e é leitura de verdade: não muda status, não aloca número, não
 * grava no Storage e não audita (não há efeito). Por isso é `GET`, não `POST`,
 * e por isso não pede `requireSupportWrite` — a guarda é do efeito de escrita,
 * e aqui não há nenhum.
 *
 * O arquivo sai da MESMA função que monta o do envio
 * (`lib/propostas/pdf-da-proposta.ts`): a prévia que não bate com o envio é
 * pior que não ter prévia, porque ela promete o que o cliente não vai receber.
 */
export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  // A mesma permissão de VER a proposta (`GET /api/v1/proposals/[id]`).
  const authz = await resolveAuthDual(req, { requestId, resource: "crm_proposals", role: "agent", scope: "mcp:read" });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "proposals_previa", requestId);
  if (teto) return teto;
  const desligada = await sePropostasDesligadas(authz.organizationId, requestId);
  if (desligada) return desligada;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const { id } = await ctx.params;
  const admin = createAdminClient();

  // `organization_id` vem do cookie (fonte confiável), nunca do path: proposta
  // de outra organização é a MESMA resposta de "não encontrada" que não existe.
  const { data } = await admin
    .from("crm_proposals")
    .select("*")
    .eq("organization_id", authz.organizationId)
    .eq("id", id)
    .maybeSingle();
  if (!data) return fail("not_found", t("Proposta não encontrada."), 404, { requestId });

  // `numero`/`ano` NÃO vêm da montagem: quem chama decide o que entra no
  // cabeçalho. O envio passa o número que acabou de alocar; a prévia passa o da
  // própria linha, que em rascunho é nulo.
  const proposta = data as PropostaParaPdf & { numero: number | null; ano: number | null };
  const numero = proposta.numero ?? null;
  const ano = proposta.ano ?? null;
  const resultado = await montarPdfDaProposta(admin, authz.organizationId, proposta, {
    numero,
    ano,
    t,
    // Rascunho não tem número ainda: onde ele apareceria, a prévia escreve que
    // não existe — em vez de mostrar `0000/0000` e parecer proposta pronta.
    previa: numero === null,
    // A prévia existe para a pessoa ver a proposta ENQUANTO a completa;
    // recusar por pendência esconderia justamente o que ela precisa ver
    // (onde está o "[a definir]"). O envio continua recusando: a trava fica
    // no send/route.ts, antes de alocar número.
    permitirPendencias: true,
  });
  // Sem modelo confirmado é a MESMA recusa do envio (C1) — a prévia não cai no
  // PDF legado, que é o defeito que o C1 existe para acabar. Pendência de campo
  // não recusa aqui: o PDF sai com "[a definir]" no lugar do que falta.
  if (!resultado.ok) return fail("validation_failed", resultado.motivo, 422, { requestId });

  return comIdDaRequisicao(new Response(new Uint8Array(resultado.buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": "inline; filename=previa-proposta.pdf",
      "Cache-Control": "no-store",
      "X-Request-Id": requestId,
    },
  }), requestId);
}
