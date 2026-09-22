"use client";

import * as React from "react";
import type { Layer, Map as MapaLeaflet } from "leaflet";

import "leaflet/dist/leaflet.css";

import { useT } from "@/hooks/i18n/useT";
import { comoMoeda } from "@/lib/format/moeda";

export interface PontoParadaMapa {
  chave: string;
  cliente: string;
  contact_id: string | null;
  endereco: string | null;
  fone: string | null;
  lat: number | null;
  lng: number | null;
  /** Posição 1-based na ordem atual. */
  ordem: number;
  estado: "pendente" | "proxima" | "atendimento" | "entregue" | "problema";
  pedidos: { order_id: string; numero: number; total_cents: number; status: string }[];
}

export interface PontoMotorista {
  lat: number;
  lng: number;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const COR_ESTADO: Record<PontoParadaMapa["estado"], string> = {
  pendente: "#7c3aed",
  proxima: "#2563eb",
  atendimento: "#d97706",
  entregue: "#16a34a",
  problema: "#dc2626",
};

const SIMBOLO_ESTADO: Record<PontoParadaMapa["estado"], string> = {
  pendente: "",
  proxima: "▶",
  atendimento: "◉",
  entregue: "✓",
  problema: "!",
};

/**
 * MAPA DA ROTA — Leaflet de verdade: geometria pelas ruas (OSRM), marcadores
 * numerados com estado (número + símbolo + cor + tooltip, nunca só cor),
 * origem, motorista ao vivo, rastro realizado e modo "marcar no mapa".
 */
export function MapaRota({
  paradas,
  geometria,
  origem,
  motorista,
  rastro,
  altura,
  modoMarcar,
  pinoPendente,
  aoClicarMapa,
  aoAcaoParada,
}: {
  paradas: PontoParadaMapa[];
  /** GeoJSON [lng,lat] da rota planejada. */
  geometria: number[][];
  origem: { lat: number; lng: number; endereco: string | null } | null;
  motorista: PontoMotorista | null;
  /** Rastro realizado [[lat,lng]...]. */
  rastro: [number, number][];
  altura?: string;
  modoMarcar: boolean;
  /** Pino pendente (aguardando confirmação — ainda NÃO salvo). */
  pinoPendente: { lat: number; lng: number } | null;
  aoClicarMapa: (lat: number, lng: number) => void;
  aoAcaoParada: (chave: string, acao: "cheguei" | "entregue") => void;
}) {
  const t = useT();
  const refCaixa = React.useRef<HTMLDivElement>(null);
  const refMapa = React.useRef<MapaLeaflet | null>(null);
  const refCamadas = React.useRef<Layer[]>([]);
  // O desenho mora depois dos efeitos (regra do lint): os efeitos iniciais
  // despacham pelo ref, que a atribuição abaixo liga na função real.
  const refRedesenhar = React.useRef<(m: MapaLeaflet) => void>(() => undefined);
  const refProps = React.useRef({ paradas, geometria, origem, motorista, rastro, modoMarcar, pinoPendente, aoClicarMapa, aoAcaoParada });
  const [semMapa, setSemMapa] = React.useState<string[]>([]);

  // Props frescas para os callbacks do Leaflet (mapa vive fora do React).
  // Em efeito, não no render: escrever ref no render quebra a atualização.
  React.useEffect(() => {
    refProps.current = { paradas, geometria, origem, motorista, rastro, modoMarcar, pinoPendente, aoClicarMapa, aoAcaoParada };
  });

  // Mapa nasce uma vez; camadas são redesenhadas a cada mudança.
  React.useEffect(() => {
    let cancelado = false;
    (async () => {
      const L = (await import("leaflet")).default;
      if (cancelado || !refCaixa.current || refMapa.current) return;
      const mapa: MapaLeaflet = L.map(refCaixa.current).setView([-26.17, -50.39], 11);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
      }).addTo(mapa);
      mapa.on("click", (e: { latlng: { lat: number; lng: number } }) => {
        if (refProps.current.modoMarcar) refProps.current.aoClicarMapa(e.latlng.lat, e.latlng.lng);
      });
      // Botões dentro do popup: delegação no abrir (o popup é DOM do Leaflet).
      mapa.on("popupopen", (e: { popup: { getElement: () => HTMLElement | undefined } }) => {
        const el = e.popup.getElement();
        const btn = el?.querySelector<HTMLButtonElement>("button[data-chave][data-acao]");
        if (btn && !btn.dataset.ligado) {
          btn.dataset.ligado = "1";
          btn.addEventListener("click", () => {
            refProps.current.aoAcaoParada(btn.dataset.chave ?? "", (btn.dataset.acao ?? "cheguei") as "cheguei" | "entregue");
          });
        }
      });
      refMapa.current = mapa;
      refRedesenhar.current(mapa);
    })();
    return () => {
      // StrictMode monta/desmonta em dev: sem remover, a segunda montagem
      // herda o contêiner inicializado ("map container is already
      // initialized") e o mapa nasce morto — clique nenhum funciona.
      cancelado = true;
      refMapa.current?.remove();
      refMapa.current = null;
    };
  }, []);

  // Redesenha quando os dados mudam (mapa já existe) — o pino pendente
  // incluso: sem ele, o clique não desenharia o alfinete.
  React.useEffect(() => {
    const m = refMapa.current;
    if (m) refRedesenhar.current(m);
  }, [paradas, geometria, origem, motorista, rastro, pinoPendente]);

  function redesenharCamadas(m: MapaLeaflet) {
    const { paradas: ps, geometria: geo, origem: ori, motorista: mot, rastro: ras, pinoPendente: pino } = refProps.current;
    void import("leaflet").then(({ default: L }) => {
      // Limpa só as camadas de dados (o tile fica): lista própria, sem
      // fuçar `options` do Leaflet.
      for (const c of refCamadas.current) m.removeLayer(c);
      refCamadas.current = [];
      const por = (camada: Layer): Layer => {
        refCamadas.current.push(camada);
        return camada;
      };
      const comCoord = ps.filter((p) => p.lat != null && p.lng != null);
      setSemMapa(ps.filter((p) => p.lat == null || p.lng == null).map((p) => p.cliente));

      if (geo.length > 1) {
        por(
          L.polyline(
            geo.map((c) => [c[1] as number, c[0] as number]),
            { color: "#7c3aed", weight: 4, opacity: 0.85 },
          ),
        ).addTo(m);
      }
      if (ras.length > 1) {
        por(L.polyline(ras, { color: "#6b7280", weight: 3, opacity: 0.7, dashArray: "6 6" })).addTo(m);
      }
      if (ori) {
        por(
          L.marker([ori.lat, ori.lng], {
            icon: L.divIcon({
              className: "",
              html: `<div title="${esc(t("Origem"))}" style="background:#16a34a;color:#fff;border-radius:6px;width:26px;height:26px;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;border:2px solid #fff">⌂</div>`,
              iconSize: [26, 26],
              iconAnchor: [13, 13],
            }),
          }),
        )
          .addTo(m)
          .bindPopup(`<b>${esc(t("Origem"))}</b>${ori.endereco ? `<br>${esc(ori.endereco)}` : ""}`);
      }
      for (const p of comCoord) {
        const cor = COR_ESTADO[p.estado];
        const sim = SIMBOLO_ESTADO[p.estado];
        const valor = p.pedidos.reduce((s, x) => s + x.total_cents, 0);
        const pedidosHtml = p.pedidos
          .map((x) => `#${x.numero} · ${esc(comoMoeda(x.total_cents, "BRL"))}`)
          .join("<br>");
        const botoes =
          p.estado === "entregue" || p.estado === "problema"
            ? ""
            : `<div style="margin-top:6px;display:flex;gap:6px">` +
              `<button data-chave="${esc(p.chave)}" data-acao="cheguei" style="background:#d97706;color:#fff;border:0;border-radius:4px;padding:4px 8px;font-size:12px">${esc(t("Cheguei"))}</button>` +
              `<button data-chave="${esc(p.chave)}" data-acao="entregue" style="background:#16a34a;color:#fff;border:0;border-radius:4px;padding:4px 8px;font-size:12px">${esc(t("Entregue"))}</button>` +
              `</div>`;
        por(
          L.marker([p.lat as number, p.lng as number], {
            icon: L.divIcon({
              className: "",
              html:
                `<div title="#${p.ordem} ${esc(p.cliente)}" style="background:${cor};color:#fff;border-radius:9999px;` +
                `min-width:26px;height:26px;padding:0 4px;display:flex;align-items:center;justify-content:center;` +
                `font-size:11px;font-weight:700;border:${p.estado === "proxima" ? "3px solid #111827" : "2px solid #fff"}">` +
                `${p.ordem}${sim ? ` ${sim}` : ""}</div>`,
              iconSize: [30, 26],
              iconAnchor: [15, 13],
            }),
          }),
        )
          .addTo(m)
          .bindPopup(
            `<b>#${p.ordem} ${esc(p.cliente)}</b>` +
              (p.endereco ? `<br>${esc(p.endereco)}` : "") +
              (p.fone ? `<br>${esc(p.fone)}` : "") +
              `<br>${pedidosHtml}` +
              `<br><b>${esc(comoMoeda(valor, "BRL"))}</b>` +
              botoes,
          );
      }
      if (mot) {
        por(
          L.marker([mot.lat, mot.lng], {
            icon: L.divIcon({
              className: "",
              html: `<div title="${esc(t("Motorista"))}" style="background:#fff;border-radius:9999px;width:30px;height:30px;display:flex;align-items:center;justify-content:center;font-size:17px;border:3px solid #2563eb">🚚</div>`,
              iconSize: [30, 30],
              iconAnchor: [15, 15],
            }),
          }),
        ).addTo(m);
      }
      // Pino pendente: o clique virou alfinete laranja (arrastável) — a
      // posição só vale depois do Confirmar. Sem isso, "marcar no mapa"
      // parecia não fazer nada.
      if (pino) {
        por(
          L.marker([pino.lat, pino.lng], {
            draggable: true,
            icon: L.divIcon({
              className: "",
              html: `<div title="${esc(t("Posição marcada — arraste para ajustar"))}" style="background:#ea580c;color:#fff;border-radius:9999px 9999px 9999px 0;width:30px;height:30px;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;border:2px solid #fff;transform:rotate(-45deg)"><span style="transform:rotate(45deg)">📍</span></div>`,
              iconSize: [30, 30],
              iconAnchor: [4, 26],
            }),
          }),
        )
          .addTo(m)
          .on("dragend", (e: { target: { getLatLng: () => { lat: number; lng: number } } }) => {
            const ll = e.target.getLatLng();
            refProps.current.aoClicarMapa(ll.lat, ll.lng);
          });
      }
      const todos: [number, number][] = [
        ...comCoord.map((p) => [p.lat as number, p.lng as number] as [number, number]),
        ...(ori ? [[ori.lat, ori.lng] as [number, number]] : []),
        ...(mot ? [[mot.lat, mot.lng] as [number, number]] : []),
      ];
      if (todos.length > 0) m.fitBounds(L.latLngBounds(todos), { padding: [30, 30] });
    });
  }

  // Liga o despacho na função real (em efeito: escrever ref é sincronização).
  React.useEffect(() => {
    refRedesenhar.current = (m: MapaLeaflet) => redesenharCamadas(m);
  });

  return (
    <div className="space-y-2">
      <div
        ref={refCaixa}
        className="overflow-hidden rounded-2xl border bg-muted"
        style={{ height: altura ?? "50vh", cursor: modoMarcar ? "crosshair" : undefined }}
      />
      <p className="text-xs text-muted-foreground">
        {modoMarcar
          ? pinoPendente
            ? t("Arraste o alfinete para ajustar e confirme abaixo.")
            : t("Clique no mapa para soltar o alfinete.")
          : geometria.length > 1
            ? t("Rota pelas ruas (OSRM). Linha cinza tracejada = já percorrido.")
            : t("Geometria da rua ainda não calculada — otimize a rota.")}
      </p>
      {semMapa.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {t("Sem localização")}: {semMapa.join(", ")}
        </p>
      )}
    </div>
  );
}
