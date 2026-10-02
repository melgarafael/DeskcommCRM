"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { ROTULO_DO_ESTADO } from "@/lib/cobranca/rotulos";
import type { EstadoDaAssinatura } from "@/lib/cobranca/vocabulario";
import { useIdioma } from "@/lib/i18n/IdiomaProvider";

export interface PlanoDoCard {
  id: string;
  nome: string;
  arquivado_em: string | null;
}

export interface AssinaturaDoCard {
  plano_id: string;
  estado: EstadoDaAssinatura;
  trial_ate: string | null;
  prazo_extra_ate: string | null;
  provedor: string | null;
}

/** `YYYY-MM-DD` do campo de data → fim daquele dia no fuso de quem clicou, em ISO UTC. */
export function fimDoDia(dia: string): string {
  return new Date(`${dia}T23:59:59`).toISOString();
}

/** A frase de cada recurso que passa do plano; `{n}` é quanto remover. */
const FRASE_DO_EXCEDENTE = {
  assentos: "Revogue o acesso de {n} pessoa(s) em Equipe.",
  canais: "Exclua {n} número(s) em Conexões.",
} as const;
type RecursoExcedente = keyof typeof FRASE_DO_EXCEDENTE;

/**
 * D-4 (spec da cobrança §7e): o 409 `plan_limit_reached` da troca/atribuição
 * traz `details.excedente = { assentos?, canais? }` (Task 25). A tela mostra o
 * que remover, recurso a recurso. Lista vazia = não é esse erro, ou veio sem
 * número — o chamador segue pelo toast de sempre.
 */
export function oQueRemover(err: unknown): Array<{ recurso: RecursoExcedente; n: number }> {
  if (!(err instanceof ApiError) || err.code !== "plan_limit_reached") return [];
  const excedente = err.details?.excedente;
  if (typeof excedente !== "object" || excedente === null) return [];
  return (Object.keys(FRASE_DO_EXCEDENTE) as RecursoExcedente[]).flatMap((recurso) => {
    const n = (excedente as Record<string, unknown>)[recurso];
    return typeof n === "number" && n > 0 ? [{ recurso, n }] : [];
  });
}

/**
 * O card Cobrança do painel da empresa (spec da cobrança §7g, §9). Só é montado
 * com a chave ligada (a página decide). Cada botão é uma rota do dono; a rota
 * é quem recusa (plano de outro intervalo, teste vencido, uso acima do plano) e
 * a frase dela vira o aviso. Depois de cada ação a página relê o servidor.
 */
