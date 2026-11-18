"use client";

import { useCallback, useEffect, useState } from "react";

import { Separator } from "@/components/ui/separator";
import { useT } from "@/hooks/i18n/useT";
import type { ChecklistDoNegocio, ItemDoChecklist } from "@/lib/tarefas/checklist";

interface Props {
  /** O negócio ATIVO do card. Sem ele não há checklist — e a seção não desenha. */
  leadId: string | null;
  /** `agent`+ — a mesma régua de escrita da rota (`.../checklist/[tarefaId]`). */
  podeEditar: boolean;
}

/**
 * O CHECKLIST DO CARD no painel do Inbox (#4717, FASE 1).
 *
 * A pergunta que a issue responde: "em que ponto está este atendimento?" — sem
 * abrir tarefa por tarefa. A lista vem do servidor na ORDEM DO PLANO, com o
 * estado de cada item, quem marcou e quando, e o progresso "N de M concluídas".
 *
 * ═══ O ESTADO DESENHADO É O DO SERVIDOR ═══
 *
 * Marcar não incrementa contador local: o POST devolve a lista INTEIRA, já
 * recalculada no banco, e é ela que este componente desenha. A diferença
 * importa — um contador local mostraria "1 concluída" mesmo quando a escrita
 * falhou, ou quando o item já estava concluído por outro caminho. O painel
 * mostra o card, não o clique.
 *
 * A leitura é própria (`/api/v1/leads/[id]/checklist`) e não o `useTasks`: a
 * lista de tarefas não sabe a ORDEM do plano nem quem marcou; quem sabe é a
 * marca da aplicação, que essa rota lê.
 */
export function ChecklistDoCard({ leadId, podeEditar }: Props) {
  if (!leadId) return null;
  return (
    <>
      <Separator />
      <SecaoDoChecklist leadId={leadId} podeEditar={podeEditar} />
    </>
  );
}

function SecaoDoChecklist({ leadId, podeEditar }: { leadId: string; podeEditar: boolean }) {
  const t = useT();
  const [checklist, setChecklist] = useState<ChecklistDoNegocio | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [falhou, setFalhou] = useState(false);
  const [salvando, setSalvando] = useState<string | null>(null);

  const carregar = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await fetch(`/api/v1/leads/${leadId}/checklist`, { signal });
        if (!res.ok) throw new Error(String(res.status));
        const corpo = (await res.json()) as { data?: { checklist?: ChecklistDoNegocio | null } };
        setChecklist(corpo.data?.checklist ?? null);
        setFalhou(false);
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") return;
        setFalhou(true);
        setChecklist(null);
      } finally {
        setCarregando(false);
      }
    },
    [leadId],
  );

  useEffect(() => {
    const controle = new AbortController();
    setCarregando(true);
    void carregar(controle.signal);
    return () => controle.abort();
  }, [carregar]);

  async function alternar(item: ItemDoChecklist) {
    if (!podeEditar || salvando) return;
    setSalvando(item.tarefa_id);
    try {
      const res = await fetch(`/api/v1/leads/${leadId}/checklist/${item.tarefa_id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concluido: !item.concluido }),
      });
      if (!res.ok) throw new Error(String(res.status));
      // A lista do SERVIDOR substitui a da tela: é o estado do card.
      const corpo = (await res.json()) as { data?: { checklist?: ChecklistDoNegocio } };
      if (corpo.data?.checklist) setChecklist(corpo.data.checklist);
      setFalhou(false);
    } catch {
      // Falha NÃO vira "marcado": o painel continua desenhando o estado que o
      // servidor confirmou por último e diz que não conseguiu salvar.
      setFalhou(true);
    } finally {
      setSalvando(null);
    }
  }

  // Sem plano aplicado não há checklist: a seção simplesmente não existe.
  if (!carregando && !falhou && !checklist) return null;

  const concluidos = checklist?.concluidos ?? 0;
  const total = checklist?.total ?? 0;
  const porcento = total > 0 ? Math.round((concluidos / total) * 100) : 0;

  return (
    <section data-testid="inbox-checklist" aria-busy={carregando}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-text">{t("Checklist do card")}</h3>
        {checklist ? (
          <span className="text-xs text-muted-foreground" data-testid="inbox-checklist-progresso">
            {concluidos} {t("de")} {total} {total === 1 ? t("concluída") : t("concluídas")}
          </span>
        ) : null}
      </div>

      {checklist ? (
        <div
          className="mb-2 h-1.5 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={concluidos}
          aria-label={t("Progresso do checklist")}
        >
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${porcento}%` }} />
        </div>
      ) : null}

      {falhou ? (
        <p className="text-xs text-destructive">{t("Não foi possível carregar o checklist.")}</p>
      ) : carregando ? (
        <p className="text-xs text-muted-foreground">{t("Carregando…")}</p>
      ) : (
        <ul className="space-y-1" data-testid="inbox-checklist-itens">
          {(checklist?.itens ?? []).map((item) => (
            <li key={item.tarefa_id} className="flex items-start gap-2 text-xs">
              <button
                type="button"
                role="checkbox"
                aria-checked={item.concluido}
                aria-label={item.titulo}
                disabled={!podeEditar || salvando === item.tarefa_id}
                onClick={() => void alternar(item)}
                className="mt-0.5 shrink-0 text-sm leading-none disabled:opacity-60"
              >
                {item.concluido ? "✔" : "○"}
              </button>
              <span className="min-w-0 flex-1">
                <span
                  className={
                    item.concluido ? "text-muted-foreground line-through wrap-anywhere" : "wrap-anywhere"
                  }
                >
                  {item.titulo}
                </span>
                {item.concluido && item.marcado_em ? (
                  <span className="ml-1 text-muted-foreground">
                    ·{" "}
                    {[
                      item.marcado_por_nome ?? t("alguém da equipe"),
                      formatarDia(item.marcado_em),
                    ].join(" · ")}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** `dd/mm` — a data da marcação, curta porque a linha é de painel estreito. */
function formatarDia(iso: string): string {
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return "";
  const dia = String(data.getDate()).padStart(2, "0");
  const mes = String(data.getMonth() + 1).padStart(2, "0");
  return `${dia}/${mes}`;
}
