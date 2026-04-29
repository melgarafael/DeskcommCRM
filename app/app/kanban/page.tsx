import Link from "next/link";
import { Kanban } from "@/lib/ui/icons";
import { Badge } from "@/components/ui/badge";
import { EmptyPipeline } from "@/components/empty";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function KanbanPickerPage() {
  const supabase = await createClient();
  const { data: pipelines } = await supabase
    .from("crm_pipelines")
    .select("id, name, slug, is_default, description")
    .eq("is_archived", false)
    .order("position");

  const list = pipelines ?? [];

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex items-center gap-3">
        <Kanban size={28} className="text-muted-foreground" weight="duotone" />
        <h1 className="text-2xl font-semibold tracking-tight">Pipelines</h1>
      </header>

      {list.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyPipeline
            primary={{ label: "Ir para Configurações", href: "/app/settings" }}
          />
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {list.map((p) => (
            <li key={p.id}>
              <Link
                href={`/app/pipelines/${p.id}`}
                className="flex items-center justify-between rounded-md border border-border bg-surface px-4 py-3 transition-colors hover:border-border-strong"
              >
                <div className="flex flex-col">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{p.name}</span>
                    {p.is_default && (
                      <Badge variant="secondary" className="text-[10px]">
                        Default
                      </Badge>
                    )}
                  </div>
                  {p.description && (
                    <span className="text-xs text-muted-foreground">
                      {p.description}
                    </span>
                  )}
                </div>
                <span className="text-xs text-muted-foreground">/{p.slug}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