export function CardDeCobranca({
  orgId,
  planos,
  assinatura,
  suspensaPorCobranca,
  rotuloAntigo,
}: {
  orgId: string;
  planos: readonly PlanoDoCard[];
  assinatura: AssinaturaDoCard | null;
  suspensaPorCobranca: boolean;
  rotuloAntigo: string | null;
}) {
  const t = useT();
  const idioma = useIdioma();
  const router = useRouter();
  const queryClient = useQueryClient();
  const ativos = planos.filter((p) => p.arquivado_em === null);
  const [escolhido, setEscolhido] = useState(ativos[0]?.id ?? "");
  const [prazo, setPrazo] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [remover, setRemover] = useState<ReturnType<typeof oQueRemover>>([]);
  const base = `/api/v1/admin/tenants/${orgId}/assinatura`;
  const data = new Intl.DateTimeFormat(idioma, { dateStyle: "short" });
  const nomeDoPlano = (id: string) => planos.find((p) => p.id === id)?.nome ?? "—";

  async function agir(acao: () => Promise<unknown>, sucesso: string) {
    setOcupado(true);
    setRemover([]);
    try {
      await acao();
      toast.success(sucesso);
      router.refresh();
      // O refresh só renova o servidor; ações e banner leem o cache do react-query.
      await queryClient.invalidateQueries({ queryKey: ["admin", "tenant", orgId] });
    } catch (err) {
      const lista = oQueRemover(err);
      if (lista.length > 0) setRemover(lista);
      else showApiError(err);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <Card className="space-y-4 p-6" aria-labelledby="cobranca-do-tenant">
      <h2 id="cobranca-do-tenant" className="text-base font-semibold">{t("Cobrança")}</h2>
      {suspensaPorCobranca && (
        <p role="status" className="text-sm text-warning-fg">
          {t("Suspensa por falta de pagamento. Dar prazo ou tornar isenta a reativa na hora.")}
        </p>
      )}
      {assinatura ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">{t("Plano")}</dt>
          <dd>{nomeDoPlano(assinatura.plano_id)}</dd>
          <dt className="text-muted-foreground">{t("Situação")}</dt>
          <dd>{t(ROTULO_DO_ESTADO[assinatura.estado])}</dd>
          {assinatura.trial_ate && (
            <>
              <dt className="text-muted-foreground">{t("Teste grátis até")}</dt>
              <dd>{data.format(new Date(assinatura.trial_ate))}</dd>
            </>
          )}
          {assinatura.prazo_extra_ate && (
            <>
              <dt className="text-muted-foreground">{t("Prazo extra até")}</dt>
              <dd>{data.format(new Date(assinatura.prazo_extra_ate))}</dd>
            </>
          )}
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground">{t("Isenta: não paga e não tem limites.")}</p>
      )}
      {rotuloAntigo && (
        <p className="text-xs text-muted-foreground">
          {t("Rótulo antigo:")} {rotuloAntigo}
        </p>
      )}

      {remover.length > 0 && (
        <div role="alert" className="rounded-md border p-3 text-sm text-warning-fg">
          <p className="font-medium">{t("O uso atual não cabe no plano escolhido. Para trocar, primeiro:")}</p>
          <ul className="mt-1 list-disc pl-5">
            {remover.map(({ recurso, n }) => (
              <li key={recurso}>{t(FRASE_DO_EXCEDENTE[recurso]).replace("{n}", String(n))}</li>
            ))}
          </ul>
        </div>
      )}

      {ativos.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {t("Nenhum plano ativo para escolher.")}{" "}
          <a className="underline" href="/admin/cobranca">
            {t("Criar um plano em Cobrança")}
          </a>
        </p>
      )}

      {ativos.length > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="plano-da-empresa">{t("Plano da empresa")}</Label>
            <select
              id="plano-da-empresa"
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={escolhido}
              onChange={(e) => setEscolhido(e.target.value)}
            >
              {ativos.map((p) => (
                <option key={p.id} value={p.id}>{p.nome}</option>
              ))}
            </select>
          </div>
          {assinatura ? (
            <Button disabled={ocupado || !escolhido} onClick={() => agir(() => apiClient.patch(base, { plano_id: escolhido }), t("Plano trocado."))}>
              {t("Trocar plano")}
            </Button>
          ) : (
            <Button disabled={ocupado || !escolhido} onClick={() => agir(() => apiClient.post(base, { plano_id: escolhido }), t("Plano atribuído."))}>
              {t("Atribuir plano")}
            </Button>
          )}
        </div>
      )}

      {(assinatura || suspensaPorCobranca) && (
        <div className="flex flex-wrap items-end gap-2">
          {assinatura && (
            <>
              <div className="space-y-1">
                <Label htmlFor="prazo-ate">{t("Dar prazo até")}</Label>
                <Input id="prazo-ate" type="date" value={prazo} onChange={(e) => setPrazo(e.target.value)} />
              </div>
              <Button
                variant="outline"
                disabled={ocupado || !prazo}
                onClick={() => agir(() => apiClient.post(`${base}/prazo`, { ate: fimDoDia(prazo) }), t("Prazo concedido."))}
              >
                {t("Dar prazo")}
              </Button>
            </>
          )}
          <Button variant="outline" disabled={ocupado} onClick={() => agir(() => apiClient.delete(base), t("A empresa agora é isenta."))}>
            {t("Tornar isenta")}
          </Button>
        </div>
      )}
    </Card>
  );
}
