import Link from "next/link";
import { notFound } from "next/navigation";

import { EscolherCliente } from "@/components/agencia/trilhas/EscolherCliente";
import { TrilhaDoCliente } from "@/components/agencia/trilhas/TrilhaDoCliente";
import { requireAreaDaAgencia } from "@/lib/agencia/acesso";
import { estadoDoDrive } from "@/lib/agencia/acervo/drive";
import { apoioDaAgenda } from "@/lib/agencia/calendario/apoio";
import { carregarQuemOlhaAgenda } from "@/lib/agencia/calendario/consultas";
import { carregarAlcance, podeVerCliente } from "@/lib/agencia/clientes/visibilidade";
import { ROTULO_DO_SERVICO } from "@/lib/agencia/clientes/vocabulario";
import { idSchema } from "@/lib/agencia/schemas";
import { trilhaDoCliente } from "@/lib/agencia/trilhas/consultas";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Trilha · Agência" };
export const dynamic = "force-dynamic";

/**
 * A trilha de UM cliente, dentro da aba Trilhas (plano de 27/10, item 2): o que já
 * foi feito, o que está liberado — com o reloginho do prazo — e o que espera.
 */
export default async function PaginaDaTrilhaDoCliente({ params }: { params: Promise<{ clienteId: string }> }) {
  const { clienteId } = await params;
  if (!idSchema.safeParse(clienteId).success) notFound();
  const ctx = await requireAreaDaAgencia();
  const alcance = await carregarAlcance(ctx);
  if (!podeVerCliente(alcance, clienteId)) notFound();

  const db = createAdminClient();
  const quemAgenda = await carregarQuemOlhaAgenda(ctx);
  const [{ data: cliente }, { data: clientes }, { data: contratacoes }, modelos, trilha, apoio, drive] = await Promise.all([
    db.from("agencia_clientes").select("id, nome").eq("id", clienteId).maybeSingle(),
    db.from("agencia_clientes").select("id, nome").not("situacao", "in", "(encerrado,perdido)").order("nome"),
    db.from("agencia_contratacoes").select("id, tipo, servicos, situacao").eq("cliente_id", clienteId).order("criado_em", { ascending: false }),
    db.from("agencia_trilha_modelos").select("id, nome, agencia_trilha_modelo_passos(chave, titulo, etapa, ordem)").eq("ativo", true).order("nome"),
    trilhaDoCliente(clienteId),
    apoioDaAgenda(quemAgenda),
    estadoDoDrive(),
  ]);
  const c = cliente as { id: string; nome: string } | null;
  if (!c) notFound();
  const opcoes = ((clientes ?? []) as Array<{ id: string; nome: string }>).filter((x) => alcance.todos || alcance.ids.has(x.id));

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div className="space-y-2">
        <Link href="/agencia/trilhas" className="text-sm text-muted-foreground underline underline-offset-4">
          ← Trilhas
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight" data-testid="trilha-cliente-nome">
            {c.nome}
          </h1>
          <div className="flex flex-wrap items-center gap-3">
            <EscolherCliente clientes={opcoes} atual={c.id} />
            <Link href={`/agencia/clientes/${c.id}`} className="text-sm underline underline-offset-4">
              Ficha do cliente
            </Link>
          </div>
        </div>
      </div>
      <TrilhaDoCliente
        clienteId={c.id}
        trilha={trilha}
        modelos={((modelos.data ?? []) as Array<{
          id: string;
          nome: string;
          agencia_trilha_modelo_passos: Array<{ chave: string; titulo: string; etapa: number; ordem: number }> | null;
        }>).map((m) => ({
          id: m.id,
          nome: m.nome,
          passos: [...(m.agencia_trilha_modelo_passos ?? [])].sort((a, b) => a.etapa - b.etapa || a.ordem - b.ordem).map((x) => ({ chave: x.chave, titulo: x.titulo })),
        }))}
        contratacoes={((contratacoes ?? []) as Array<{ id: string; tipo: "recorrente" | "avulsa"; servicos: string[] | null; situacao: string }>)
          .filter((k) => k.situacao !== "encerrada")
          .map((k) => ({
            id: k.id,
            rotulo: `${k.tipo === "recorrente" ? "Recorrente" : "Avulsa"}${k.servicos?.length ? ` — ${k.servicos.map((s) => ROTULO_DO_SERVICO[s as keyof typeof ROTULO_DO_SERVICO] ?? s).join(", ")}` : ""}`,
          }))}
        podeGerenciar={ctx.permissoes.has("clientes.gerenciar")}
        podeMarcarReuniao={ctx.permissoes.has("calendario.gerenciar")}
        apoio={apoio}
        meuMembroId={ctx.membro?.id ?? null}
        agendaLiberada={drive.agendaLiberada}
      />
    </div>
  );
}
