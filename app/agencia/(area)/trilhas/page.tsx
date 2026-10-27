import Link from "next/link";

import { EscolherCliente } from "@/components/agencia/trilhas/EscolherCliente";
import { Reloginho } from "@/components/agencia/trilhas/Reloginho";
import { requireAreaDaAgencia } from "@/lib/agencia/acesso";
import { carregarAlcance } from "@/lib/agencia/clientes/visibilidade";
import { listarTrilhasAtivas } from "@/lib/agencia/trilhas/consultas";
import { ROTULO_DA_ETAPA } from "@/lib/agencia/trilhas/vocabulario";
import { createAdminClient } from "@/lib/supabase/admin";
import { cn } from "@/lib/utils";

export const metadata = { title: "Trilhas · Agência" };
export const dynamic = "force-dynamic";

const FILTROS = { todas: "Todas", atrasadas: "Com atraso", em_dia: "Em dia" } as const;
type Filtro = keyof typeof FILTROS;

/**
 * As trilhas dos clientes que a pessoa alcança. Cada cliente abre a trilha AQUI,
 * em `/agencia/trilhas/<cliente>` — nunca na ficha de Clientes (plano de 27/10, item 2).
 */
export default async function PaginaDasTrilhas({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const ctx = await requireAreaDaAgencia();
  const alcance = await carregarAlcance(ctx);
  const filtro: Filtro = typeof sp.filtro === "string" && sp.filtro in FILTROS ? (sp.filtro as Filtro) : "todas";
  const busca = typeof sp.q === "string" ? sp.q.trim().toLowerCase() : "";

  const [trilhas, { data: clientes }] = await Promise.all([
    listarTrilhasAtivas(alcance),
    createAdminClient().from("agencia_clientes").select("id, nome").not("situacao", "in", "(encerrado,perdido)").order("nome"),
  ]);
  const alcancaveis = ((clientes ?? []) as Array<{ id: string; nome: string }>).filter((c) => alcance.todos || alcance.ids.has(c.id));
  const comTrilha = new Set(trilhas.map((t) => t.clienteId));
  const semTrilha = alcancaveis.filter((c) => !comTrilha.has(c.id) && (!busca || c.nome.toLowerCase().includes(busca)));
  const comAtraso = trilhas.filter((t) => t.atrasados.length > 0).length;
  const visiveis = trilhas
    .filter((t) => (filtro === "atrasadas" ? t.atrasados.length > 0 : filtro === "em_dia" ? t.atrasados.length === 0 : true))
    .filter((t) => !busca || t.clienteNome.toLowerCase().includes(busca));
  const url = (f: Filtro) => `/agencia/trilhas?${new URLSearchParams({ ...(f !== "todas" ? { filtro: f } : {}), ...(busca ? { q: busca } : {}) }).toString()}`;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Trilhas</h1>
          <p className="text-sm text-muted-foreground">
            Em que ponto cada cliente está{comAtraso ? ` · ${comAtraso} com passo atrasado` : ""}.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <EscolherCliente clientes={alcancaveis} />
          {ctx.permissoes.has("trilhas.gerenciar") && (
            <Link href="/agencia/trilhas/modelos" className="text-sm underline underline-offset-4">
              Modelos de trilha
            </Link>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(Object.keys(FILTROS) as Filtro[]).map((f) => (
          <Link
            key={f}
            href={url(f)}
            className={cn("rounded-full border px-3 py-1 text-sm", filtro === f ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-accent/40")}
            aria-current={filtro === f ? "true" : undefined}
          >
            {FILTROS[f]}
          </Link>
        ))}
        <form action="/agencia/trilhas" className="ml-auto">
          {filtro !== "todas" && <input type="hidden" name="filtro" value={filtro} />}
          <input name="q" defaultValue={busca} placeholder="Buscar cliente" aria-label="Buscar cliente" className="h-9 w-48 rounded-md border bg-background px-2 text-sm" />
        </form>
      </div>

      {visiveis.length === 0 ? (
        <p className="rounded-md border p-4 text-sm text-muted-foreground">
          {trilhas.length === 0 ? "Nenhuma trilha em andamento. Escolha um cliente abaixo para iniciar." : "Nenhuma trilha neste filtro."}
        </p>
      ) : (
        <ul className="space-y-3" data-testid="lista-de-trilhas">
          {visiveis.map((t) => (
            <li key={t.id}>
              <Link href={`/agencia/trilhas/${t.clienteId}`} className="block space-y-2 rounded-md border p-4 hover:bg-accent/40" data-testid="trilha-na-lista">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{t.clienteNome}</span>
                  <span className="text-xs text-muted-foreground">
                    {t.etapaAtual ? (ROTULO_DA_ETAPA[t.etapaAtual] ?? `Etapa ${t.etapaAtual}`) : "Tudo feito"} · {t.progresso.feitos} de {t.progresso.total}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full bg-primary" style={{ width: `${t.progresso.pct}%` }} />
                </div>
                {t.proximoPrazo && (
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-muted-foreground">Próximo:</span>
                    <span>{t.proximoPrazo.titulo}</span>
                    <Reloginho prazo={t.proximoPrazo.prazo} />
                  </div>
                )}
                {t.atrasados.length > 0 && <p className="text-xs font-medium text-destructive">Atrasado: {t.atrasados.join(", ")}</p>}
              </Link>
            </li>
          ))}
        </ul>
      )}

      {semTrilha.length > 0 && filtro === "todas" && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground">Clientes sem trilha</h2>
          <ul className="flex flex-wrap gap-2" data-testid="clientes-sem-trilha">
            {semTrilha.map((c) => (
              <li key={c.id}>
                <Link href={`/agencia/trilhas/${c.id}`} className="inline-block rounded-md border px-3 py-1.5 text-sm hover:bg-accent/40">
                  {c.nome}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
