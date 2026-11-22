"use client";

import Link from "next/link";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";
import { etapasAbertasDoDestino, useDestinosDeFunil } from "@/hooks/kanban/useDestinosDeFunil";
import { apiClient } from "@/lib/api/client";
import { levarEmLote, MAXIMO_DO_LOTE_ENTRE_FUNIS, type ResultadoDoLote } from "@/lib/kanban/levar-em-lote";

/**
 * "Levar para outro funil" EM LOTE — a barra de seleção do quadro.
 *
 * O "Mover para…" da barra só troca de ETAPA dentro do mesmo funil. Levar
 * vários negócios para OUTRO funil (o fim do funil de vendas para o de
 * pós-venda, um funil desativado para o novo) obrigava a abrir card por card.
 *
 * O que acontece com cada negócio é EXATAMENTE o do diálogo de um card só
 * (`MoveToOtherPipelineDialog`): a mesma rota (`POST /api/v1/leads/[id]/clone`),
 * o mesmo destino, a mesma etapa de entrada opcional. Ver `levar-em-lote.ts`
 * para o porquê de não haver rota em lote.
 *
 * Três estados na mesma janela — escolher, levando (com progresso) e o
 * RESULTADO, que fica aberto até a pessoa fechar: um toast de "3 recusados"
 * some antes de alguém ler QUAIS e POR QUÊ.
 */
interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pipelineId: string;
  leadIds: string[];
  /** O título do card, para nomear quem foi recusado. */
  tituloDe?: (leadId: string) => string | undefined;
  /** Chamado ao fechar depois de levar — a seleção já não existe no quadro. */
  onConcluido?: () => void;
}

