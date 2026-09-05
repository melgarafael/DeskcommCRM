"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { EdicaoDaTarefa, NovaTarefa, Tarefa } from "@/lib/tarefas/tipos";

/**
 * As tarefas da organização, com as três mutações que a tela dispara.
 *
 * Extraído do PR #418 (@clinicacentrodosorrisosc-code). O `refetchInterval` do
 * original saiu: recarregar a lista inteira a cada 30 s custa uma consulta por
 * aba aberta o dia inteiro para dado que só muda quando alguém desta mesma aba
 * mexe. As mutações já invalidam a chave — o que faltava era a volta ao foco,
 * que cobre o caso real de duas pessoas do time editando ao mesmo tempo.
 */
const BASE = "/api/v1/tasks";
const CHAVE = ["crm_tasks"] as const;

export interface FiltrosDeTarefa {
  status?: string;
  priority?: string;
  lead_id?: string;
  contact_id?: string;
  /** `true` = só o que ainda pede ação (pendente ou em andamento). */
  aberto?: boolean;
}

async function leJson<T>(res: Response, oQueFalhou: string): Promise<T> {
  if (!res.ok) {
    // A mensagem do servidor quando ela existe: `fail()` nomeia o campo
    // recusado, e engolir isso deixaria a tela dizendo "erro" sobre um título
    // vazio que o usuário consegue consertar sozinho.
    const corpo = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(corpo?.error?.message ?? oQueFalhou);
  }
  const json = (await res.json()) as { data: T };
  return json.data;
}

export function useTasks(filtros: FiltrosDeTarefa = {}) {
  const queryClient = useQueryClient();

  const params = new URLSearchParams();
  if (filtros.status) params.set("status", filtros.status);
  if (filtros.priority) params.set("priority", filtros.priority);
  if (filtros.lead_id) params.set("lead_id", filtros.lead_id);
  if (filtros.contact_id) params.set("contact_id", filtros.contact_id);
  if (filtros.aberto) params.set("aberto", "true");
  const qs = params.toString();

  const query = useQuery({
    queryKey: [...CHAVE, qs],
    queryFn: async () => {
      const res = await fetch(qs ? `${BASE}?${qs}` : BASE);
      return leJson<{ tasks: Tarefa[] }>(res, "Não foi possível carregar as tarefas.");
    },
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  });

  const invalidar = () => queryClient.invalidateQueries({ queryKey: CHAVE });

  const criar = useMutation({
    mutationFn: async (entrada: NovaTarefa) => {
      const res = await fetch(BASE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entrada),
      });
      return leJson<{ task: Tarefa }>(res, "Não foi possível criar a tarefa.");
    },
    onSuccess: invalidar,
  });

  const editar = useMutation({
    mutationFn: async ({ id, entrada }: { id: string; entrada: EdicaoDaTarefa }) => {
      const res = await fetch(`${BASE}/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entrada),
      });
      return leJson<{ task: Tarefa }>(res, "Não foi possível salvar a tarefa.");
    },
    onSuccess: invalidar,
  });

  const apagar = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`${BASE}/${id}`, { method: "DELETE" });
      return leJson<{ deleted: boolean }>(res, "Não foi possível apagar a tarefa.");
    },
    onSuccess: invalidar,
  });

  return {
    tarefas: query.data?.tasks ?? [],
    carregando: query.isLoading,
    falhou: query.isError,
    recarregar: invalidar,
    criarTarefa: (entrada: NovaTarefa) => criar.mutateAsync(entrada),
    editarTarefa: (id: string, entrada: EdicaoDaTarefa) => editar.mutateAsync({ id, entrada }),
    apagarTarefa: (id: string) => apagar.mutateAsync(id),
    alternarConcluida: (tarefa: Tarefa) =>
      editar.mutateAsync({
        id: tarefa.id,
        entrada: { status: tarefa.status === "done" ? "pending" : "done" },
      }),
  };
}
