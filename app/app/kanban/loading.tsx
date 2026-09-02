import { Skeleton } from "@/components/ui/skeleton";

export default function KanbanLoading() {
  return (
    /* O MESMO escopo do `page.tsx` — ver o comentario la. Esqueleto sobre
       fundo escuro que clareia ao carregar faz a tela parecer quebrada. */
    <div
      data-superficie="clara"
      className="-m-6 min-h-[calc(100%+3rem)] bg-bg p-6 text-text"
    >
      <Skeleton className="h-8 w-64 mb-6" />
      <div className="flex gap-4 overflow-x-auto">
        {Array.from({ length: 5 }).map((_, col) => (
          <div key={col} className="w-72 flex-shrink-0 space-y-3">
            <Skeleton className="h-6 w-32" />
            {Array.from({ length: 3 }).map((_, card) => (
              <Skeleton key={card} className="h-24 w-full" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