export function LevarLoteParaOutroFunilDialog({
  open,
  onOpenChange,
  pipelineId,
  leadIds,
  tituloDe,
  onConcluido,
}: Props) {
  const t = useT();
  const qc = useQueryClient();
  const [destinoId, setDestinoId] = useState("");
  const [etapaId, setEtapaId] = useState("");
  const [progresso, setProgresso] = useState<{ feitos: number; total: number } | null>(null);
  const [resultado, setResultado] = useState<ResultadoDoLote | null>(null);

  // Todos os selecionados estão NESTE funil; os destinos de um valem para todos.
  const referencia = leadIds[0] ?? "";
  const destinos = useDestinosDeFunil(referencia, open && referencia !== "");
  const destino = (destinos.data ?? []).find((p) => p.id === destinoId);
  const etapas = etapasAbertasDoDestino(destino);
  const funilSemEtapaAberta = !!destino && etapas.length === 0;
  const levando = progresso !== null && resultado === null;
  const acimaDoTeto = leadIds.length > MAXIMO_DO_LOTE_ENTRE_FUNIS;

  function limpar() {
    setDestinoId("");
    setEtapaId("");
    setProgresso(null);
    setResultado(null);
  }

  function fechar(next: boolean) {
    if (levando) return; // o laço não é cancelável no meio: fechar esconderia o que já foi
    if (!next) {
      const houveEfeito = (resultado?.levados.length ?? 0) > 0;
      limpar();
      if (houveEfeito) onConcluido?.();
    }
    onOpenChange(next);
  }

  async function levar() {
    if (!destinoId || funilSemEtapaAberta || levando) return;
    setProgresso({ feitos: 0, total: Math.min(leadIds.length, MAXIMO_DO_LOTE_ENTRE_FUNIS) });
    const r = await levarEmLote({
      leadIds,
      motivoGenerico: t("Não foi possível levar este negócio."),
      aoProgredir: (feitos, total) => setProgresso({ feitos, total }),
      levar: (leadId) =>
        apiClient.post(`/api/v1/leads/${leadId}/clone`, {
          pipeline_id: destinoId,
          ...(etapaId ? { stage_id: etapaId } : {}),
        }),
    });
    setResultado(r);
    await qc.invalidateQueries({ queryKey: ["board", pipelineId] });
    if (r.levados.length > 0 || r.recusados.some((recusa) => recusa.cloneId)) {
      await qc.invalidateQueries({ queryKey: ["board", destinoId] });
    }
    if (r.levados.length > 0) {
      toast.success(`${r.levados.length} ${t("levados para")} ${destino?.name ?? ""}`.trim());
    }
  }

  return (
    <Dialog open={open} onOpenChange={fechar}>
      <DialogContent data-testid="levar-lote-para-outro-funil">
        <DialogHeader>
          <DialogTitle>{t("Levar selecionados para outro funil")}</DialogTitle>
          <DialogDescription>
            {t(
              'Cada negócio é recriado no funil escolhido e encerra aqui como perdido, com o motivo "Levado para outro funil" — o mesmo que acontece ao levar um card só.',
            )}
          </DialogDescription>
        </DialogHeader>

        {resultado ? (
          <div className="space-y-2 text-sm" data-testid="resultado-do-lote">
            <p>
              {resultado.levados.length} {t("de")}{" "}
              {resultado.levados.length + resultado.recusados.length} {t("negócios levados.")}
            </p>
            {resultado.recusados.length > 0 ? (
              <div>
                <p className="font-medium">{t("Não foram levados:")}</p>
                <ul className="mt-1 max-h-48 list-disc space-y-1 overflow-y-auto pl-5">
                  {resultado.recusados.map((r) => (
                    <li key={r.leadId}>
                      <span className="font-medium">{tituloDe?.(r.leadId) ?? r.leadId}</span>
                      {" — "}
                      {r.motivo}
                      {r.cloneId && (
                        <p className="mt-1">
                          {t("O negócio já foi criado no funil de destino. Confira-o antes de tentar novamente.")}{" "}
                          <Link
                            href={`/app/leads/${encodeURIComponent(r.cloneId)}`}
                            className="font-medium text-primary underline underline-offset-2"
                          >
                            {t("Abrir negócio")}
                          </Link>
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {resultado.foraDoTeto.length > 0 ? (
              <p className="text-text-muted">
                {resultado.foraDoTeto.length}{" "}
                {t("ficaram de fora pelo limite de 50 por vez. Selecione-os de novo para levar.")}
              </p>
            ) : null}
          </div>
        ) : levando ? (
          <p className="text-sm" role="status" data-testid="progresso-do-lote">
            {t("Levando")} {progresso?.feitos ?? 0} {t("de")} {progresso?.total ?? 0}…
          </p>
        ) : (
          <>
            <p className="text-sm">
              {leadIds.length} {t("negócios selecionados.")}
              {acimaDoTeto
                ? ` ${t("Só os 50 primeiros serão levados nesta vez.")}`
                : null}
            </p>
            {destinos.data?.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("Este é o único funil. Crie outro funil para poder levar o negócio até ele.")}
              </p>
            ) : (
              <Select
                value={destinoId}
                onValueChange={(next) => {
                  setDestinoId(next);
                  setEtapaId(""); // a etapa é do funil: a anterior seria recusada (422)
                }}
              >
                <SelectTrigger aria-label={t("Funil de destino")}>
                  <SelectValue placeholder={t("Escolha o funil de destino")} />
                </SelectTrigger>
                <SelectContent>
                  {(destinos.data ?? []).map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {funilSemEtapaAberta ? (
              <p className="text-sm text-destructive" role="alert">
                {t("Este funil não tem etapa aberta para receber o negócio. Escolha outro funil.")}
              </p>
            ) : destino ? (
              <div className="space-y-1">
                <Select value={etapaId} onValueChange={setEtapaId}>
                  <SelectTrigger aria-label={t("Etapa de entrada")}>
                    <SelectValue placeholder={t("Primeira etapa aberta (padrão)")} />
                  </SelectTrigger>
                  <SelectContent>
                    {etapas.map((e) => (
                      <SelectItem key={e.id} value={e.id}>
                        {e.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {t("Sem escolha, o negócio entra na primeira etapa aberta do funil.")}
                </p>
              </div>
            ) : null}
          </>
        )}

        <DialogFooter>
          {resultado ? (
            <Button onClick={() => fechar(false)}>{t("Fechar")}</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => fechar(false)} disabled={levando}>
                {t("Cancelar")}
              </Button>
              <Button
                onClick={levar}
                disabled={!destinoId || funilSemEtapaAberta || levando}
                data-testid="confirmar-lote"
              >
                {levando ? t("Levando…") : t("Levar")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
