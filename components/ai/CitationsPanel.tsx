"use client";
import type { Citation } from "@/lib/ai/citations/types";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  citations: Citation[];
  messageId?: string;
}

const SOURCE_LABEL: Record<string, string> = {
  faq: "FAQ",
  policy: "Política",
  conversation: "Conversa",
  conversations: "Conversa",
  catalog: "Catálogo",
};

export function CitationsPanel({
  open,
  onOpenChange,
  citations,
  messageId,
}: Props) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Citações da resposta IA</SheetTitle>
        </SheetHeader>
        <div className="mt-4 space-y-4 overflow-y-auto pr-2">
          {citations.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Resposta sem RAG hits — modelo respondeu sem usar a base de
              conhecimento.
            </p>
          ) : (
            citations.map((c, i) => (
              <div
                key={c.chunk_id ?? `cit-${i}`}
                className="rounded-md border p-3 text-sm"
              >
                <div className="mb-1 flex items-center justify-between">
                  <Badge variant="secondary">
                    {SOURCE_LABEL[c.source_type ?? ""] ??
                      c.source_type ??
                      "Fonte"}
                  </Badge>
                  {typeof c.score === "number" && (
                    <span className="text-xs text-muted-foreground">
                      {Math.round(c.score * 100)}%
                    </span>
                  )}
                </div>
                {c.source_anchor && (
                  <p className="mb-1 text-xs text-muted-foreground">
                    {c.source_anchor}
                  </p>
                )}
                {(c.snippet ?? c.text) && (
                  <p className="line-clamp-4 text-foreground/90">
                    {(c.snippet ?? c.text ?? "").slice(0, 200)}
                  </p>
                )}
              </div>
            ))
          )}
          {messageId && (
            <p className="pt-2 text-[10px] text-muted-foreground">
              message_id: {messageId}
            </p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
