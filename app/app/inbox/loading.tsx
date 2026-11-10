import { Skeleton } from "@/components/ui/skeleton";

// No celular cabe uma coluna: o esqueleto é o da lista, como a tela que vem.
export default function InboxLoading() {
  return (
    <div className="flex h-full">
      <div className="w-full space-y-3 border-r p-4 md:w-80">
        <Skeleton className="h-9 w-full" />
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-10 w-10 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
        ))}
      </div>
      <div className="hidden flex-1 space-y-4 p-6 md:block">
        <Skeleton className="h-12 w-1/3" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    </div>
  );
}
