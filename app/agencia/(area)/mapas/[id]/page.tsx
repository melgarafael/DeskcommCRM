import { notFound } from "next/navigation";

import { TelaDoMapa } from "@/components/agencia/mapas/TelaDoMapa";
import { requireAreaDaAgencia } from "@/lib/agencia/acesso";
import { carregarAlcance, podeVerCliente } from "@/lib/agencia/clientes/visibilidade";
import { iaDisponivel } from "@/lib/agencia/ia/modelo";
import { lerMapa } from "@/lib/agencia/mapas/motor";
import { idSchema } from "@/lib/agencia/schemas";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Mapa · Agência" };
export const dynamic = "force-dynamic";

/** Criação (rascunho) ou Ao vivo (publicado) — docs/agencia/SPEC-mapa-mental.md. */
export default async function PaginaDoMapa({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!idSchema.safeParse(id).success) notFound();
  const ctx = await requireAreaDaAgencia();
  const lido = await lerMapa(id);
  if (!lido || !podeVerCliente(await carregarAlcance(ctx), lido.mapa.cliente_id)) notFound();
  const db = createAdminClient();
  const [{ data: membros }, { data: funcoes }] = await Promise.all([
    db.from("agencia_membros").select("id, nome").eq("situacao", "ativo").order("nome"),
    db.from("agencia_funcoes").select("id, nome").eq("ativa", true).order("ordem"),
  ]);
  return (
    <TelaDoMapa
      mapa={{ id, titulo: lido.mapa.titulo, situacao: lido.mapa.situacao, clienteNome: lido.mapa.agencia_clientes?.nome ?? "" }}
      blocos={lido.blocos.map((b) => ({
        id: b.id,
        titulo: b.titulo,
        descricao: b.descricao,
        cor: b.cor,
        x: b.x,
        y: b.y,
        tipo: b.tipo,
        funcaoId: b.funcao_id,
        responsavelId: b.responsavel_id,
        prazo: b.prazo,
        checklist: b.checklist,
        links: b.links,
        executor: b.executor,
        acaoIa: b.acao_ia,
        situacao: b.situacao,
        tarefaId: b.tarefa_id,
      }))}
      ligacoes={lido.ligacoes}
      membros={(membros ?? []) as Array<{ id: string; nome: string }>}
      funcoes={(funcoes ?? []) as Array<{ id: string; nome: string }>}
      podeEditar={ctx.permissoes.has("mapa.editar")}
      iaDisponivel={iaDisponivel()}
    />
  );
}
