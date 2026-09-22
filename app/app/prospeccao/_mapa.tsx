"use client";

import * as React from "react";
import type { DivIcon, LayerGroup, Map as MapaLeaflet } from "leaflet";

import "leaflet/dist/leaflet.css";

import { useT } from "@/hooks/i18n/useT";
import { clusterizar, ehCluster, type PontoGeo } from "@/lib/prospeccao/geo";

/**
 * O MAPA (§§3–10, 15–16, 20, 34–38 do plano) — os mesmos prospects da lista.
 *
 * Leaflet PURO (sem react-leaflet): imperativo por natureza, e o binding
 * adicionaria camada sem valor + atrito com React 19. Import dinâmico
 * (ssr:false) no pai mantém fora do bundle. OSM sem chave (+ Esri satélite
 * como camada opcional, com atribuição). DivIcon (o PNG padrão quebra em
 * bundler). Cluster por grade própria (`lib/prospeccao/geo.ts`, testado) —
 * sem plugin.
 *
 * Estados do marcador (nunca só cor): novo (roxo/score), crm (azul/•),
 * cliente (verde/✓), selecionado (anel). Sem coordenada confiável, sem
 * marcador — o pai já filtra.
 */

export type StatusMapa = "novo" | "crm" | "cliente";

export interface PontoMapa extends PontoGeo {
  nome: string;
  categoria: string | null;
  cidade: string | null;
  estado: string | null;
  telefone: string | null;
  website: string | null;
  status: StatusMapa;
  score: number;
}

const CORES: Record<StatusMapa, string> = {
  novo: "#7c3aed",
  crm: "#2563eb",
  cliente: "#16a34a",
};

const SIMBOLO: Record<StatusMapa, string> = {
  novo: "",
  crm: "•",
  cliente: "✓",
};

