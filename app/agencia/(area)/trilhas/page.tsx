import Link from "next/link";

import { requireAreaDaAgencia } from "@/lib/agencia/acesso";
import { carregarAlcance } from "@/lib/agencia/clientes/visibilidade";
import { listarTrilhasAtivas } from "@/lib/agencia/trilhas/consultas";
import { ROTULO_DA_ETAPA } from "@/lib/agencia/trilhas/vocabulario";

export const metadata = { title: "Trilhas · Agência" };
export const dynamic = "force-dynamic";

/** Todas as trilhas ativas dos clientes que a pessoa alcança (docs/agencia/SPEC-trilhas.md › Telas). */
export default async function PaginaDasTrilhas() {
  const ctx = await requireAreaDaAgencia();
  const trilhas = await listarTrilhasAtivas(await carregarAlcance(ctx));
  const comAtraso = trilhas.filter((t) => t.atrasados.length > 0).length;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Trilhas</h1>
          <p className="text-sm text-muted-foreground">
            Em que ponto cada cliente está{comAtraso ? ` · ${comAtraso} com passo atrasado` : ""}.
          </p>
        </div>
        {ctx.permissoes.has("trilhas.gerenciar") && (
          <Link href="/agencia/trilhas/modelos" className="text-sm underline underline-offset-4">
            Modelos de trilha
          </Link>
        )}
      </div>

      {trilhas.length === 0 ? (
        <p className="rounded-md border p-4 text-sm text-muted-foreground">
          Nenhuma trilha em andamento. Inicie a trilha na ficha do cliente, aba Trilha.
        </p>
      ) : (
        <ul className="space-y-3" data-testid="lista-de-trilhas">
          {trilhas.map((t) => (
            <li key={t.id}>
              <Link href={`/agencia/clientes/${t.clienteId}?aba=trilha`} className="block space-y-2 rounded-md border p-4 hover:bg-accent/40">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{t.clienteNome}</span>
                  <span className="text-xs text-muted-foreground">
                    {t.etapaAtual ? (ROTULO_DA_ETAPA[t.etapaAtual] ?? `Etapa ${t.etapaAtual}`) : "Tudo feito"} · {t.progresso.pct}%
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full bg-primary" style={{ width: `${t.progresso.pct}%` }} />
                </div>
                {t.atrasados.length > 0 && <p className="text-xs font-medium text-destructive">Atrasado: {t.atrasados.join(", ")}</p>}
                {t.proximos.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Agora: {t.proximos.slice(0, 4).join(", ")}
                    {t.proximos.length > 4 ? ` e mais ${t.proximos.length - 4}` : ""}
                  </p>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
