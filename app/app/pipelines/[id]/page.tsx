import { notFound, redirect } from "next/navigation";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import type { Pipeline, Stage } from "@/lib/kanban/types";
import { createClient } from "@/lib/supabase/server";
import { PipelinePageClient } from "./_client";

export const dynamic = "force-dynamic";

export default async function PipelinePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  const { id } = await params;
  const supabase = await createClient();
  // Mesma razão da Agenda: a RLS é piso, não escopo. Sem este filtro o funil de
  // OUTRA organização do mesmo usuário abre, e o quadro monta com as etapas de
  // um lugar e o cabeçalho de outro.
  const { data: pipeline } = await supabase
    .from("crm_pipelines")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    .eq("id", id)
    .maybeSingle();
  if (!pipeline) notFound();
  /**
   * ─── A LEITURA LEVE (#3172, item 4 do CR) ─────────────────────────────────
   *
   * O FUNIL e as ETAPAS vivas, sem negócio nenhum. É o que a aba Lista precisa
   * para abrir: ela é a tela que existe para o funil que NÃO cabe numa leitura
   * só, e depender da leitura que não cabe seria o defeito de volta. Aqui são
   * duas consultas por chave (a linha do funil, as etapas por `position`), e
   * não a varredura de `crm_leads` que a rota do quadro faz — a mesma que leva
   * 19 s num funil migrado e estoura o `statement_timeout`.
   *
   * Ficam no SERVIDOR e descem como prop porque a página já lê o funil para o
   * `notFound()`: é o mesmo cliente por cookie, a mesma RLS, e nenhum vaivém de
   * rede a mais na abertura da tela.
   */
  const { data: etapas } = await supabase
    .from("crm_stages")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    .eq("pipeline_id", id)
    .eq("is_archived", false)
    .order("position");
  // A lista que alimenta o seletor de troca rápida: os mesmos vivos da tela de
  // Funis (`app/app/kanban/page.tsx`), só `id` + `name`. Arquivado não entra —
  // trocar para um funil que não recebe negócio seria destino que não existe.
  const { data: funis } = await supabase
    .from("crm_pipelines")
    .select("id, name")
    .eq("organization_id", activeOrg.orgId)
    .eq("is_archived", false)
    .order("position");
  return (
    <PipelinePageClient
      pipelineId={id}
      initialName={pipeline.name}
      role={activeOrg.role}
      funis={funis ?? []}
      funilInicial={pipeline as Pipeline}
      etapasIniciais={(etapas ?? []) as Stage[]}
    />
  );
}
