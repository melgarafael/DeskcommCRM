"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { resumirErroDaImportacao } from "@/lib/channels/historico/resumo-do-erro";

interface Previa {
  conversas: number;
  mensagens: number;
  audios: number;
  imagens: number;
  desde: string;
  parcial: boolean;
}

interface Importacao {
  id: string;
  status: "previa" | "rodando" | "erro" | "cancelada" | "concluida";
  dias?: number;
  previa?: Previa | null;
  conversas_feitas?: number;
  mensagens_gravadas?: number;
  mensagens_existentes?: number;
  mensagens_ignoradas?: number;
  midias_baixadas?: number;
  midias_indisponiveis?: number;
  erro?: string | null;
}

interface Historico {
  guardar_historico: boolean;
  importacao: Importacao | null;
}

const DIAS = [30, 90, 180, 365] as const;
const PREVIA_TIMEOUT_MS = 120_000;

/** 409: outra aba (ou o cron) mudou a importação; não é o número que falhou. */
function ehConflito(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409;
}

/**
 * A importação do histórico do número (#999), no cartão da conexão.
 *
 * A tela só pede e acompanha: quem anda a importação é o cron, uma rodada por
 * minuto, por isso o GET repete a cada 10 s enquanto está `rodando`. A prévia
 * é lenta (dezenas de segundos) e roda sem travar o resto do cartão.
 */
