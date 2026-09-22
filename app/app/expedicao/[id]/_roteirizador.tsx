"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { apiClient } from "@/lib/api/client";
import { comoMoeda, numeroDoPedido } from "@/lib/format/moeda";
import { formatarDistancia, formatarDuracao, haversineM } from "@/lib/rotas/roteamento";
import { createClient } from "@/lib/supabase/browser";

import { MapaRota, type PontoParadaMapa } from "./_mapa-rota";

export interface ParadaRotaApi {
  chave: string;
  contact_id: string | null;
  cliente: string;
  fone: string | null;
  endereco: string | null;
  latitude: number | null;
  longitude: number | null;
  geo_status: string;
  geo_fonte: string | null;
  pedidos: { shipment_order_id: string; order_id: string; numero: number; total_cents: number; status: string }[];
  total_cents: number;
}

export interface RotaCarregada {
  carga: {
    id: string;
    numero: number;
    status: string;
    placa: string | null;
    veiculo_tipo: string | null;
    motorista_nome: string | null;
    origem_endereco: string | null;
    origem_lat: number | null;
    origem_lng: number | null;
    retornar_origem: boolean;
    tempo_parada_min: number;
    distancia_m: number | null;
    duracao_s: number | null;
    rota_geojson: { geometria?: number[][]; provedor?: string; ruas?: boolean; modo?: string } | null;
    rota_em: string | null;
    rota_versao: number;
    started_at: string | null;
    finished_at: string | null;
  };
  paradas: ParadaRotaApi[];
  ultima_posicao: { latitude: number; longitude: number; em: string } | null;
}

interface Proposta {
  ordem: string[];
  origem: { lat: number; lng: number; endereco: string | null } | null;
  retornar_origem: boolean;
  tempo_parada_min: number;
  modo: string;
  distancia_m: number;
  duracao_dirigindo_s: number;
  duracao_total_s: number;
  geometria: number[][];
  provedor: string;
  ruas: boolean;
  nao_roteirizaveis: string[];
}

const ROTULO_GEO: Record<string, string> = {
  ok: "No mapa",
  pendente: "A localizar",
  nao_encontrado: "Não localizado",
  ambiguo: "Ambíguo",
  erro: "Erro",
};

/**
 * ROTEIRIZADOR — a central de planejamento da carga.
 *
 * Paradas vêm da carga (agrupadas por cliente no backend), geocodificação no
 * servidor com cache, otimização OSRM pelas ruas com fallback honesto,
 * reordenação manual, origem configurável e mapa sincronizado. Salvar grava
 * sequência + geometria + versão; iniciar/finalizar moram nos botões da
 * carga e no modo motorista.
 */