export function MapaProspects({
  lista,
  selecionadoId,
  selecionados,
  onSelecionar,
  onVer,
  onAdicionar,
  centro,
  raioKm,
  modo,
  onModo,
  onArea,
  rota,
  alturaClasse,
}: {
  lista: PontoMapa[];
  selecionadoId: string | null;
  selecionados: string[];
  onSelecionar: (id: string | null) => void;
  onVer: (id: string) => void;
  onAdicionar: (ids: string[]) => void;
  centro: { latitude: number; longitude: number } | null;
  raioKm: number | null;
  modo: "marcadores" | "densidade";
  onModo: (modo: "marcadores" | "densidade") => void;
  onArea: (limites: { sul: number; oeste: number; norte: number; leste: number }) => void;
  /** Linha da rota (pontos ordenados de visita). */
  rota?: { latitude: number; longitude: number; nome: string }[];
  alturaClasse?: string;
}) {
  const t = useT();
  const refCaixa = React.useRef<HTMLDivElement>(null);
  const refMapa = React.useRef<MapaLeaflet | null>(null);
  const refCamada = React.useRef<LayerGroup | null>(null);
  const cbRef = React.useRef({ onSelecionar, onVer, onAdicionar, onArea });
  React.useEffect(() => {
    cbRef.current = { onSelecionar, onVer, onAdicionar, onArea };
  });
  const [zoom, setZoom] = React.useState(12);

  // Monta o mapa uma vez; camadas base OSM + satélite Esri.
  React.useEffect(() => {
    if (!refCaixa.current || refMapa.current) return;
    let cancelado = false;
    (async () => {
      const L = (await import("leaflet")).default;
      if (cancelado || !refCaixa.current || refMapa.current) return;
      const mapa = L.map(refCaixa.current).setView([-26.17, -50.39], 12);
      const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19,
      });
      const satelite = L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        {
          attribution: "Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics",
          maxZoom: 19,
        },
      );
      osm.addTo(mapa);
      L.control.layers({ Mapa: osm, Satélite: satelite }).addTo(mapa);
      refCamada.current = L.layerGroup().addTo(mapa);
      mapa.on("zoomend moveend", () => setZoom(mapa.getZoom()));
      refMapa.current = mapa;
    })();
    return () => {
      cancelado = true;
    };
  }, []);

  // Desenha pontos/clusters/densidade/raio/rota; reage a lista, zoom, modo e seleção.
  React.useEffect(() => {
    const mapa = refMapa.current;
    const camada = refCamada.current;
    if (!mapa || !camada) return;
    let cancelado = false;
    (async () => {
      const L = (await import("leaflet")).default;
      if (cancelado) return;
      camada.clearLayers();
      const escapar = (s: string): string =>
        s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

      if (centro && raioKm) {
        L.circle([centro.latitude, centro.longitude], {
          radius: raioKm * 1000,
          color: "#7c3aed",
          weight: 1.5,
          dashArray: "6 4",
          fillOpacity: 0.05,
        }).addTo(camada);
        L.marker([centro.latitude, centro.longitude], {
          icon: L.divIcon({
            className: "",
            html: `<div style="background:#7c3aed;border-radius:9999px;width:12px;height:12px;border:2px solid #fff"></div>`,
            iconSize: [12, 12],
            iconAnchor: [6, 6],
          }),
          interactive: false,
        }).addTo(camada);
      }

      const itens = clusterizar(lista, zoom);
      if (modo === "densidade") {
        const max = Math.max(1, ...itens.map((i) => (ehCluster(i) ? i.pontos.length : 1)));
        for (const item of itens) {
          const n = ehCluster(item) ? item.pontos.length : 1;
          L.circle([item.latitude, item.longitude], {
            radius: 300 + (6000 * n) / max,
            color: "#7c3aed",
            weight: 0,
            fillColor: "#7c3aed",
            fillOpacity: 0.15 + (0.45 * n) / max,
            interactive: false,
          }).addTo(camada);
        }
        return;
      }

      const iconeCluster = (n: number): DivIcon =>
        L.divIcon({
          className: "",
          html:
            `<div style="background:#1e293b;color:#fff;border-radius:9999px;` +
            `min-width:32px;height:32px;display:flex;align-items:center;justify-content:center;` +
            `font-size:12px;font-weight:700;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);padding:0 6px">${n}</div>`,
          iconSize: [32, 32],
          iconAnchor: [16, 16],
        });

      const iconePonto = (p: PontoMapa): DivIcon => {
        const sel = selecionadoId === p.id || selecionados.includes(p.id);
        return L.divIcon({
          className: "",
          html:
            `<div style="background:${CORES[p.status]};color:#fff;border-radius:9999px;` +
            `width:28px;height:28px;display:flex;align-items:center;justify-content:center;` +
            `font-size:11px;font-weight:700;border:${sel ? "3px solid #facc15" : "2px solid #fff"};` +
            `box-shadow:0 1px 4px rgba(0,0,0,.4)">${SIMBOLO[p.status]}${p.score}</div>`,
          iconSize: [28, 28],
          iconAnchor: [14, 14],
          popupAnchor: [0, -14],
        });
      };

      for (const item of itens) {
        if (ehCluster(item)) {
          const mk = L.marker([item.latitude, item.longitude], { icon: iconeCluster(item.pontos.length) });
          mk.on("click", () => mapa.setView([item.latitude, item.longitude], Math.min(19, mapa.getZoom() + 2)));
          mk.addTo(camada);
          continue;
        }        const p = item as PontoMapa;
        const fone = p.telefone ? `<br>${escapar(p.telefone)}` : "";
        const zap = p.telefone
          ? `<br><a href="https://wa.me/${p.telefone.replace(/\D/g, "")}" target="_blank" rel="noopener">WhatsApp</a>`
          : "";
        const mk = L.marker([p.latitude, p.longitude], { icon: iconePonto(p) }).addTo(camada);
        mk.bindPopup(
          `<b>${escapar(p.nome)}</b><br>${escapar([p.categoria, [p.cidade, p.estado].filter(Boolean).join("/")].filter(Boolean).join(" · "))}${fone}${zap}` +
            `<br><br><button data-acao="ver" style="text-decoration:underline">Ver empresa</button>` +
            ` · <button data-acao="crm" style="text-decoration:underline">Adicionar ao CRM</button>`,
        );
        mk.on("click", () => cbRef.current.onSelecionar(p.id));
        mk.on("popupopen", (e) => {
          const el = (e as { popup: { getElement: () => HTMLElement | undefined } }).popup.getElement();
          el?.querySelector('[data-acao="ver"]')?.addEventListener("click", () => cbRef.current.onVer(p.id));
          el?.querySelector('[data-acao="crm"]')?.addEventListener("click", () => cbRef.current.onAdicionar([p.id]));
        });
      }

      // Rota de visita: linha + paradas numeradas.
      if (rota && rota.length > 0) {
        L.polyline(
          rota.map((r) => [r.latitude, r.longitude] as [number, number]),
          { color: "#7c3aed", weight: 3, opacity: 0.8 },
        ).addTo(camada);
        rota.forEach((r, i) => {
          L.marker([r.latitude, r.longitude], {
            icon: L.divIcon({
              className: "",
              html:
                `<div style="background:#7c3aed;color:#fff;border-radius:9999px;` +
                `width:24px;height:24px;display:flex;align-items:center;justify-content:center;` +
                `font-size:11px;font-weight:700;border:2px solid #fff">${i + 1}</div>`,
              iconSize: [24, 24],
              iconAnchor: [12, 12],
            }),
            interactive: false,
          }).addTo(camada);
        });
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [lista, zoom, modo, selecionadoId, selecionados, centro, raioKm, rota]);

  // Seleção vinda da lista: centraliza sem trocar o zoom.
  React.useEffect(() => {
    const mapa = refMapa.current;
    if (!mapa || !selecionadoId) return;
    const p = lista.find((x) => x.id === selecionadoId);
    if (p) mapa.panTo([p.latitude, p.longitude]);
  }, [selecionadoId, lista]);

  // Primeira carga: enquadra todos os resultados.
  const jaEnquadrou = React.useRef(false);
  React.useEffect(() => {
    const mapa = refMapa.current;
    if (!mapa || jaEnquadrou.current || lista.length === 0) return;
    (async () => {
      const L = (await import("leaflet")).default;
      jaEnquadrou.current = true;
      mapa.fitBounds(
        L.latLngBounds(lista.map((p) => [p.latitude, p.longitude] as [number, number])),
        { padding: [30, 30] },
      );
    })();
  }, [lista]);

  function buscarNestaArea(): void {
    const mapa = refMapa.current;
    if (!mapa) return;
    const b = mapa.getBounds();
    cbRef.current.onArea({ sul: b.getSouth(), oeste: b.getWest(), norte: b.getNorth(), leste: b.getEast() });
  }

  function telaCheia(): void {
    const el = refCaixa.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen().catch(() => undefined);
  }

  if (lista.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("Nenhum resultado com localização.")}</p>;
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onModo("marcadores")}
          aria-pressed={modo === "marcadores"}
          className={`rounded-full border px-3 py-1.5 text-xs ${modo === "marcadores" ? "bg-primary text-primary-foreground" : ""}`}
        >
          {t("Marcadores")}
        </button>
        <button
          type="button"
          onClick={() => onModo("densidade")}
          aria-pressed={modo === "densidade"}
          className={`rounded-full border px-3 py-1.5 text-xs ${modo === "densidade" ? "bg-primary text-primary-foreground" : ""}`}
        >
          {t("Densidade")}
        </button>
        <button
          type="button"
          onClick={buscarNestaArea}
          className="rounded-full border px-3 py-1.5 text-xs underline underline-offset-4"
        >
          {t("Buscar nesta área")}
        </button>
        <button
          type="button"
          onClick={telaCheia}
          className="rounded-full border px-3 py-1.5 text-xs underline underline-offset-4"
        >
          {t("Tela cheia")}
        </button>
      </div>
      <div ref={refCaixa} className={`${alturaClasse ?? "h-[65vh]"} overflow-hidden rounded-2xl border bg-muted`} />
      <p className="text-xs text-muted-foreground">
        {t("Mapa: OpenStreetMap · Satélite: Esri. Círculo = raio da busca.")}
      </p>
    </div>
  );
}