export function ChannelHistorico({ channelId }: { channelId: string }) {
  const t = useT();
  const qc = useQueryClient();
  const [dias, setDias] = useState<number>(30);
  const [contando, setContando] = useState(false);
  const [busy, setBusy] = useState(false);
  const [erroDaPrevia, setErroDaPrevia] = useState<"conflito" | "rede" | null>(null);
  const rota = `/api/v1/channel-sessions/${channelId}/historico`;
  const frase = (tipo: "conflito" | "rede") =>
    tipo === "conflito"
      ? t("A importação mudou enquanto você olhava. A tela foi atualizada com o estado atual.")
      : t("Não foi possível falar com o número agora. Tente de novo em instantes.");
  const chave = ["channel-historico", channelId];

  const query = useQuery({
    queryKey: chave,
    queryFn: () => apiClient.get<{ data: Historico }>(rota),
    refetchOnWindowFocus: false,
    refetchInterval: (q) => (q.state.data?.data.importacao?.status === "rodando" ? 10_000 : false),
  });

  const guardar = query.data?.data.guardar_historico;
  const imp = query.data?.data.importacao ?? null;

  async function acao(corpo: Record<string, unknown>) {
    setBusy(true);
    try {
      await apiClient.post(rota, corpo, { timeoutMs: 20_000 });
    } catch (err) {
      toast.error(frase(ehConflito(err) ? "conflito" : "rede"));
    } finally {
      // Com sucesso ou não, a tela passa a mostrar o estado que o servidor tem.
      await qc.invalidateQueries({ queryKey: chave });
      setBusy(false);
    }
  }

  async function pedirPrevia() {
    setContando(true);
    setErroDaPrevia(null);
    try {
      await apiClient.post(rota, { acao: "previa", dias }, { timeoutMs: PREVIA_TIMEOUT_MS });
    } catch (err) {
      setErroDaPrevia(ehConflito(err) ? "conflito" : "rede");
    } finally {
      await qc.invalidateQueries({ queryKey: chave });
      setContando(false);
    }
  }

  if (query.isLoading) return null;
  if (query.isError) {
    return <p role="alert" className="text-[11px] text-destructive">{frase("rede")}</p>;
  }

  const titulo = <p className="text-xs font-medium">{t("Trazer conversas antigas para o atendimento")}</p>;

  if (!guardar) {
    return (
      <div className="flex flex-col gap-1">
        {titulo}
        <p className="text-[11px] text-muted-foreground">{t("Ligue 'Guardar o histórico' e conecte o número de novo")}</p>
      </div>
    );
  }

  const p = imp?.previa ?? null;
  const rodando = imp?.status === "rodando";
  const status = imp?.status;
  // Nova prévia: sem nada, depois de prévia (refazer), cancelada ou concluída.
  const podePedirPrevia = !rodando && status !== "erro";
  const numeros = p
    ? t(p.parcial
        ? "Pelo menos {conversas} conversas, {mensagens} mensagens, {audios} áudios e {imagens} imagens"
        : "{conversas} conversas, {mensagens} mensagens, {audios} áudios e {imagens} imagens")
        .replace("{conversas}", String(p.conversas))
        .replace("{mensagens}", String(p.mensagens))
        .replace("{audios}", String(p.audios))
        .replace("{imagens}", String(p.imagens))
    : null;

  return (
    <div className="flex flex-col gap-1">
      {titulo}
      <p className="text-[11px] text-muted-foreground">{t("Período: últimos 30, 90, 180 ou 365 dias")}</p>

      {rodando && imp && (
        <>
          <p className="text-[11px]">
            {t("Importando: {feitas} de {conversas} conversas")
              .replace("{feitas}", String(imp.conversas_feitas ?? 0))
              .replace("{conversas}", String(p?.conversas ?? 0))}
          </p>
          <div>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void acao({ acao: "cancelar", importacaoId: imp.id })}>
              {t("Cancelar")}
            </Button>
          </div>
        </>
      )}

      {status === "erro" && imp && (
        <>
          <p role="alert" className="text-[11px] text-destructive">{t("A importação parou por um erro.")}</p>
          {imp.erro && (
            <p className="text-[11px] text-muted-foreground">
              {t("Detalhe: {erro}").replace("{erro}", resumirErroDaImportacao(imp.erro))}
            </p>
          )}
          {/* Erro que se repete (o mesmo chat sempre recusado) não tem saída por
              "Tentar de novo": cancelar libera o número para uma prévia nova. */}
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void acao({ acao: "retomar", importacaoId: imp.id })}>
              {t("Tentar de novo")}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void acao({ acao: "cancelar", importacaoId: imp.id })}>
              {t("Cancelar")}
            </Button>
          </div>
        </>
      )}

      {status === "concluida" && imp && (
        <>
          <p className="text-[11px] font-medium">{t("Importação concluída")}</p>
          <p className="text-[11px] text-muted-foreground">
            {t("{gravadas} mensagens trazidas; {indisponiveis} áudios ou imagens não estavam mais disponíveis.")
              .replace("{gravadas}", String(imp.mensagens_gravadas ?? 0))
              .replace("{indisponiveis}", String(imp.midias_indisponiveis ?? 0))}
          </p>
        </>
      )}

      {status === "previa" && imp && numeros && (
        <>
          <p className="text-[11px]">{numeros}</p>
          <div>
            <Button size="sm" disabled={busy || contando} onClick={() => void acao({ acao: "importar", importacaoId: imp.id })}>
              {t("Importar")}
            </Button>
          </div>
        </>
      )}

      {(status === "previa" || status === "rodando" || status === "erro") && (
        <>
          <p className="text-[11px] text-muted-foreground">{t("Nenhuma mensagem antiga será respondida pela IA nem dispara automação.")}</p>
          <p className="text-[11px] text-muted-foreground">{t("Áudios e imagens antigos que o WhatsApp não guarda mais aparecem como indisponíveis.")}</p>
        </>
      )}

      {podePedirPrevia && (
        <div className="flex items-center gap-2">
          <select
            aria-label={t("Período: últimos 30, 90, 180 ou 365 dias")}
            className="h-8 rounded-md border bg-background px-2 text-xs"
            value={dias}
            disabled={contando}
            onChange={(e) => setDias(Number(e.target.value))}
          >
            {DIAS.map((d) => (
              <option key={d} value={d}>{t("{dias} dias").replace("{dias}", String(d))}</option>
            ))}
          </select>
          <Button size="sm" variant="outline" disabled={contando || busy} onClick={() => void pedirPrevia()}>
            {contando ? t("Contando as conversas…") : t("Ver prévia")}
          </Button>
        </div>
      )}

      {erroDaPrevia && (
        <p role="alert" className="text-[11px] text-destructive">{frase(erroDaPrevia)}</p>
      )}
    </div>
  );
}
