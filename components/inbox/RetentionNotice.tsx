"use client";
import { formatDistanceToNowStrict } from "date-fns";
import { pt as ptBR } from "date-fns/locale";
import { ArrowsClockwise, Scales, ShieldCheck } from "@/lib/ui/icons";
import { retentionCopy, type RetentionKind } from "@/lib/inbox/retention-copy";
import { useRetention } from "@/hooks/inbox/useRetention";
import { cn } from "@/lib/utils";

const KIND_ICON: Record<RetentionKind, typeof ShieldCheck> = {
  protection: ShieldCheck,
  compliance: Scales,
  quality: ArrowsClockwise,
};

const KIND_CLASS: Record<RetentionKind, string> = {
  protection: "border-warning bg-warning-bg text-warning-fg",
  compliance: "border-destructive/40 bg-destructive/10 text-destructive",
  quality: "border-border bg-muted/40 text-muted-foreground",
};

/**
 * Aviso de transparência do anti-ban (Operação Visível F2-i): quando a cadeia
 * before_send reteve a resposta do assistente nas últimas 24h, mostra o MOTIVO
 * traduzido em pt-br leigo acima do composer. Sem veto recente → não renderiza.
 */
export function RetentionNotice({ conversationId }: { conversationId: string }) {
  const { data } = useRetention(conversationId);
  const latest = data?.retentions[0];
  if (!latest || !data) return null;

  const copy = retentionCopy(latest.vetoed_code, data.context);
  const Icon = KIND_ICON[copy.kind];
  const when = formatDistanceToNowStrict(new Date(latest.created_at), {
    addSuffix: true,
    locale: ptBR,
  });

  return (
    <div
      data-testid="retention-notice"
      className={cn("flex items-start gap-2.5 border-t px-4 py-2.5 text-xs", KIND_CLASS[copy.kind])}
    >
      <Icon size={16} weight="duotone" className="mt-0.5 shrink-0" aria-hidden />
      <div className="min-w-0">
        <p className="font-medium">
          {copy.title}
          <span className="ml-2 font-normal opacity-70">{when}</span>
        </p>
        <p className="mt-0.5 opacity-90">{copy.description}</p>
      </div>
    </div>
  );
}
