import { Skeleton } from "@/components/ui/skeleton";

export default function KanbanLoading() {
  return (
    <div className="p-6">
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