export function Roteirizador({
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
  const [ordem, setOrdem] = React.useState<string[]>([]);
  const [proposta, setProposta] = React.useState<Proposta | null>(null);
  const [origemTexto, setOrigemTexto] = React.useState("");
  const [retornar, setRetornar] = React.useState(false);
  const [tempoParada, setTempoParada] = React.useState(8);
  const [trabalhando, setTrabalhando] = React.useState<string | null>(null);
  const [progressoGeo, setProgressoGeo] = React.useState<string | null>(null);
  const [marcarPara, setMarcarPara] = React.useState<string | null>(null);
  const [pinoPendente, setPinoPendente] = React.useState<{ lat: number; lng: number } | null>(null);
  const [rastro, setRastro] = React.useState<[number, number][]>([]);
  const [motorista, setMotorista] = React.useState<{ lat: number; lng: number } | null>(null);

  const recarregar = React.useCallback(async () => {
    try {
      const corpo = await apiClient.get<{ data: RotaCarregada }>(`/api/v1/shipments/${cargaId}/rota`);
      const d = corpo.data;
      setRota(d);
      setOrdem((atual) => {
        const chaves = d.paradas.map((p) => p.chave);
        // Preserva reordenação manual quando as paradas são as mesmas.
        if (atual.length === chaves.length && atual.every((c) => chaves.includes(c))) return atual;
        return chaves;
      });
      setOrigemTexto((atual) => (atual === "" && d.carga.origem_endereco ? d.carga.origem_endereco : atual));
      setRetornar(d.carga.retornar_origem);
      setTempoParada(d.carga.tempo_parada_min);
      if (d.ultima_posicao) setMotorista({ lat: d.ultima_posicao.latitude, lng: d.ultima_posicao.longitude });
    } catch (e) {
      showApiError(e);
    }
  }, [cargaId]);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void recarregar();
  }, [recarregar]);

  const statusCarga = rota?.carga.status;

  // Rastro realizado (mapa + comparação planejado×realizado).
  React.useEffect(() => {
    if (!rota || (statusCarga !== "em_rota" && statusCarga !== "concluida")) return;
    let vivo = true;
    apiClient
      .get<{ data: { posicoes: { latitude: number; longitude: number }[] } }>(
        `/api/v1/shipments/${cargaId}/rota/posicao?limite=500`,
      )
      .then((r) => {
        if (vivo) setRastro((r.data.posicoes ?? []).map((p) => [p.latitude, p.longitude]));
      })
      .catch(() => undefined);
    return () => {
      vivo = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cargaId, statusCarga]);

  // Motorista ao vivo via Realtime (sem polling): INSERT em shipment_positions.
  React.useEffect(() => {
    if (!rota || statusCarga !== "em_rota") return;
    const sb = createClient();
    const canal = sb
      .channel(`rota:${cargaId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "shipment_positions", filter: `shipment_id=eq.${cargaId}` },
        (pag: { new: { latitude: number; longitude: number } }) => {
          const n = pag.new as { latitude: number; longitude: number };
          if (typeof n.latitude === "number" && typeof n.longitude === "number") {
            setMotorista({ lat: n.latitude, lng: n.longitude });
            setRastro((atual) => [...atual.slice(-499), [n.latitude, n.longitude]]);
          }
        },
      )
      .subscribe();
    return () => {
      void sb.removeChannel(canal);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cargaId, statusCarga]);

  if (!rota) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-[50vh] w-full" />
        <p className="text-sm text-muted-foreground">{t("Carregando rota…")}</p>
      </div>
    );
  }

  const paradasOrdenadas = ordem
    .map((c) => rota.paradas.find((p) => p.chave === c))
    .filter((p): p is ParadaRotaApi => !!p);
  const comCoord = paradasOrdenadas.filter((p) => p.latitude != null && p.longitude != null);
  const semCoord = paradasOrdenadas.filter((p) => p.latitude == null || p.longitude == null);
  // Planejador vale montando E em rota (reotimizar no meio do caminho é
  // operação normal — o motorista confirma a nova sequência no app).
  const editavel = podeOperar && (rota.carga.status === "montando" || rota.carga.status === "em_rota");
  const valorTotal = rota.paradas.reduce((s, p) => s + p.total_cents, 0);
  const ordemSalva = rota.paradas.map((p) => p.chave);
  const ordemMudou = ordem.join("|") !== ordemSalva.join("|") && ordem.length === ordemSalva.length;
  const configMudou = retornar !== rota.carga.retornar_origem || tempoParada !== rota.carga.tempo_parada_min;

  const primeiraPendente = (() => {
    for (const p of paradasOrdenadas) {
      if (p.pedidos.some((x) => ["na_carga", "em_rota", "em_atendimento"].includes(x.status))) return p.chave;
    }
    return null;
  })();

  const pontosMapa: PontoParadaMapa[] = paradasOrdenadas.map((p, i) => {
    const sts = p.pedidos.map((x) => x.status);
    const estado = sts.every((s) => s === "entregue")
      ? "entregue"
      : sts.some((s) => s === "devolvido")
        ? "problema"
        : sts.some((s) => s === "em_atendimento")
          ? "atendimento"
          : p.chave === primeiraPendente
            ? "proxima"
            : "pendente";
    return {
      chave: p.chave,
      cliente: p.cliente,
      contact_id: p.contact_id,
      endereco: p.endereco,
      fone: p.fone,
      lat: p.latitude,
      lng: p.longitude,
      ordem: i + 1,
      estado,
      pedidos: p.pedidos,
    };
  });

  const geometria = proposta?.geometria ?? rota.carga.rota_geojson?.geometria ?? [];
  const modoSalvo = rota.carga.rota_geojson?.modo ?? null;
  const provedorRota = proposta ? { nome: proposta.provedor, ruas: proposta.ruas } : rota.carga.rota_geojson ? { nome: rota.carga.rota_geojson.provedor ?? "?", ruas: rota.carga.rota_geojson.ruas ?? false } : null;
  const modoEfetivo = proposta?.modo ?? modoSalvo;
  const distanciaM = proposta?.distancia_m ?? rota.carga.distancia_m;
  const duracaoTotalS = proposta ? proposta.duracao_total_s : rota.carga.duracao_s != null ? rota.carga.duracao_s + paradasOrdenadas.length * rota.carga.tempo_parada_min * 60 : null;

  // Realizado do rastro (haversine + ponta a ponta) — só com dado suficiente.
  let realizado: { km: string; tempo: string } | null = null;
  if (rastro.length >= 2) {
    let m = 0;
    for (let i = 1; i < rastro.length; i++) m += haversineM({ lat: rastro[i - 1]![0], lng: rastro[i - 1]![1] }, { lat: rastro[i]![0], lng: rastro[i]![1] });
    realizado = { km: formatarDistancia(m), tempo: "—" };
  }
  const tempoRealizado =
    rota.carga.started_at && (rota.carga.finished_at || rastro.length > 0)
      ? Math.round((new Date(rota.carga.finished_at ?? new Date().toISOString()).getTime() - new Date(rota.carga.started_at).getTime()) / 1000)
      : null;
  if (realizado && tempoRealizado != null) realizado = { ...realizado, tempo: formatarDuracao(tempoRealizado) };

  async function geocodificarTudo() {
    setTrabalhando("geo");
    setProgressoGeo(t("Localizando…"));
    try {
      for (;;) {
        const corpo = await apiClient.post<{ data: { estados: { estado: string }[]; restantes: number } }>(
          `/api/v1/shipments/${cargaId}/rota/geocodificar`,
          {},
        );
        const d = corpo.data;
        setProgressoGeo(
          d.restantes > 0 ? t(`Faltam ${d.restantes}…`) : t("Pronto."),
        );
        await recarregar();
        if (d.restantes <= 0) break;
      }
      toast.success(t("Geocodificação concluída."));
    } catch (e) {
      showApiError(e);
    } finally {
      setTrabalhando(null);
      setProgressoGeo(null);
    }
  }

  async function otimizar(modoEscolhido: "tsp" | "distancia") {
    if (ordemMudou && !window.confirm(t("A ordem manual será substituída pela otimizada. Reotimizar mesmo assim?"))) return;
    if (
      rota?.carga.status === "em_rota" &&
      !window.confirm(t("A rota está em andamento — o motorista verá a nova sequência. Reotimizar mesmo assim?"))
    )
      return;
    setTrabalhando("otimizar");
    try {
      // Minha posição como origem: resolve o GPS antes de pedir a proposta.
      let origem: { endereco: string } | { latitude: number; longitude: number } | null = null;
      const txt = origemTexto.trim();
      if (txt === "@gps") {
        const pos = await new Promise<GeolocationPosition>((ok, falha) =>
          navigator.geolocation.getCurrentPosition(ok, falha, { timeout: 10000 }),
        );
        origem = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
      } else if (txt) {
        origem = { endereco: txt };
      }
      const corpo = await apiClient.post<{ data: Proposta }>(`/api/v1/shipments/${cargaId}/rota/otimizar`, {
        origem,
        retornar_origem: retornar,
        tempo_parada_min: tempoParada,
        modo: modoEscolhido,
      });
      const p = corpo.data;
      setProposta(p);
      setOrdem(p.ordem);
      if (!p.ruas) toast.warning(t("Serviço de ruas fora do ar — ordem aproximada (linha reta ×1,3)."));
      else toast.success(t("Rota otimizada. Confira e salve."));
    } catch (e) {
      showApiError(e);
    } finally {
      setTrabalhando(null);
    }
  }

  async function salvarOrdem() {
    setTrabalhando("salvar");
    try {
      const corpo = await apiClient.patch<{ data: RotaCarregada }>(`/api/v1/shipments/${cargaId}/rota/ordem`, {
        ordem,
        ...(proposta
          ? {
              distancia_m: proposta.distancia_m,
              duracao_s: proposta.duracao_dirigindo_s,
              geometria: proposta.geometria,
              provedor: proposta.provedor,
              ruas: proposta.ruas,
              modo: proposta.modo,
              ...(proposta.origem
                ? {
                    origem_endereco: proposta.origem.endereco,
                    origem_lat: proposta.origem.lat,
                    origem_lng: proposta.origem.lng,
                  }
                : {}),
              retornar_origem: proposta.retornar_origem,
              tempo_parada_min: proposta.tempo_parada_min,
            }
          : { retornar_origem: retornar, tempo_parada_min: tempoParada }),
      });
      setRota(corpo.data);
      setProposta(null);
      toast.success(t("Rota salva."));
      aoMudar();
    } catch (e) {
      showApiError(e);
    } finally {
      setTrabalhando(null);
    }
  }

  function mover(chave: string, dir: -1 | 1) {
    setOrdem((atual) => {
      const i = atual.indexOf(chave);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= atual.length) return atual;
      const copia = [...atual];
      [copia[i], copia[j]] = [copia[j]!, copia[i]!];
      return copia;
    });
    setProposta(null);
  }

  function alternarMarcar(contactId: string) {
    setMarcarPara((atual) => (atual === contactId ? null : contactId));
    setPinoPendente(null);
  }

  function usarMinhaPosicao() {
    if (!("geolocation" in navigator)) {
      toast.error(t("GPS indisponível neste aparelho."));
      return;
    }
    setOrigemTexto("@gps");
    toast.success(t("Origem = sua posição atual (resolve ao otimizar)."));
  }

  async function confirmarPino() {
    if (!marcarPara || !pinoPendente) return;
    setTrabalhando("pino");
    try {
      await apiClient.post(`/api/v1/shipments/${cargaId}/rota/manual`, {
        contact_id: marcarPara,
        latitude: Number(pinoPendente.lat.toFixed(6)),
        longitude: Number(pinoPendente.lng.toFixed(6)),
      });
      toast.success(t("Posição fixada."));
      setMarcarPara(null);
      setPinoPendente(null);
      await recarregar();
    } catch (e) {
      showApiError(e);
    } finally {
      setTrabalhando(null);
    }
  }

  function cancelarPino() {
    setMarcarPara(null);
    setPinoPendente(null);
  }

  async function acaoParada(chave: string, acao: "cheguei" | "entregue") {
    if (!rota) return;
    const parada = rota.paradas.find((p) => p.chave === chave);
    const alvo = parada?.pedidos.find((x) => ["na_carga", "em_rota", "em_atendimento"].includes(x.status));
    if (!alvo) return;
    try {
      let geo: { latitude?: number; longitude?: number } = {};
      if (acao === "entregue" && "geolocation" in navigator) {
        try {
          const pos = await new Promise<GeolocationPosition>((ok, falha) =>
            navigator.geolocation.getCurrentPosition(ok, falha, { timeout: 8000 }),
          );
          geo = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
        } catch {
          // Sem GPS, a entrega vale igual — só sem coordenada.
        }
      }
      await apiClient.patch(`/api/v1/shipments/${cargaId}/orders/${alvo.order_id}`, {
        status: acao === "cheguei" ? "em_atendimento" : "entregue",
        ...geo,
      });
      toast.success(acao === "cheguei" ? t("Em atendimento.") : t("Entregue."));
      await recarregar();
      aoMudar();
    } catch (e) {
      showApiError(e);
    }
  }

  const origemMapa =
    (proposta?.origem ?? (rota.carga.origem_lat != null && rota.carga.origem_lng != null
      ? { lat: rota.carga.origem_lat, lng: rota.carga.origem_lng, endereco: rota.carga.origem_endereco }
      : null));

  return (
    <div className="space-y-4">
      {/* RESUMO */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Card className="p-3">
          <p className="text-xs text-muted-foreground">{t("Entregas")}</p>
          <p className="text-lg font-bold">
            {paradasOrdenadas.length} · {rota.paradas.length > 0 ? new Set(rota.paradas.map((p) => p.contact_id ?? p.chave)).size : 0} {t("clientes")}
          </p>
        </Card>
        <Card className="p-3">
          <p className="text-xs text-muted-foreground">{t("Distância")}</p>
          <p className="text-lg font-bold">{distanciaM != null ? formatarDistancia(distanciaM) : "—"}</p>
        </Card>
        <Card className="p-3">
          <p className="text-xs text-muted-foreground">{t("Tempo estimado")}</p>
          <p className="text-lg font-bold">{duracaoTotalS != null ? formatarDuracao(duracaoTotalS) : "—"}</p>
        </Card>
        <Card className="p-3">
          <p className="text-xs text-muted-foreground">{t("Valor")}</p>
          <p className="text-lg font-bold">{comoMoeda(valorTotal, "BRL")}</p>
        </Card>
        <Card className="p-3">
          <p className="text-xs text-muted-foreground">{t("Cálculo")}</p>
          <p className="text-lg font-bold">
            {provedorRota ? (provedorRota.ruas ? t("Pelas ruas") : t("Aproximado")) : "—"}
          </p>
          {modoEfetivo && (
            <p className="text-xs text-muted-foreground">
              {modoEfetivo === "distancia" ? t("por distância da base") : t("caminho mais curto")}
            </p>
          )}
        </Card>
      </div>
      {realizado && (
        <Card className="p-3 text-sm">
          <span className="text-muted-foreground">{t("Realizado")}: </span>
          <strong>
            {realizado.km} · {realizado.tempo}
          </strong>
          {distanciaM != null && (
            <span className="text-muted-foreground"> {t("vs planejado")} {formatarDistancia(distanciaM)}</span>
          )}
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-[55%_45%]">
        {/* MAPA */}
        <div>
          <MapaRota
            paradas={pontosMapa}
            geometria={geometria}
            origem={origemMapa}
            motorista={motorista}
            rastro={rastro}
            modoMarcar={marcarPara !== null}
            pinoPendente={pinoPendente}
            aoClicarMapa={(lat, lng) => {
              if (marcarPara) setPinoPendente({ lat, lng });
            }}
            aoAcaoParada={(chave, acao) => void acaoParada(chave, acao)}
          />
          {marcarPara && (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning-bg p-2 text-sm text-warning-fg">
              <span>
                {pinoPendente ? t("Alfinete no lugar? Confirme para valer.") : t("Clique no mapa para soltar o alfinete.")}
              </span>
              <span className="ml-auto flex gap-2">
                <Button size="sm" onClick={() => void confirmarPino()} disabled={!pinoPendente || trabalhando !== null}>
                  {t("Confirmar posição")}
                </Button>
                <Button size="sm" variant="outline" onClick={cancelarPino}>
                  {t("Cancelar")}
                </Button>
              </span>
            </div>
          )}
        </div>

        {/* PAINEL */}
        <div className="min-w-0 space-y-3">
          {editavel && (
            <Card className="space-y-2 p-3">
              <p className="text-sm font-semibold">{t("Origem da rota")}</p>
              <div className="flex gap-2">
                <Input
                  value={origemTexto}
                  onChange={(e) => setOrigemTexto(e.target.value)}
                  placeholder={t("Ex.: Rua Caetano Costa, 425, Canoinhas")}
                />
                <Button size="sm" variant="outline" onClick={usarMinhaPosicao}>
                  {t("Minha posição")}
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <label className="flex items-center gap-1">
                  <input type="checkbox" checked={retornar} onChange={(e) => setRetornar(e.target.checked)} />
                  {t("Retornar à origem")}
                </label>
                <label className="flex items-center gap-1">
                  {t("Parada")}
                  <input
                    type="number"
                    min={0}
                    max={120}
                    value={tempoParada}
                    onChange={(e) => setTempoParada(Number(e.target.value))}
                    className="w-14 rounded-lg border bg-background px-1 py-0.5 text-sm"
                  />
                  {t("min")}
                </label>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => void geocodificarTudo()} disabled={trabalhando !== null}>
                  {t("Geocodificar")}
                </Button>
                <Button size="sm" onClick={() => void otimizar("distancia")} disabled={trabalhando !== null || comCoord.length === 0}>
                  {trabalhando === "otimizar" ? t("Calculando…") : t("Ordenar por distância")}
                </Button>
                <Button size="sm" variant="outline" onClick={() => void otimizar("tsp")} disabled={trabalhando !== null || comCoord.length === 0}>
                  {t("Otimizar por ruas")}
                </Button>
                {(proposta || ordemMudou || configMudou) && (
                  <Button size="sm" variant="outline" onClick={() => void salvarOrdem()} disabled={trabalhando !== null}>
                    {t("Salvar ordem")}
                  </Button>
                )}
              </div>
              {comCoord.length === 0 && (
                <p className="text-xs text-orange-600">
                  {t("Otimizar desativado: nenhuma parada localizada. Geocodifique ou marque no mapa.")}
                </p>
              )}
              {progressoGeo && <p className="text-xs text-muted-foreground">{progressoGeo}</p>}
              {proposta && !proposta.ruas && (
                <p className="text-xs text-orange-600">
                  {t("Sem ruas no momento: ordem aproximada. Tente de novo mais tarde.")}
                </p>
              )}
            </Card>
          )}

          <div>
            <p className="mb-1 text-sm font-semibold">
              {t("Paradas")} ({paradasOrdenadas.length})
            </p>
            <ul className="space-y-1.5">
              {paradasOrdenadas.map((p, i) => (
                <li key={p.chave} className="rounded-lg border p-2 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{p.cliente}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {p.pedidos.map((x) => numeroDoPedido(x.numero)).join(" · ")} — {comoMoeda(p.total_cents, "BRL")}
                      </p>
                    </div>
                    {editavel && (
                      <span className="flex shrink-0 gap-0.5">
                        <Button size="sm" variant="ghost" onClick={() => mover(p.chave, -1)} disabled={i === 0} aria-label={t("Subir")}>
                          ↑
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => mover(p.chave, 1)}
                          disabled={i === paradasOrdenadas.length - 1}
                          aria-label={t("Descer")}
                        >
                          ↓
                        </Button>
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                    <span
                      className={
                        p.geo_status === "ok"
                          ? "text-green-700"
                          : p.geo_status === "pendente"
                            ? "text-muted-foreground"
                            : "text-orange-600"
                      }
                    >
                      ⚑ {ROTULO_GEO[p.geo_status] ?? p.geo_status}
                      {p.geo_status === "ok" && p.geo_fonte === "nominatim:rua" ? ` ${t("(rua aproximada)")}` : ""}
                    </span>
                    {podeOperar && p.contact_id && p.geo_status !== "ok" && (
                      <>
                        <button
                          type="button"
                          className="underline underline-offset-2"
                          onClick={() => void geocodificarTudo()}
                        >
                          {t("Tentar de novo")}
                        </button>
                        <button
                          type="button"
                          className="underline underline-offset-2"
                          onClick={() => alternarMarcar(p.contact_id as string)}
                        >
                          {marcarPara === p.contact_id ? t("Cancelar marcação") : t("Marcar no mapa")}
                        </button>
                        {p.contact_id && (
                          <Link href={`/app/contacts/${p.contact_id}`} className="underline underline-offset-2">
                            {t("Corrigir endereço")}
                          </Link>
                        )}
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            {semCoord.length > 0 && (
              <p className="mt-1 text-xs text-orange-600">
                {t(`${semCoord.length} parada(s) fora do cálculo — sem localização.`)}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
