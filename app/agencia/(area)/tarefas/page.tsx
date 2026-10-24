import Link from "next/link";
import { Suspense } from "react";

import { QuadroDeTarefas } from "@/components/agencia/tarefas/QuadroDeTarefas";
import { requireAreaDaAgencia } from "@/lib/agencia/acesso";
import { apoioDoQuadro, carregarQuemOlha, listarTarefas } from "@/lib/agencia/tarefas/consultas";

export const metadata = { title: "Tarefas · Agência" };
export const dynamic = "force-dynamic";

/** O quadro de tarefas da agência (docs/agencia/SPEC-tarefas.md). */
export default async function PaginaDeTarefas() {
  const ctx = await requireAreaDaAgencia();
  const quem = await carregarQuemOlha(ctx);
  const [tarefas, apoio] = await Promise.all([listarTarefas(quem), apoioDoQuadro(quem)]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Tarefas</h1>
          <p className="text-sm text-muted-foreground">
            {quem.verTodas ? "Todas as tarefas da agência." : "As suas tarefas e as da sua função."}
          </p>
        </div>
        {ctx.permissoes.has("tarefas.atribuir") && (
          <Link href="/agencia/tarefas/recorrentes" className="text-sm underline underline-offset-4">
            Tarefas recorrentes
          </Link>
        )}
      </div>
      <Suspense>
        <QuadroDeTarefas
          tarefas={tarefas}
          apoio={apoio}
          meuMembroId={ctx.membro?.id ?? null}
          podeCriar={ctx.permissoes.has("tarefas.criar")}
          podeAtribuir={ctx.permissoes.has("tarefas.atribuir")}
        />
      </Suspense>
    </div>
  );
}
