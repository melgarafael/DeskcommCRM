"use client";
/**
 * "Quem pode receber agora" — a disponibilidade de cada atendente, na MESMA
 * tela em que se escolhe como distribuir (Automações, out/2026).
 *
 * Antes ela morava só em Equipe, e quem ligava o rodízio (ou um fluxo com
 * "Distribuir atendimento") não via que ninguém estava marcado disponível: a
 * conversa ia para a fila ou para "Ninguém disponível" sem explicação. Medido no
 * teste: o único atendente da empresa estava indisponível e ninguém sabia.
 *
 * A situação de cada pessoa é a conta do roteador (`situacaoDoAtendente`), então
 * a tela diz exatamente o que o rodízio e o bloco do fluxo vão fazer.
 */
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useAttendants, useUpdateAvailability } from "@/hooks/team/useAttendants";
import { useT } from "@/hooks/i18n/useT";
import { ROTULO_DA_SITUACAO, situacaoDoAtendente, type SituacaoDoAtendente } from "@/lib/routing/situacao";
import { cn } from "@/lib/utils";

const COR_DA_SITUACAO: Record<SituacaoDoAtendente, string> = {
  pode_receber: "bg-success-bg text-success-fg",
  indisponivel: "bg-error-bg text-error-fg",
  fora_do_horario: "bg-warning-bg text-warning-fg",
  lotado: "bg-warning-bg text-warning-fg",
};

export function QuemPodeReceber() {
  const t = useT();
  const { data, isLoading, isError } = useAttendants();
  const atualizar = useUpdateAvailability();
  const agora = new Date();
  const lista = data?.data ?? [];
  const recebem = lista.filter(
    (a) =>
      situacaoDoAtendente(
        { isAvailable: a.is_available, capacity: a.capacity, currentLoad: a.current_load, schedule: a.schedule },
        agora,
      ) === "pode_receber",
  ).length;

  return (
    <Card className="max-w-3xl space-y-4 p-4" data-testid="quem-pode-receber">
      <div>
        <h2 className="text-sm font-semibold">{t("Quem pode receber agora")}</h2>
        <p className="text-xs text-muted-foreground">
          {t(
            "O rodízio, a menor carga e o bloco Distribuir atendimento dos fluxos só entregam para quem está disponível, dentro do horário e abaixo do limite de conversas. Ligue aqui quem deve receber.",
          )}{" "}
          {t(
            "Se um número de WhatsApp tiver responsáveis marcados mais abaixo, só eles recebem as conversas daquele número.",
          )}
        </p>
      </div>

      {isLoading ? (
        <p className="text-xs text-muted-foreground">{t("Carregando a equipe…")}</p>
      ) : isError ? (
        <p className="text-xs text-error-fg">{t("Não consegui carregar a equipe. Recarregue a página.")}</p>
      ) : lista.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("Nenhum atendente na equipe ainda.")}</p>
      ) : (
        <>
          <p
            className={cn("rounded-md p-2 text-xs", recebem === 0 ? "bg-error-bg text-error-fg" : "bg-muted/40")}
            data-testid="resumo-quem-recebe"
          >
            {recebem === 0
              ? t("Ninguém pode receber conversa agora — toda conversa nova fica na fila.")
              : `${recebem} ${t("de")} ${lista.length} ${t("atendente(s) podem receber conversa agora.")}`}
          </p>
          <ul className="divide-y divide-border rounded-md border border-border">
            {lista.map((a) => {
              const situacao = situacaoDoAtendente(
                { isAvailable: a.is_available, capacity: a.capacity, currentLoad: a.current_load, schedule: a.schedule },
                agora,
              );
              const temJornada = (a.schedule?.windows?.length ?? 0) > 0;
              return (
                <li key={a.user_id} className="flex flex-wrap items-center gap-3 p-2 text-sm" data-testid={`atendente-${a.user_id}`}>
                  <div className="min-w-40 flex-1">
                    <p className="font-medium">{a.name ?? a.email ?? t("Sem nome")}</p>
                    <p className="text-xs text-muted-foreground">
                      {a.current_load} {t("conversa(s) aberta(s)")}
                      {temJornada ? ` · ${t("com horário de trabalho")}` : ` · ${t("sem horário (24h)")}`}
                    </p>
                  </div>
                  <span className={cn("rounded-full px-2 py-0.5 text-xs", COR_DA_SITUACAO[situacao])}>
                    {t(ROTULO_DA_SITUACAO[situacao])}
                  </span>
                  <label className="flex items-center gap-2 text-xs">
                    {t("Limite")}
                    <Input
                      type="number"
                      min={1}
                      max={500}
                      className="h-8 w-20"
                      aria-label={`${t("Limite de conversas de")} ${a.name ?? a.email ?? ""}`}
                      defaultValue={a.capacity ?? 5}
                      disabled={atualizar.isPending}
                      onBlur={(e) => {
                        const n = Math.min(500, Math.max(1, Number(e.target.value) || 1));
                        if (n !== a.capacity) atualizar.mutate({ userId: a.user_id, patch: { capacity: n } });
                      }}
                    />
                  </label>
                  <label className="flex items-center gap-2 text-xs">
                    {t("Disponível")}
                    <Switch
                      checked={a.is_available}
                      disabled={atualizar.isPending}
                      aria-label={`${t("Disponível")}: ${a.name ?? a.email ?? ""}`}
                      onCheckedChange={(v) => atualizar.mutate({ userId: a.user_id, patch: { is_available: v } })}
                    />
                  </label>
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-muted-foreground">
            {t("O horário de trabalho de cada pessoa se ajusta em")}{" "}
            <Link href="/app/team" className="underline">
              {t("Equipe")}
            </Link>
            .
          </p>
        </>
      )}
    </Card>
  );
}
