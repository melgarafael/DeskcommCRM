"use client";

import { useT } from "@/hooks/i18n/useT";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { usePermission } from "@/hooks/auth/AuthProvider";
import { ClockCountdown } from "@/lib/ui/icons";

interface ScheduledRow {
  id: string;
  send_at: string;
  body: string | null;
  type: string;
}

interface Props {
  conversationId: string;
}

export function ScheduledMessagesBanner({ conversationId }: Props) {
  const t = useT();
  const pode = usePermission("scheduled-messages.view");
  const qc = useQueryClient();
  const key = ["scheduled-messages", conversationId];

  const { data } = useQuery({
    enabled: pode && !!conversationId,
    queryKey: key,
    queryFn: async () =>
      apiClient.get<{ data: ScheduledRow[] }>(
        `/api/v1/conversations/${conversationId}/scheduled-messages`,
      ),
    select: (res) => res.data,
    refetchInterval: 60_000,
  });

  const cancel = useMutation({
    mutationFn: async (id: string) => apiClient.delete(`/api/v1/scheduled-messages/${id}`),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key });
      toast.success(t("Agendamento cancelado."));
    },
  });

  if (!data?.length) return null;

  return (
    <div className="space-y-1 border-b bg-muted/30 px-3 py-2">
      {data.map((row) => {
        const quando = new Date(row.send_at).toLocaleString("pt-BR", {
          dateStyle: "short",
          timeStyle: "short",
        });
        return (
          <div key={row.id} className="flex items-center gap-2 text-xs text-muted-foreground">
            <ClockCountdown size={14} weight="duotone" className="shrink-0 text-primary" />
            <span className="min-w-0 flex-1 truncate">
              {t("Agendada para")} {quando}
              {row.body ? ` — ${row.body}` : ""}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 px-2 text-xs"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate(row.id)}
            >
              {t("Cancelar")}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
