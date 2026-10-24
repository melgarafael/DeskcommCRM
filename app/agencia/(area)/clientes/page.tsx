import { ListaDeClientes, type ClienteDaLista, type OrganizacaoImportavel } from "@/components/agencia/clientes/ListaDeClientes";
import { requireAreaDaAgencia } from "@/lib/agencia/acesso";
import { carregarAlcance } from "@/lib/agencia/clientes/visibilidade";
import type { SituacaoDoCliente } from "@/lib/agencia/clientes/vocabulario";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Clientes · Agência" };
export const dynamic = "force-dynamic";

/** Os clientes da agência (docs/agencia/SPEC-clientes.md › Telas). */
export default async function PaginaDeClientes() {
  const ctx = await requireAreaDaAgencia();
  const alcance = await carregarAlcance(ctx);
  const db = createAdminClient();
  const gerencia = ctx.permissoes.has("clientes.gerenciar");

  const [clientes, equipe, membros, abertas] = await Promise.all([
    db.from("agencia_clientes").select("id, nome, segmento, situacao, organization_id, drive_pasta_id").order("nome"),
    db.from("agencia_clientes_membros").select("cliente_id, membro_id"),
    db.from("agencia_membros").select("id, nome").eq("situacao", "ativo"),
    db.from("agencia_tarefas").select("cliente_id").is("concluida_em", null).not("cliente_id", "is", null),
  ]);

  const nomeDoMembro = new Map(((membros.data ?? []) as Array<{ id: string; nome: string }>).map((m) => [m.id, m.nome]));
  const equipePorCliente = new Map<string, string[]>();
  for (const e of (equipe.data ?? []) as Array<{ cliente_id: string; membro_id: string }>) {
    const l = equipePorCliente.get(e.cliente_id) ?? [];
    const nome = nomeDoMembro.get(e.membro_id);
    if (nome) l.push(nome);
    equipePorCliente.set(e.cliente_id, l);
  }
  const abertasPorCliente = new Map<string, number>();
  for (const t of (abertas.data ?? []) as Array<{ cliente_id: string }>) {
    abertasPorCliente.set(t.cliente_id, (abertasPorCliente.get(t.cliente_id) ?? 0) + 1);
  }

  const lista: ClienteDaLista[] = (
    (clientes.data ?? []) as Array<{
      id: string;
      nome: string;
      segmento: string | null;
      situacao: SituacaoDoCliente;
      organization_id: string | null;
      drive_pasta_id: string | null;
    }>
  )
    .filter((c) => alcance.todos || alcance.ids.has(c.id))
    .map((c) => ({
      id: c.id,
      nome: c.nome,
      segmento: c.segmento,
      situacao: c.situacao,
      temOrganizacao: !!c.organization_id,
      temPasta: !!c.drive_pasta_id,
      equipe: equipePorCliente.get(c.id) ?? [],
      tarefasAbertas: abertasPorCliente.get(c.id) ?? 0,
    }));

  // Importáveis: organizações sem cliente, fora a do WhatsApp da agência (C2).
  let importaveis: OrganizacaoImportavel[] = [];
  if (gerencia) {
    const [{ data: orgs }, { data: config }] = await Promise.all([
      db.from("organizations").select("id, display_name, legal_name").order("display_name"),
      db.from("agencia_config").select("canal_organization_id").eq("id", true).maybeSingle(),
    ]);
    const ligadas = new Set(
      ((clientes.data ?? []) as Array<{ organization_id: string | null }>).map((c) => c.organization_id).filter(Boolean),
    );
    const daAgencia = (config as { canal_organization_id?: string | null } | null)?.canal_organization_id ?? null;
    importaveis = ((orgs ?? []) as Array<{ id: string; display_name: string | null; legal_name: string | null }>)
      .filter((o) => !ligadas.has(o.id) && o.id !== daAgencia)
      .map((o) => ({ id: o.id, nome: o.display_name || o.legal_name || "Sem nome" }));
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Clientes</h1>
        <p className="text-sm text-muted-foreground">
          {alcance.todos ? "Todos os clientes da agência." : "Os clientes que você atende."}
        </p>
      </div>
      <ListaDeClientes clientes={lista} importaveis={importaveis} podeGerenciar={gerencia} />
    </div>
  );
}
