"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiClient } from "@/lib/api/client";

export interface ResolveIncidentPayload {
  id: string;
  resolution_note: string;
}

export function useResolveIncident() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, resolution_note }: ResolveIncidentPayload) =>
      apiClient.post(`/api/v1/admin/incidents/${id}/resolve`, {
        resolution_note,
      }),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "incidents"] });
      void queryClient.invalidateQueries({
        queryKey: ["admin", "incident", variables.id],
      });
      toast.success("Incidente resolvido com sucesso");
    },
    onError: (err: Error) => {
      toast.error("Erro ao resolver incidente", { description: err.message });
    },
  });
}
