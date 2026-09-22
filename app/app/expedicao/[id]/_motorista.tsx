"use client";

import * as React from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import {
  descarregarOutbox,
  enfileirarDesfecho,
  lerRotaLocal,
  pendentesDaCarga,
  salvarRotaLocal,
  type DesfechoPendente,
} from "@/lib/entregas/outbox";
import { comoMoeda, numeroDoPedido } from "@/lib/format/moeda";
import { MOTIVOS_DEVOLUCAO, ROTULO_MOTIVO_DEVOLUCAO, type MotivoDevolucao } from "@/lib/schemas/expedicao";

import type { RotaCarregada } from "./_roteirizador";

function posicaoAtual(timeoutMs = 10000): Promise<GeolocationPosition> {
  return new Promise((ok, falha) => {
    if (!("geolocation" in navigator)) {
      falha(new Error("sem gps"));
      return;
    }
    navigator.geolocation.getCurrentPosition(ok, falha, { enableHighAccuracy: true, timeout: timeoutMs });
  });
}

/**
 * MODO MOTORISTA — o celular na cabine.
 *
 * Uma entrega por vez: próxima parada, navegar (app de navegação do aparelho —
 * não reinventamos Waze), cheguei, entregue/não-entregue com motivo, foto do
 * comprovante. O rastreio GPS só existe com a rota ativa e com o botão
 * ligado (§32): desligou ou finalizou, encerrou.
 */
