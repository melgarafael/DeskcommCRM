import { Skeleton } from "@/components/ui/skeleton";

export default function AppLoading() {
  return (
    /* Superficie clara. Este esqueleto e o que aparece enquanto `/app` decide
       para onde redirecionar (a propria `page.tsx` so faz `redirect`), entao ele
       e a unica coisa que essa rota chega a pintar. */
    <div
      data-superficie="clara"
      className="-m-6 flex min-h-[calc(100%+3rem)] flex-col gap-4 bg-bg p-6 text-text"
    >
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}
