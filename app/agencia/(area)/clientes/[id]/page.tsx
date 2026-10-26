import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { FichaDoCliente } from "@/components/agencia/clientes/FichaDoCliente";
import { requireAreaDaAgencia } from "@/lib/agencia/acesso";
import { estadoDoDrive } from "@/lib/agencia/acervo/drive";
import { apoioDaAgenda } from "@/lib/agencia/calendario/apoio";
import { carregarQuemOlhaAgenda, listarReunioes } from "@/lib/agencia/calendario/consultas";
import { trilhaDoCliente } from "@/lib/agencia/trilhas/consultas";
import { carregarAlcance, podeVerCliente } from "@/lib/agencia/clientes/visibilidade";
import { lerQuantidades, type SituacaoDoCliente } from "@/lib/agencia/clientes/vocabulario";
import { idSchema } from "@/lib/agencia/schemas";
import { apoioDoQuadro, carregarQuemOlha, listarTarefas } from "@/lib/agencia/tarefas/consultas";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Cliente · Agência" };
export const dynamic = "force-dynamic";

/** A ficha do cliente (docs/agencia/SPEC-clientes.md › Telas). */
export default async function PaginaDoCliente({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!idSchema.safeParse(id).success) notFound();
  const ctx = await requireAreaDaAgencia();
  const alcance = await carregarAlcance(ctx);
  // Quem não atende o cliente recebe 404, como se ele não existisse (critério 5).
  if (!podeVerCliente(alcance, id)) notFound();

  const db = createAdminClient();
  const { data } = await db.from("agencia_clientes").select("*").eq("id", id).maybeSingle();
  const c = data as Record<string, unknown> | null;
  if (!c) notFound();

  const quem = await carregarQuemOlha(ctx);
  const quemAgenda = await carregarQuemOlhaAgenda(ctx);
  const [empresas, contratacoes, equipe, membros, arquivos, orgs, drive, tarefas, apoio, reunioes, apoioAgenda, trilha, modelos] = await Promise.all([
    db.from("agencia_clientes_empresas").select("nome, documento").eq("cliente_id", id).order("ordem"),
    db.from("agencia_contratacoes").select("*").eq("cliente_id", id).order("criado_em", { ascending: false }),
    db.from("agencia_clientes_membros").select("membro_id").eq("cliente_id", id),
    db.from("agencia_membros").select("id, nome").eq("situacao", "ativo").order("nome"),
    db.from("agencia_arquivos").select("id, nome, link, subpasta, criado_em").eq("cliente_id", id).order("criado_em", { ascending: false }).limit(50),
    ctx.permissoes.has("clientes.gerenciar")
      ? db.from("organizations").select("id, display_name").order("display_name")
      : Promise.resolve({ data: [] }),
    estadoDoDrive(),
    listarTarefas(quem, { clienteId: id }),
    apoioDoQuadro(quem),
    listarReunioes(quemAgenda, { clienteId: id }),
    apoioDaAgenda(quemAgenda),
    trilhaDoCliente(id),
    db
      .from("agencia_trilha_modelos")
      .select("id, nome, agencia_trilha_modelo_passos(chave, titulo, etapa, ordem)")
      .eq("ativo", true)
      .order("nome"),
  ]);

  const subpastas = (c.drive_subpastas as Record<string, string> | null) ?? {};
  const s = (k: string) => (typeof c[k] === "string" ? (c[k] as string) : "");

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="space-y-1">
        <Link href="/agencia/clientes" className="text-sm text-muted-foreground underline underline-offset-4">
          ← Clientes
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{s("nome")}</h1>
      </div>
      <Suspense>
        <FichaDoCliente
          id={id}
          podeGerenciar={ctx.permissoes.has("clientes.gerenciar")}
          dados={{
            id,
            nome: s("nome"),
            razaoSocial: s("razao_social"),
            documento: s("documento"),
            segmento: s("segmento"),
            responsavelNome: s("responsavel_nome"),
            whatsapp: s("whatsapp"),
            email: s("email"),
            cidade: s("cidade"),
            instagram: s("instagram"),
            site: s("site"),
            observacoes: s("observacoes"),
            situacao: c.situacao as SituacaoDoCliente,
            empresas: ((empresas.data ?? []) as Array<{ nome: string; documento: string | null }>).map((e) => ({
              nome: e.nome,
              documento: e.documento ?? "",
            })),
          }}
          organizacaoId={(c.organization_id as string | null) ?? null}
          organizacoes={((orgs.data ?? []) as Array<{ id: string; display_name: string | null }>).map((o) => ({
            id: o.id,
            nome: o.display_name ?? "Sem nome",
          }))}
          contratacoes={((contratacoes.data ?? []) as Array<Record<string, unknown>>).map((k) => ({
            id: k.id as string,
            tipo: k.tipo as "recorrente" | "avulsa",
            servicos: (k.servicos as string[]) ?? [],
            quantidades: lerQuantidades(k.quantidades),
            inicio: (k.inicio as string | null) ?? "",
            fim: (k.fim as string | null) ?? "",
            situacao: k.situacao as "proposta" | "ativa" | "pausada" | "encerrada",
            observacoes: (k.observacoes as string | null) ?? "",
          }))}
          equipe={((equipe.data ?? []) as Array<{ membro_id: string }>).map((e) => e.membro_id)}
          membros={(membros.data ?? []) as Array<{ id: string; nome: string }>}
          arquivos={(arquivos.data ?? []) as Array<{ id: string; nome: string; link: string; subpasta: string; criado_em: string }>}
          drive={{
            conectado: drive.conectado,
            pastaUrl: c.drive_pasta_id ? `https://drive.google.com/drive/folders/${c.drive_pasta_id as string}` : null,
            subpastasProntas: Object.keys(subpastas).length,
          }}
          tarefas={tarefas}
          apoio={apoio}
          meuMembroId={ctx.membro?.id ?? null}
          podeCriarTarefa={ctx.permissoes.has("tarefas.criar")}
          podeAtribuir={ctx.permissoes.has("tarefas.atribuir")}
          reunioes={reunioes}
          apoioDaAgenda={apoioAgenda}
          podeGerenciarCalendario={ctx.permissoes.has("calendario.gerenciar")}
          agendaLiberada={drive.agendaLiberada}
          trilha={trilha}
          modelosDeTrilha={((modelos.data ?? []) as Array<{
            id: string;
            nome: string;
            agencia_trilha_modelo_passos: Array<{ chave: string; titulo: string; etapa: number; ordem: number }> | null;
          }>).map((m) => ({
            id: m.id,
            nome: m.nome,
            passos: [...(m.agencia_trilha_modelo_passos ?? [])]
              .sort((a, b) => a.etapa - b.etapa || a.ordem - b.ordem)
              .map((x) => ({ chave: x.chave, titulo: x.titulo })),
          }))}
        />
      </Suspense>
    </div>
  );
}
