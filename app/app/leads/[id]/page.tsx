/**
 * A URL ESTÁVEL DE UM LEAD.
 *
 * O dossiê do lead só abria por clique dentro do quadro, o que significa que
 * nenhuma outra tela do produto conseguia apontar para um lead: o histórico de
 * captação tem o id na mão e não tinha para onde levá-lo, e um link colado num
 * grupo do time não abria nada.
 *
 * O funil NÃO entra na URL de propósito. Ele é o lugar onde o lead está AGORA,
 * e leads mudam de funil — um link com o funil dentro apontaria para o quadro
 * errado no dia seguinte. Aqui a resolução é feita na hora e o redirecionamento
 * leva ao quadro certo com `?lead=`, que o board abre na montagem.
 *
 * Sem `notFound()` para lead inexistente: a RLS já garante que a consulta só
 * enxerga leads da organização de quem pediu, e cair no 404 do app é a resposta
 * certa tanto para "não existe" quanto para "não é seu" — sem revelar a
 * diferença entre os dois.
 */
import { notFound, redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function LeadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) notFound();

  const { id } = await params;

  const supabase = await createClient();
  // A RLS enxerga TODAS as organizações do usuário (`fn_user_org_ids()`), então
  // sem este filtro um link para lead de outra org redirecionava para o funil de
  // lá — trocando a organização ativa por baixo do usuário sem ele pedir.
  const { data: lead } = await supabase
    .from("crm_leads")
    .select("id, pipeline_id")
    .eq("organization_id", activeOrg.orgId)
    .eq("id", id)
    .maybeSingle();

  if (!lead?.pipeline_id) notFound();
  redirect(`/app/pipelines/${lead.pipeline_id}?lead=${lead.id}`);
}
