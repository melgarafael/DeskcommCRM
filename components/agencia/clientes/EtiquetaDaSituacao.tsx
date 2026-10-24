import { ROTULO_DA_SITUACAO, TOM_DA_SITUACAO, type SituacaoDoCliente } from "@/lib/agencia/clientes/vocabulario";
import { cn } from "@/lib/utils";

const CLASSE_DO_TOM = {
  neutro: "bg-muted text-muted-foreground",
  andamento: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  ativo: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  parado: "bg-slate-500/15 text-slate-600 dark:text-slate-400",
} as const;

export function EtiquetaDaSituacao({ situacao }: { situacao: SituacaoDoCliente }) {
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-xs", CLASSE_DO_TOM[TOM_DA_SITUACAO[situacao]])}>
      {ROTULO_DA_SITUACAO[situacao]}
    </span>
  );
}
