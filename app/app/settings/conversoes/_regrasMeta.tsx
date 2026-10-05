"use client";

/**
 * O que cada etapa do funil informa à Meta (migration 0524).
 *
 * Uma linha por etapa ABERTA de cada funil: ligada, ela manda o evento padrão
 * escolhido quando um negócio entra ali. Ganho é a compra (cartão da conexão,
 * logo acima) e perda não é conversão — por isso nenhuma das duas aparece aqui.
 */
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { salvarRegrasDeConversaoMeta } from "@/app/actions/settings/salvarRegrasDeConversaoMeta";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  EVENTOS_DA_META,
  eventoRecomendadoParaMeta,
  rotuloDoEventoDaMeta,
  type EventoDaMeta,
  type RegraDeConversaoMeta,
} from "@/lib/conversoes/regras-meta";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

import type { EtapaAberta } from "./_regrasGoogle";

interface Rascunho {
  enabled: boolean;
  metaEvent: EventoDaMeta;
}

const ERRO_EM_PORTUGUES: Record<string, string> = {
  validation_failed: "Escolha um evento da lista para cada etapa ligada.",
  unauthenticated: "Sua sessão expirou. Entre de novo.",
  forbidden_tenant: "Você não está em nenhuma organização ativa.",
  forbidden_role: "Só um administrador da organização pode mudar estas regras.",
  mfa_required: "Confirme o segundo fator para salvar esta mudança.",
  etapa_invalida: "Uma das etapas não existe mais ou foi fechada. Atualize a página.",
  erro_ao_gravar: "Não consegui gravar agora. Tente de novo em instantes.",
};

export function RegrasDeConversaoMeta({
  etapas,
  regras,
  idioma,
}: {
  etapas: EtapaAberta[];
  regras: RegraDeConversaoMeta[];
  idioma: Idioma;
}) {
  const t = (texto: string) => traduzir(texto, idioma);
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const inicial = useMemo(() => {
    const porEtapa = new Map(regras.map((r) => [r.stageId, r]));
    return Object.fromEntries(
      etapas.map((e) => {
        const r = porEtapa.get(e.id);
        const rascunho: Rascunho = r
          ? { enabled: r.enabled, metaEvent: r.metaEvent }
          : { enabled: false, metaEvent: eventoRecomendadoParaMeta(e.nome) ?? "LeadSubmitted" };
        return [e.id, rascunho];
      }),
    ) as Record<string, Rascunho>;
  }, [etapas, regras]);

  const [rascunhos, setRascunhos] = useState(inicial);
  const ligadas = etapas.filter((e) => rascunhos[e.id]?.enabled).length;

  function mudar(id: string, parcial: Partial<Rascunho>) {
    setRascunhos((atual) => ({ ...atual, [id]: { ...atual[id]!, ...parcial } }));
  }

  function usarRecomendado() {
    setRascunhos((atual) => {
      const novo = { ...atual };
      for (const e of etapas) {
        const sugestao = eventoRecomendadoParaMeta(e.nome);
        if (!sugestao) continue;
        novo[e.id] = { enabled: true, metaEvent: sugestao };
      }
      return novo;
    });
    toast.message(t("Etapas recomendadas ligadas. Confira e salve."));
  }

  function salvar() {
    startTransition(async () => {
      const resultado = await salvarRegrasDeConversaoMeta(
        etapas.map((e) => {
          const r = rascunhos[e.id]!;
          return { stage_id: e.id, enabled: r.enabled, meta_event: r.metaEvent };
        }),
      );
      if (resultado.ok) {
        toast.success(t("Regras salvas."));
        router.refresh();
        return;
      }
      toast.error(t(ERRO_EM_PORTUGUES[resultado.error] ?? "Não consegui salvar agora."));
    });
  }

  if (etapas.length === 0) {
    return (
      <Card className="p-6 text-sm text-muted-foreground">
        {t("Crie um funil com etapas para escolher o que cada etapa informa à Meta.")}
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-4 p-6" data-testid="regras-meta-por-etapa">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h3 className="font-medium">{t("O que cada etapa do funil informa à Meta")}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(
              "Além da venda, a Meta pode saber de quem recebeu orçamento ou agendou. Cada etapa ligada envia o seu evento uma vez por negócio, quando ele entra ali, e o anúncio aprende antes de a venda fechar.",
            )}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground" data-testid="etapas-meta-enviando">
            {ligadas} {t("de")} {etapas.length} {t("etapas enviando")}
          </span>
          <Button type="button" variant="outline" onClick={usarRecomendado}>
            {t("Usar o recomendado")}
          </Button>
        </div>
      </div>

      <ul className="flex flex-col gap-3">
        {etapas.map((e) => {
          const r = rascunhos[e.id]!;
          return (
            <li key={e.id} className="rounded-md border p-4" data-testid={`regra-meta-${e.id}`}>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{e.nome}</p>
                  <p className="text-xs text-muted-foreground">
                    {e.funil}
                    {" · "}
                    {r.enabled ? t(rotuloDoEventoDaMeta(r.metaEvent)) : t("não envia evento")}
                  </p>
                </div>
                <Switch
                  aria-label={t("Enviar evento à Meta nesta etapa")}
                  checked={r.enabled}
                  onCheckedChange={(v) => mudar(e.id, { enabled: v })}
                />
              </div>

              {r.enabled && (
                <div className="mt-4 flex flex-col gap-2 md:max-w-sm">
                  <Label htmlFor={`evento-meta-${e.id}`}>{t("Evento enviado à Meta")}</Label>
                  <select
                    id={`evento-meta-${e.id}`}
                    className="rounded-md border bg-background p-2 text-sm"
                    value={r.metaEvent}
                    onChange={(ev) => mudar(e.id, { metaEvent: ev.target.value as EventoDaMeta })}
                  >
                    {EVENTOS_DA_META.map((ev) => (
                      <option key={ev.valor} value={ev.valor}>
                        {t(ev.rotulo)} ({ev.valor})
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <p className="text-xs text-muted-foreground">
        {t(
          "Os eventos só saem quando o negócio muda de etapa — pela equipe, pela IA ou por automação — e só para quem veio de anúncio da Meta. Saem sem valor: o valor vai na compra. Movimentos anteriores a ligar a regra não são enviados.",
        )}
      </p>
      <div>
        <Button type="button" onClick={salvar} disabled={isPending}>
          {isPending ? t("Salvando...") : t("Salvar regras")}
        </Button>
      </div>
    </Card>
  );
}
