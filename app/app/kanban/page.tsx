import { Kanban } from "@/lib/ui/icons";

export default function KanbanPlaceholderPage() {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <Kanban size={48} className="text-muted-foreground" weight="duotone" />
      <h1 className="mt-4 text-xl font-semibold">Kanban</h1>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">
        Tela em construção. Será entregue no EPIC-04 (Pipeline & Kanban).
      </p>
    </div>
  );
}
