import { Skeleton } from "@/components/ui/skeleton";

export default function InteligenciaLoading() {
  return (
    <div className="space-y-4 p-6">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-4 w-96" />
      <Skeleton className="h-[560px] w-full" />
    </div>
  );
}