export function ModoMotorista({
  cargaId,
  podeOperar,
  aoMudar,
}: {
  cargaId: string;
  podeOperar: boolean;
  aoMudar: () => void;
}) {
  const t = useT();
  const [rota, setRota] = React.useState<RotaCarregada | null>(null);
  const [versaoVista, setVersaoVista] = React.useState<number | null>(null);
  const [rastreando, setRastreando] = React.useState(false);
  const [motivoAberto, setMotivoAberto] = React.useState(false);
  const [motivo, setMotivo] = React.useState<MotivoDevolucao>("cliente_ausente");
  const [fila, setFila] = React.useState<DesfechoPendente[]>(() => pendentesDaCarga(cargaId));
  const [sincronizando, setSincronizando] = React.useState(false);
  const refVigia = React.useRef<number | null>(null);

  const recarregar = React.useCallback(async () => {
    try {
      const corpo = await apiClient.get<{ data: RotaCarregada }>(`/api/v1/shipments/${cargaId}/rota`);
      setRota(corpo.data);
      salvarRotaLocal(cargaId, corpo.data);
      setVersaoVista((v) => v ?? corpo.data.carga.rota_versao);
    } catch (e) {
      // Sem internet, a última rota vista vale: o motorista segue dirigindo.
      const local = lerRotaLocal<RotaCarregada>(cargaId);
      if (local) {
        setRota(local);
        setVersaoVista((v) => v ?? local.carga.rota_versao);
      } else {
        showApiError(e);
      }
    }
  }, [cargaId]);

  /** Manda a fila offline; volta sozinho quando a internet retorna. */
  const sincronizar = React.useCallback(async () => {
    const fila = pendentesDaCarga(cargaId);
    if (fila.length === 0 || sincronizando) return;
    setSincronizando(true);
    try {
      const r = await descarregarOutbox(async (item) => {
        await apiClient.patch(`/api/v1/shipments/${item.cargaId}/orders/${item.orderId}`, {
          status: item.status,
          ...(item.motivo ? { motivo: item.motivo } : {}),
          ...(item.latitude != null ? { latitude: item.latitude } : {}),
          ...(item.longitude != null ? { longitude: item.longitude } : {}),
          ocorrido_em: item.ocorrido_em,
        });
      });
      setFila(pendentesDaCarga(cargaId));
      if (r.enviados > 0) {
        toast.success(`${r.enviados} ${t("entrega(s) sincronizada(s)")}`);
        await recarregar();
        aoMudar();
      }
      if (r.falhas.length > 0) {
        toast.error(`${r.falhas.length} ${t("ainda sem enviar — tenta de novo com sinal")}`);
      }
    } finally {
      setSincronizando(false);
    }
  }, [cargaId, sincronizando, recarregar, aoMudar, t]);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void recarregar();
  }, [recarregar]);

  // Desliga o rastreio ao sair da tela (privacidade §32).
  React.useEffect(() => {
    return () => {
      if (refVigia.current != null) navigator.geolocation.clearWatch(refVigia.current);
    };
  }, []);

  // Internet voltou: descarrega sozinho, sem o motorista lembrar.
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void sincronizar();
    const aoVoltar = () => void sincronizar();
    window.addEventListener("online", aoVoltar);
    return () => window.removeEventListener("online", aoVoltar);
  }, [sincronizar]);

  if (!rota) return <p className="text-sm text-muted-foreground">{t("Carregando rota…")}</p>;

  // O que está na fila offline vale como desfecho até o servidor confirmar:
  // o motorista vê a parada como feita e a rota avança mesmo sem internet.
  const mapaFila = new Map(fila.map((d) => [d.orderId, d]));
  const statusDe = (pedido: { order_id: string; status: string }) =>
    mapaFila.get(pedido.order_id)?.status ?? pedido.status;
  const pendentes = rota.paradas.filter((p) =>
    p.pedidos.some((x) => ["na_carga", "em_rota", "em_atendimento"].includes(statusDe(x))),
  );
  const feitas = rota.paradas.length - pendentes.length;
  const proxima = pendentes[0] ?? null;
  const versaoNova = versaoVista != null && rota.carga.rota_versao > versaoVista;

  async function desfecho(orderId: string, status: "em_atendimento" | "entregue" | "devolvido") {
    let geo: { latitude?: number; longitude?: number } = {};
    try {
      const pos = await posicaoAtual(8000);
      geo = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
    } catch {
      // Sem GPS a baixa vale igual — só sem coordenada.
    }
    const ocorrido_em = new Date().toISOString();
    const corpo = {
      status,
      ...(status === "devolvido" ? { motivo } : {}),
      ...geo,
      ocorrido_em,
    };
    try {
      await apiClient.patch(`/api/v1/shipments/${cargaId}/orders/${orderId}`, corpo);
      toast.success(status === "entregue" ? t("Entregue.") : status === "em_atendimento" ? t("Em atendimento.") : t("Registrado."));
      setMotivoAberto(false);
      await recarregar();
      aoMudar();
    } catch (e) {
      if (e instanceof ApiError) {
        // O servidor recusou (validação, conflito): enfileirar repetiria o erro.
        showApiError(e);
        return;
      }
      // Sem internet (ou servidor fora): guarda no aparelho e segue a rota.
      // O `ocorrido_em` de agora vale no servidor quando sincronizar.
      enfileirarDesfecho({ cargaId, orderId, status, ...(status === "devolvido" ? { motivo } : {}), ...geo, ocorrido_em });
      setFila(pendentesDaCarga(cargaId));
      setMotivoAberto(false);
      toast.success(t("Sem internet — salvo no aparelho, envia sozinho quando voltar."));
    }
  }

  async function transicao(acao: "iniciar" | "finalizar") {
    try {
      await apiClient.post(`/api/v1/shipments/${cargaId}/rota/${acao}`, {});
      toast.success(acao === "iniciar" ? t("Rota iniciada.") : t("Rota finalizada."));
      if (acao === "finalizar") pararRastreio();
      await recarregar();
      aoMudar();
    } catch (e) {
      showApiError(e);
    }
  }

  function iniciarRastreio() {
    if (!("geolocation" in navigator)) {
      toast.error(t("GPS indisponível neste aparelho."));
      return;
    }
    let ultimoEnvio = 0;
    let ultimaPos: { lat: number; lng: number } | null = null;
    refVigia.current = navigator.geolocation.watchPosition(
      (pos) => {
        const agora = Date.now();
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        const moveu =
          !ultimaPos || Math.abs(ultimaPos.lat - lat) + Math.abs(ultimaPos.lng - lng) > 0.0005;
        if (agora - ultimoEnvio < 15000 && !moveu) return;
        ultimoEnvio = agora;
        ultimaPos = { lat, lng };
        void apiClient
          .post(`/api/v1/shipments/${cargaId}/rota/posicao`, {
            latitude: lat,
            longitude: lng,
            precisao_m: pos.coords.accuracy ?? null,
          })
          .catch(() => undefined);
      },
      () => toast.error(t("GPS negado ou indisponível.")),
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 },
    );
    setRastreando(true);
    toast.success(t("Rastreio ligado — só durante esta rota."));
  }

  function pararRastreio() {
    if (refVigia.current != null) navigator.geolocation.clearWatch(refVigia.current);
    refVigia.current = null;
    setRastreando(false);
    toast.success(t("GPS encerrado."));
  }

  const navegarHref =
    proxima?.latitude != null && proxima?.longitude != null
      ? `https://www.google.com/maps/dir/?api=1&destination=${proxima.latitude},${proxima.longitude}`
      : proxima?.endereco
        ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(proxima.endereco)}`
        : null;

  return (
    <div className="mx-auto max-w-md space-y-3">
      <Card className="p-3">
        <div className="flex items-center justify-between text-sm">
          <strong>
            {feitas}/{rota.paradas.length} {t("entregas")}
          </strong>
          <span className="text-muted-foreground">
            {rota.paradas.length > 0 ? Math.round((feitas / rota.paradas.length) * 100) : 0}% {t("concluído")}
          </span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-green-600"
            style={{ width: `${rota.paradas.length > 0 ? (feitas / rota.paradas.length) * 100 : 0}%` }}
          />
        </div>
      </Card>

      {fila.length > 0 && (
        <Card className="border-amber-500 p-3 text-sm">
          <p>
            ⏳ {fila.length} {t("aguardando envio (sem internet)")}
          </p>
          <Button size="sm" className="mt-2 w-full" disabled={sincronizando} onClick={() => void sincronizar()}>
            {sincronizando ? t("Enviando…") : t("Sincronizar agora")}
          </Button>
        </Card>
      )}

      {versaoNova && (        <Card className="border-orange-500 p-3 text-sm">
          <p>{t("A rota foi alterada no painel de expedição. Nova sequência disponível.")}</p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={() => { setVersaoVista(rota.carga.rota_versao); void recarregar(); }}>
              {t("Aplicar")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setVersaoVista(rota.carga.rota_versao)}>
              {t("Manter atual")}
            </Button>
          </div>
        </Card>
      )}

      {rota.carga.status === "montando" && podeOperar && (
        <Button className="w-full" onClick={() => void transicao("iniciar")}>
          {t("Iniciar rota")}
        </Button>
      )}

      {proxima ? (
        <Card className="space-y-2 p-4">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground">{t("PRÓXIMA ENTREGA")}</p>
          <p className="text-lg font-bold">{proxima.cliente}</p>
          {proxima.endereco && <p className="text-sm">{proxima.endereco}</p>}
          {proxima.fone && <p className="text-sm">{proxima.fone}</p>}
          <div className="text-sm">
            {proxima.pedidos.map((x) => (
              <p key={x.order_id}>
                {numeroDoPedido(x.numero)} · {comoMoeda(x.total_cents, "BRL")}
              </p>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2 pt-1">
            {navegarHref && (
              <Button asChild>
                <a href={navegarHref} target="_blank" rel="noopener noreferrer">
                  {t("Navegar")}
                </a>
              </Button>
            )}
            {podeOperar && (
              <Button
                variant="outline"
                onClick={() => {
                  const alvo = proxima.pedidos.find((x) => ["na_carga", "em_rota", "em_atendimento"].includes(statusDe(x)));
                  if (alvo) void desfecho(alvo.order_id, "em_atendimento");
                }}
              >
                {t("Cheguei")}
              </Button>
            )}
          </div>
          {podeOperar && (
            <>
              <Button
                className="w-full"
                variant="outline"
                onClick={() => {
                  const alvo = proxima.pedidos.find((x) => ["na_carga", "em_rota", "em_atendimento"].includes(statusDe(x)));
                  if (alvo) void desfecho(alvo.order_id, "entregue");
                }}
              >
                {t("Marcar como entregue")}
              </Button>
              {!motivoAberto ? (
                <Button className="w-full" variant="ghost" onClick={() => setMotivoAberto(true)}>
                  {t("Não entregue")}
                </Button>
              ) : (
                <div className="space-y-2 rounded-2xl border p-2">
                  <select
                    className="w-full rounded-lg border bg-background px-2 py-1.5 text-sm"
                    value={motivo}
                    onChange={(e) => setMotivo(e.target.value as MotivoDevolucao)}
                  >
                    {MOTIVOS_DEVOLUCAO.map((m) => (
                      <option key={m} value={m}>
                        {ROTULO_MOTIVO_DEVOLUCAO[m]}
                      </option>
                    ))}
                  </select>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => {
                        const alvo = proxima.pedidos.find((x) =>
                          ["na_carga", "em_rota", "em_atendimento"].includes(statusDe(x)),
                        );
                        if (alvo) void desfecho(alvo.order_id, "devolvido");
                      }}
                    >
                      {t("Confirmar")}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setMotivoAberto(false)}>
                      {t("Voltar")}
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </Card>
      ) : (
        <Card className="p-4 text-center text-sm">
          <p className="font-semibold">{t("Todas as paradas concluídas.")}</p>
          {podeOperar && rota.carga.status === "em_rota" && (
            <Button className="mt-2 w-full" onClick={() => void transicao("finalizar")}>
              {t("Finalizar rota")}
            </Button>
          )}
        </Card>
      )}

      {/* Lista compacta */}
      <Card className="p-2">
        <ul className="divide-y text-sm">
          {rota.paradas.map((p, i) => {
            const temPendente = p.pedidos.some((x) => mapaFila.has(x.order_id));
            const feito = p.pedidos.every((x) => statusDe(x) === "entregue") && !temPendente;
            const atual = p.chave === proxima?.chave;
            return (
              <li key={p.chave} className={`flex items-center gap-2 px-2 py-1.5 ${atual ? "font-bold" : ""}`}>
                <span>{feito ? "✓" : temPendente ? "⏳" : atual ? "→" : `${i + 1}`}</span>
                <span className="truncate">{p.cliente}</span>
              </li>
            );
          })}
        </ul>
      </Card>

      {rota.carga.status === "em_rota" && (
        <Button className="w-full" variant={rastreando ? "destructive" : "outline"} onClick={() => (rastreando ? pararRastreio() : iniciarRastreio())}>
          {rastreando ? t("Parar rastreio") : t("Iniciar rastreio GPS")}
        </Button>
      )}
    </div>
  );
}
