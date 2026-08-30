"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";

/**
 * Remarca e cancela de verdade — `PATCH` e `DELETE /api/v1/agenda/agendamentos`.
 *
 * ═══ O defeito que estes hooks fecham ═══
 *
 * `HistoricoDaAgenda` aceita `onRemarcar` e `onCancelar` desde que nasceu, com
 * `disabled={!onRemarcar}` nos botões — e `app/app/agenda/_client.tsx` montava o
 * componente **sem nenhuma callback**. Resultado: os dois botões nasciam CINZAS
 * em toda linha, de toda organização, para sempre. Controle decorativo, que é um
 * defeito que esta base já pagou uma vez (PR #295, cinco deles).
 *
 * E o `title` do botão cinza dizia "Disponível quando a agenda estiver
 * conectada" — falso, e pior que o silêncio: PATCH e DELETE não tocam o Google.
 * Quem lia acreditava que faltava conectar a agenda, quando faltava a fiação.
 *
 * Medido antes: `grep -rn "crm_cancel_appointment|cancelarAgendamentoHandler|
 * alterarAgendamentoHandler" app/ components/ hooks/` → zero em `components/`,
 * zero em `hooks/`, zero em qualquer `app/app/**`. **Só a IA conseguia remarcar
 * ou cancelar** — a pessoa que atende, não.
 *
 * As duas mutações invalidam `["agenda"]`, a mesma chave que `useAgendamentos`
 * usa, então a grade e o histórico repintam sozinhos.
 */
export function useRemarcarAgendamento() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (entrada: { id: string; starts_at: string; guest_email?: string }) =>
      apiClient.patch<{ data: { id: string } }>("/api/v1/agenda/agendamentos", entrada),
    onSuccess: () => {
      toast.success("Agendamento remarcado.");
      void qc.invalidateQueries({ queryKey: ["agenda"] });
    },
    onError: (err) => showApiError(err),
  });
}

export function useCancelarAgendamento() {
  const qc = useQueryClient();
  return useMutation({
    // O `reason` é obrigatório na rota (mínimo 3 caracteres) e não é burocracia:
    // é o que a equipe lê ao ver o horário vago. A tela pede antes de chamar.
    mutationFn: async (entrada: { id: string; reason: string }) =>
      apiClient.delete<{ data: { id: string } }>("/api/v1/agenda/agendamentos", entrada),
    onSuccess: () => {
      toast.success("Agendamento cancelado.");
      void qc.invalidateQueries({ queryKey: ["agenda"] });
    },
    onError: (err) => showApiError(err),
  });
}

/**
 * Registra o DESFECHO — `PATCH /api/v1/agenda/agendamentos` com `status`.
 *
 * ═══ O mesmo defeito, nos outros dois botões do mesmo componente ═══
 *
 * O cabeçalho deste arquivo narra o conserto de `onRemarcar`/`onCancelar` — e
 * ele alcançou DOIS dos QUATRO botões de `HistoricoDaAgenda`. "Realizado" e
 * "Faltou" seguiram com `disabled={!onRealizado}` e ZERO callers no repo
 * inteiro, ainda cinzas em toda linha de toda organização, ainda com a mesma
 * frase falsa: "Disponível quando a agenda estiver conectada". PATCH de status
 * não toca o Google.
 *
 * É a lição de "conserto por instância, não por classe" cobrada com juros: as
 * quatro props nasceram juntas, no mesmo componente, com o mesmo padrão — e a
 * varredura que consertaria as quatro custaria um `grep` a mais.
 *
 * A capacidade existia inteira do outro lado: a rota já aceita
 * `status: z.enum(["confirmed", "completed", "no_show"])` e o handler já aplica.
 * Faltava só o fio.
 *
 * ⚠️ EFEITO COLATERAL QUE NINGUÉM ANTECIPA AO CLICAR, e por isso está escrito:
 * `no_show` está em `SITUACOES_QUE_LIBERAM` (com `cancelled`), então marcar
 * "Faltou" DEVOLVE o horário para outra pessoa poder pegar. É o comportamento
 * correto — a vaga de quem não veio não pode ficar reservada —, mas é a razão de
 * o toast dizer o que aconteceu em vez de um "ok" mudo.
 */
export function useRegistrarDesfecho() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (entrada: { id: string; status: "completed" | "no_show" }) =>
      apiClient.patch<{ data: { id: string } }>("/api/v1/agenda/agendamentos", entrada),
    onSuccess: (_dados, entrada) => {
      toast.success(
        entrada.status === "completed"
          ? "Marcado como realizado."
          : "Marcado como falta — o horário volta a ficar livre.",
      );
      void qc.invalidateQueries({ queryKey: ["agenda"] });
    },
    onError: (err) => showApiError(err),
  });
}
