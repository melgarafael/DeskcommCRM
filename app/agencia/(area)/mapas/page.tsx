import Link from "next/link";

import { NovoMapa } from "@/components/agencia/mapas/NovoMapa";
import { requireAreaDaAgencia } from "@/lib/agencia/acesso";
import { carregarAlcance } from "@/lib/agencia/clientes/visibilidade";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Mapas · Agência" };
export const dynamic = "force-dynamic";

const ROTULO = { rascunho: "Criação", publicado: "Ao vivo", arquivado: "Arquivado" } as const;

/** Os mapas mentais dos clientes que a pessoa alcança (docs/agencia/SPEC-mapa-mental.md). */
export default async function PaginaDosMapas() {
  const ctx = await requireAreaDaAgencia();
  const alcance = await carregarAlcance(ctx);
  const db = createAdminClient();
  const [{ data: mapas }, { data: clientes }, { data: blocos }] = await Promise.all([
    db.from("agencia_mapas").select("id, titulo, situacao, cliente_id, atualizado_em, agencia_clientes(nome)").order("atualizado_em", { ascending: false }).limit(300),
    db.from("agencia_clientes").select("id, nome").not("situacao", "in", "(encerrado,perdido)").order("nome"),
    db.from("agencia_mapa_blocos").select("mapa_id, situacao"),
  ]);
  const visiveis = ((mapas ?? []) as unknown as Array<{
    id: string;
    titulo: string;
    situacao: keyof typeof ROTULO;
    cliente_id: string;
    agencia_clientes: { nome: string } | null;
  }>).filter((m) => alcance.todos || alcance.ids.has(m.cliente_id));
  const contagem = new Map<string, { total: number; feitos: number }>();
  for (const b of (blocos ?? []) as Array<{ mapa_id: string; situacao: string }>) {
    const c = contagem.get(b.mapa_id) ?? { total: 0, feitos: 0 };
    c.total++;
    if (b.situacao === "concluido") c.feitos++;
    contagem.set(b.mapa_id, c);
  }
  const opcoes = ((clientes ?? []) as Array<{ id: string; nome: string }>).filter((c) => alcance.todos || alcance.ids.has(c.id));

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Mapas</h1>
        <p className="text-sm text-muted-foreground">Desenhe o plano do cliente em blocos e setas; publicado, cada bloco vira tarefa quando chega a vez.</p>
      </div>
      {ctx.permissoes.has("mapa.editar") && <NovoMapa clientes={opcoes} />}
      {visiveis.length === 0 ? (
        <p className="rounded-md border p-4 text-sm text-muted-foreground">Nenhum mapa ainda.</p>
      ) : (
        <ul className="divide-y rounded-md border" data-testid="lista-de-mapas">
          {visiveis.map((m) => {
            const c = contagem.get(m.id) ?? { total: 0, feitos: 0 };
            return (
              <li key={m.id}>
                <Link href={`/agencia/mapas/${m.id}`} className="flex flex-wrap items-baseline justify-between gap-2 p-3 text-sm hover:bg-accent/40">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{m.titulo}</span>
                    <span className="text-xs text-muted-foreground">{m.agencia_clientes?.nome}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {ROTULO[m.situacao]} · {m.situacao === "rascunho" ? `${c.total} blocos` : `${c.feitos} de ${c.total}`}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
