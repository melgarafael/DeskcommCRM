"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { EmptyFilterResults } from "@/components/empty";
import {
  FilterActions,
  FilterAdvanced,
  FilterBar,
  FilterChips,
  FilterNumber,
  FilterPrimary,
  FilterSearch,
  FilterSelect,
  type ActiveChip,
} from "@/components/filters/FilterBar";
import { useT } from "@/hooks/i18n/useT";
import { useDebouncedCallback } from "@/hooks/useDebouncedCallback";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { apiClient } from "@/lib/api/client";
import { ImportarArquivoDialog } from "./_importar-arquivo";
import { distanciaKm, limitesDosPontos, centroERaioDoBbox, ordemDeVisita, comprimentoDaRota } from "@/lib/prospeccao/geo";
import type { PontoMapa } from "./_mapa";
import {
  ROTULO_STATUS_COMERCIAL,
  STATUS_COMERCIAL,
  type Prospect,
} from "@/lib/schemas/prospeccao";

/**
 * Aba EMPRESAS — tabela + mapa sincronizados (§§14, 20 do plano).
 *
 * Filtros e lista vivem aqui; o mapa (`_mapa.tsx`, leaflet via dynamic +
 * ssr:false para não pesar o bundle) recebe a MESMA lista filtrada — tabela
 * e mapa sempre mostram o mesmo conjunto. Ações: WhatsApp (wa.me, nunca
 * campanha automática), status, excluir (LGPD), importar ao CRM (unitário e
 * em lote).
 */
const MapaProspects = dynamic(() => import("./_mapa").then((m) => m.MapaProspects), {
  ssr: false,
  loading: () => (
    <div className="flex h-96 items-center justify-center p-6">
      <Skeleton className="h-full w-full" />
    </div>
  ),
});

interface Filtros {
  busca: string;
  categoria: string;
  cidade: string;
  estado: string;
  status: string;
  comTelefone: boolean;
  comWebsite: boolean;
  comWhatsapp: boolean;
  notaMin: string;
  soSemCliente: boolean;
}

const VAZIOS: Filtros = {
  busca: "",
  categoria: "",
  cidade: "",
  estado: "",
  status: "",
  comTelefone: false,
  comWebsite: false,
  comWhatsapp: false,
  notaMin: "",
  soSemCliente: false,
};

export function EmpresasTab({ podeOperar }: { podeOperar: boolean }) {
  const t = useT();
  const router = useRouter();
  const paramsUrl = useSearchParams();
  const [filtros, setFiltros] = React.useState<Filtros>(() => ({
    ...VAZIOS,
    busca: paramsUrl.get("busca") ?? "",
    categoria: paramsUrl.get("categoria") ?? "",
    cidade: paramsUrl.get("cidade") ?? "",
    estado: paramsUrl.get("estado") ?? "",
    status: paramsUrl.get("status") ?? "",
  }));
  const [lista, setLista] = React.useState<(Prospect & { ja_e_cliente: boolean })[] | null>(null);
  const [selecionados, setSelecionados] = React.useState<string[]>([]);
  const [visao, setVisao] = React.useState<"tabela" | "mapa">("tabela");
  const [dono, setDono] = React.useState("");
  const [vendedores, setVendedores] = React.useState<{ user_id: string; full_name: string | null }[]>([]);
  const [selecionadoId, setSelecionadoId] = React.useState<string | null>(() => paramsUrl.get("empresa"));
  const [modoMapa, setModoMapa] = React.useState<"marcadores" | "densidade">("marcadores");
  const [ordem, setOrdem] = React.useState<string>(() => paramsUrl.get("ordem") ?? "relevancia");
  const [detalheId, setDetalheId] = React.useState<string | null>(null);
  const [rotaIds, setRotaIds] = React.useState<string[] | null>(null);
  const [visiveis, setVisiveis] = React.useState(100);
  const [importandoArquivo, setImportandoArquivo] = React.useState(false);
  const refsLinhas = React.useRef(new Map<string, HTMLDivElement>());

  React.useEffect(() => {
    if (!podeOperar) return;
    apiClient
      .get<{ data: { user_id: string; full_name: string | null }[] }>("/api/v1/team/assignable")
      .then((r) => setVendedores(Array.isArray(r?.data) ? r.data : []))
      .catch(() => undefined);
  }, [podeOperar]);

  const buscar = React.useCallback(async (f: Filtros) => {
    try {
      const qs = new URLSearchParams();
      if (f.busca.trim()) qs.set("busca", f.busca.trim());
      if (f.categoria.trim()) qs.set("categoria", f.categoria.trim());
      if (f.cidade.trim()) qs.set("cidade", f.cidade.trim());
      if (f.estado.trim()) qs.set("estado", f.estado.trim());
      if (f.status) qs.set("status", f.status);
      if (f.comTelefone) qs.set("com_telefone", "true");
      if (f.comWebsite) qs.set("com_website", "true");
      if (f.comWhatsapp) qs.set("com_whatsapp", "true");
      if (f.notaMin) qs.set("nota_min", f.notaMin);
      if (f.soSemCliente) qs.set("so_sem_cliente", "true");
      const corpo = await apiClient.get<{ data: unknown }>(
        `/api/v1/prospecting/prospects${qs.toString() ? `?${qs}` : ""}`,
      );
      const dados = (corpo as { data?: unknown } | null)?.data;
      setLista(Array.isArray(dados) ? dados : []);
      setSelecionados([]);
    } catch (e) {
      showApiError(e);
    }
  }, []);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void buscar(VAZIOS);
  }, [buscar]);

  // Texto espera 350ms parada; selects e toggles aplicam na hora — o mesmo
  // vocabulário da tela de pedidos.
  const buscarDevagar = useDebouncedCallback((f: Filtros) => void buscar(f), 350);

  function mudar(patch: Partial<Filtros>, devagar = false) {
    setFiltros((atual) => {
      const f = { ...atual, ...patch };
      if (devagar) buscarDevagar(f);
      else void buscar(f);
      return f;
    });
  }

  const [avancadosAbertos, setAvancadosAbertos] = React.useState(false);
  const avancadosAtivos = [
    filtros.cidade.trim(),
    filtros.notaMin,
    filtros.comTelefone ? "x" : "",
    filtros.comWebsite ? "x" : "",
    filtros.comWhatsapp ? "x" : "",
    filtros.soSemCliente ? "x" : "",
  ].filter(Boolean).length;

  const chips: ActiveChip[] = [];
  if (filtros.busca.trim()) {
    chips.push({
      key: "busca",
      label: filtros.busca.trim(),
      onRemove: () => mudar({ busca: "" }, true),
    });
  }
  if (filtros.status) {
    chips.push({
      key: "status",
      label: `${t("Status")}: ${ROTULO_STATUS_COMERCIAL[filtros.status as keyof typeof ROTULO_STATUS_COMERCIAL] ?? filtros.status}`,
      onRemove: () => mudar({ status: "" }),
    });
  }
  if (filtros.cidade.trim()) {
    chips.push({
      key: "cidade",
      label: `${t("Cidade")}: ${filtros.cidade.trim()}`,
      onRemove: () => mudar({ cidade: "" }, true),
    });
  }
  if (filtros.notaMin) {
    chips.push({
      key: "notaMin",
      label: `${t("Nota mínima")}: ${filtros.notaMin}`,
      onRemove: () => mudar({ notaMin: "" }),
    });
  }
  for (const [campo, rotulo] of [
    ["comTelefone", t("Com telefone")],
    ["comWebsite", t("Com website")],
    ["comWhatsapp", t("Com WhatsApp")],
    ["soSemCliente", t("Ainda não é cliente")],
  ] as const) {
    if (filtros[campo]) {
      chips.push({ key: campo, label: rotulo, onRemove: () => mudar({ [campo]: false }) });
    }
  }

  function limparFiltros() {
    setFiltros(VAZIOS);
    setAvancadosAbertos(false);
    void buscar(VAZIOS);
  }

  function alternar(id: string) {
    setSelecionados((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  // URL state (§40): filtros + ordem + empresa sobrevivem a reload e link.
  React.useEffect(() => {
    const qs = new URLSearchParams();
    if (filtros.busca.trim()) qs.set("busca", filtros.busca.trim());
    if (filtros.categoria.trim()) qs.set("categoria", filtros.categoria.trim());
    if (filtros.cidade.trim()) qs.set("cidade", filtros.cidade.trim());
    if (filtros.estado.trim()) qs.set("estado", filtros.estado.trim());
    if (filtros.status) qs.set("status", filtros.status);
    if (ordem !== "relevancia") qs.set("ordem", ordem);
    if (selecionadoId) qs.set("empresa", selecionadoId);
    router.replace(`/app/prospeccao${qs.toString() ? `?${qs}` : ""}`, { scroll: false });
  }, [filtros.busca, filtros.categoria, filtros.cidade, filtros.estado, filtros.status, ordem, selecionadoId, router]);

  type ItemLista = Prospect & { ja_e_cliente: boolean };
  const comGeo = React.useMemo(
    () => (lista ?? []).filter((p) => p.latitude !== null && p.longitude !== null),
    [lista],
  );
  const pontos: PontoMapa[] = React.useMemo(
    () =>
      comGeo.map((p) => ({
        id: p.id,
        nome: p.nome,
        latitude: p.latitude as number,
        longitude: p.longitude as number,
        categoria: p.categoria,
        cidade: p.cidade,
        estado: p.estado,
        telefone: p.telefone,
        website: p.website,
        status: p.status_comercial === "cliente" || p.ja_e_cliente ? ("cliente" as const) : p.contact_id || p.lead_id ? ("crm" as const) : ("novo" as const),
        score: p.score,
      })),
    [comGeo],
  );
  const limites = React.useMemo(
    () => limitesDosPontos(pontos.map((p) => ({ id: p.id, latitude: p.latitude, longitude: p.longitude }))),
    [pontos],
  );
  const centroRaio = React.useMemo(() => (limites ? centroERaioDoBbox(limites) : null), [limites]);

  const ordenada = React.useMemo(() => {
    const base = [...(lista ?? [])];
    const ref = centroRaio;
    const dist = (p: ItemLista): number =>
      ref && p.latitude !== null && p.longitude !== null
        ? distanciaKm(ref.latitude, ref.longitude, p.latitude, p.longitude)
        : Number.POSITIVE_INFINITY;
    switch (ordem) {
      case "distancia":
        return base.sort((a, b) => dist(a) - dist(b));
      case "rating":
        return base.sort((a, b) => (b.nota ?? -1) - (a.nota ?? -1));
      case "avaliacoes":
        return base.sort((a, b) => b.total_avaliacoes - a.total_avaliacoes);
      case "nome":
        return base.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
      case "recentes":
        return base.sort((a, b) => (a.discovered_at < b.discovered_at ? 1 : -1));
      default:
        return base.sort((a, b) => b.score - a.score);
    }
  }, [lista, ordem, centroRaio]);

  const analise = React.useMemo(() => {
    const l = lista ?? [];
    const comFone = l.filter((p) => p.telefone).length;
    const comSite = l.filter((p) => p.website).length;
    const notas = l.map((p) => p.nota).filter((n): n is number => n !== null);
    return {
      total: l.length,
      novas: l.filter((p) => !p.contact_id && !p.ja_e_cliente).length,
      noCrm: l.filter((p) => p.contact_id || p.lead_id).length,
      clientes: l.filter((p) => p.ja_e_cliente).length,
      comFone,
      comSite,
      ratingMedio: notas.length > 0 ? notas.reduce((a, b) => a + b, 0) / notas.length : null,
    };
  }, [lista]);

  function selecionar(id: string | null) {
    setSelecionadoId(id);
    if (id) {
      setDetalheId(null);
      requestAnimationFrame(() => {
        refsLinhas.current.get(id)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    }
  }

  async function buscarNestaArea(lim: { sul: number; oeste: number; norte: number; leste: number }) {
    const categorias = [...new Set((lista ?? []).map((p) => p.categoria).filter(Boolean))].slice(0, 10) as string[];
    if (categorias.length === 0) {
      toast.error(t("Sem categorias nos resultados para buscar na área."));
      return;
    }
    const centro = { latitude: (lim.sul + lim.norte) / 2, longitude: (lim.oeste + lim.leste) / 2 };
    const raio = Math.max(1, Math.ceil(distanciaKm(lim.sul, lim.oeste, lim.norte, lim.leste) / 2));
    try {
      await apiClient.post("/api/v1/prospecting/searches", {
        categorias,
        latitude: Math.round(centro.latitude * 10000) / 10000,
        longitude: Math.round(centro.longitude * 10000) / 10000,
        raio_km: Math.min(500, raio),
        rotulo: "Área do mapa",
        provider: "osm_overpass",
      });
      toast.success(t("Busca da área criada — acompanhe na aba Pesquisas."));
    } catch (e) {
      showApiError(e);
    }
  }

  function criarRota(ids: string[]) {
    const pts = ids
      .map((id) => pontos.find((p) => p.id === id))
      .filter((p): p is PontoMapa => !!p && p.latitude !== null);
    if (pts.length < 2) {
      toast.error(t("Selecione ao menos 2 empresas com localização."));
      return;
    }
    setRotaIds(ordemDeVisita(pts.map((p) => ({ id: p.id, latitude: p.latitude, longitude: p.longitude }))).map((p) => p.id));
    setVisao("mapa");
  }

  const rota = React.useMemo(() => {
    if (!rotaIds) return null;
    const pts = rotaIds
      .map((id) => pontos.find((p) => p.id === id))
      .filter((p): p is PontoMapa => !!p);
    if (pts.length === 0) return null;
    return { pontos: pts, km: comprimentoDaRota(pts.map((p) => ({ id: p.id, latitude: p.latitude, longitude: p.longitude }))) };
  }, [rotaIds, pontos]);

  const detalhe = detalheId ? (lista ?? []).find((p) => p.id === detalheId) ?? null : null;

  function navegarHref(p: { latitude: number | null; longitude: number | null }): string {
    return `https://www.openstreetmap.org/directions?to=${p.latitude},${p.longitude}`;
  }

  async function importar(ids: string[]) {
    if (ids.length === 0) {
      toast.error(t("Selecione ao menos 1 empresa."));
      return;
    }
    try {
      const corpo = await apiClient.post<{
        data: { vinculados: number; criados: number; recusados: number; detalhes: string[] } | null;
      }>("/api/v1/prospecting/prospects/import", {
        prospect_ids: ids,
        ...(dono.trim() ? { owner_user_id: dono.trim() } : {}),
      });
      const r = corpo?.data ?? { vinculados: 0, criados: 0, recusados: 0, detalhes: [] as string[] };
      toast.success(t(`CRM: ${r.criados} criados, ${r.vinculados} vinculados, ${r.recusados} recusados`));
      if (Array.isArray(r.detalhes) && r.detalhes.length > 0) toast.info(r.detalhes.slice(0, 3).join(" "));
      await buscar(filtros);
    } catch (e) {
      showApiError(e);
    }
  }

  async function mudarStatus(id: string, status_comercial: string) {
    try {
      await apiClient.patch(`/api/v1/prospecting/prospects/${id}`, { status_comercial });
      await buscar(filtros);
    } catch (e) {
      showApiError(e);
    }
  }

  async function excluir(id: string, nome: string) {
    if (!window.confirm(t(`Excluir "${nome}" da base? (LGPD)`))) return;
    try {
      await apiClient.delete(`/api/v1/prospecting/prospects/${id}`);
      await buscar(filtros);
    } catch (e) {
      showApiError(e);
    }
  }

  function zapHref(p: Prospect): string | null {
    if (!p.telefone) return null;
    const digitos = p.telefone.replace(/\D/g, "");
    if (digitos.length < 10) return null;
    return `https://wa.me/${digitos}?text=${encodeURIComponent(`Olá ${p.nome}! Posso falar sobre uma condição para sua empresa?`)}`;
  }

  return (
    <div className="space-y-4">
      <FilterBar>
        <FilterPrimary>
          <FilterSearch
            id="f-busca"
            label={t("Buscar")}
            value={filtros.busca}
            onChange={(busca) => mudar({ busca }, true)}
            placeholder={t("nome, telefone, cidade, site…")}
          />
          <FilterSelect
            id="f-status"
            label={t("Status")}
            value={filtros.status}
            onChange={(status) => mudar({ status })}
            allLabel={t("Todos")}
            options={STATUS_COMERCIAL.map((s) => ({ value: s, label: ROTULO_STATUS_COMERCIAL[s] }))}
          />
        </FilterPrimary>

        <FilterAdvanced
          open={avancadosAbertos}
          onToggle={() => setAvancadosAbertos((a) => !a)}
          toggleLabel={t("Filtros avançados")}
          activeCount={avancadosAtivos}
        >
          <div className="w-full space-y-1.5 sm:w-44 md:shrink-0">
            <Label htmlFor="f-cidade" className="block text-sm font-medium">
              {t("Cidade")}
            </Label>
            <Input
              id="f-cidade"
              value={filtros.cidade}
              onChange={(e) => mudar({ cidade: e.target.value }, true)}
              className="h-9"
            />
          </div>
          <FilterNumber
            id="f-nota"
            label={t("Nota mínima")}
            value={filtros.notaMin}
            onChange={(notaMin) => mudar({ notaMin })}
            min={0}
          />
          <div className="flex flex-wrap items-center gap-1.5 pb-0.5">
            {(
              [
                ["comTelefone", t("Com telefone")],
                ["comWebsite", t("Com website")],
                ["comWhatsapp", t("Com WhatsApp")],
                ["soSemCliente", t("Ainda não é cliente")],
              ] as const
            ).map(([campo, rotulo]) => (
              <Button
                key={campo}
                type="button"
                size="sm"
                variant={filtros[campo] ? "default" : "outline"}
                onClick={() => mudar({ [campo]: !filtros[campo] })}
                aria-pressed={filtros[campo]}
              >
                {rotulo}
              </Button>
            ))}
          </div>
        </FilterAdvanced>

        <FilterChips chips={chips} onClearAll={limparFiltros} clearLabel={t("Limpar filtros")} />

        <FilterActions>
          <div className="ml-auto flex gap-2">
            {podeOperar && (
              <Button size="sm" variant="outline" onClick={() => setImportandoArquivo(true)}>
                {t("Importar arquivo")}
              </Button>
            )}
            <Button size="sm" variant={visao === "tabela" ? "default" : "outline"} onClick={() => setVisao("tabela")}>
              {t("Tabela")}
            </Button>
            <Button size="sm" variant={visao === "mapa" ? "default" : "outline"} onClick={() => setVisao("mapa")}>
              {t("Mapa")}
            </Button>
          </div>
        </FilterActions>
      </FilterBar>

      {lista === null ? (
        <div className="space-y-2" aria-live="polite">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-3/4" />
        </div>
      ) : visao === "mapa" ? (
        <div className="space-y-3">
          {(lista?.length ?? 0) > 0 && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-live="polite">
              <span><strong className="text-foreground tabular-nums">{analise.total}</strong> {t("encontradas")}</span>
              <span><strong className="text-foreground tabular-nums">{analise.novas}</strong> {t("novas")}</span>
              <span><strong className="text-foreground tabular-nums">{analise.noCrm}</strong> {t("no CRM")}</span>
              <span><strong className="text-foreground tabular-nums">{analise.clientes}</strong> {t("clientes")}</span>
              <span><strong className="text-foreground tabular-nums">{analise.comFone}</strong> {t("com telefone")}</span>
              <span><strong className="text-foreground tabular-nums">{analise.comSite}</strong> {t("com site")}</span>
              {analise.ratingMedio != null && (
                <span>★ <strong className="text-foreground tabular-nums">{analise.ratingMedio.toFixed(1)}</strong> {t("médio")}</span>
              )}
            </div>
          )}
          <div className="flex flex-wrap items-end gap-3">
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">{t("Ordenar")}</span>
              <select
                value={ordem}
                onChange={(e) => setOrdem(e.target.value)}
                className="h-9 rounded-lg border bg-background px-3"
              >
                <option value="relevancia">{t("Relevância")}</option>
                <option value="distancia">{t("Distância")}</option>
                <option value="rating">{t("Rating")}</option>
                <option value="avaliacoes">{t("Avaliações")}</option>
                <option value="nome">{t("Nome")}</option>
                <option value="recentes">{t("Mais recentes")}</option>
              </select>
            </label>
            {podeOperar && selecionados.length >= 2 && (
              <Button size="sm" variant="outline" onClick={() => criarRota(selecionados)}>
                {t("Criar rota")}
              </Button>
            )}
            {rota && (
              <Button size="sm" variant="ghost" onClick={() => setRotaIds(null)}>
                {t("Limpar rota")} ({rota.km} km)
              </Button>
            )}
          </div>
          {rota && (
            <Card className="p-3">
              <p className="mb-2 text-sm font-medium">
                {t("Rota")} · {rota.pontos.length} {t("paradas")} · {rota.km} km
              </p>
              <ol className="space-y-1 text-sm">
                {rota.pontos.map((p, i) => (
                  <li key={p.id} className="flex items-center gap-2">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] text-primary-foreground">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{p.nome}</span>
                    <a
                      href={navegarHref(p)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs underline underline-offset-4"
                    >
                      {t("Ir até")}
                    </a>
                  </li>
                ))}
              </ol>
            </Card>
          )}
          <div className="grid gap-3 lg:grid-cols-[35%_65%]">
            <div className="max-h-[65vh] space-y-1.5 overflow-y-auto pr-1">
              {ordenada.slice(0, visiveis).map((p) => (
                <div
                  key={p.id}
                  ref={(el) => {
                    if (el) refsLinhas.current.set(p.id, el);
                    else refsLinhas.current.delete(p.id);
                  }}
                >
                  <Card
                    className={`cursor-pointer p-2.5 transition-colors hover:border-primary/40 ${selecionadoId === p.id ? "border-primary ring-1 ring-primary" : ""}`}
                    onClick={() => selecionar(p.id === selecionadoId ? null : p.id)}
                  >
                    <p className="truncate text-sm font-medium">{p.nome}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {[p.categoria, [p.cidade, p.estado].filter(Boolean).join("/")].filter(Boolean).join(" · ")}
                    </p>
                    <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                      {p.nota !== null ? `★ ${p.nota} (${p.total_avaliacoes})` : ""}
                      {p.ja_e_cliente ? ` · ${t("Cliente")}` : p.contact_id || p.lead_id ? ` · ${t("No CRM")}` : ""}
                      {` · ${p.score}`}
                    </p>
                  </Card>
                </div>
              ))}
              {ordenada.length > visiveis && (
                <Button size="sm" variant="outline" onClick={() => setVisiveis((v) => v + 100)} className="w-full">
                  {t("Mostrar mais")} ({ordenada.length - visiveis} {t("restantes")})
                </Button>
              )}
            </div>
            <MapaProspects
              lista={pontos}
              selecionadoId={selecionadoId}
              selecionados={selecionados}
              onSelecionar={selecionar}
              onVer={(id) => setDetalheId(id)}
              onAdicionar={(ids) => void importar(ids)}
              centro={centroRaio ? { latitude: centroRaio.latitude, longitude: centroRaio.longitude } : null}
              raioKm={centroRaio?.raioKm ?? null}
              modo={modoMapa}
              onModo={setModoMapa}
              onArea={(lim) => void buscarNestaArea(lim)}
              rota={rota?.pontos.map((p) => ({ latitude: p.latitude, longitude: p.longitude, nome: p.nome })) ?? undefined}
              alturaClasse="h-[65vh]"
            />
          </div>
        </div>
      ) : lista.length === 0 && chips.length > 0 ? (
        <EmptyFilterResults primary={{ label: t("Limpar filtros"), onClick: limparFiltros }} />
      ) : lista.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          {t("Nenhuma empresa com estes filtros.")}
        </Card>
      ) : (
        <>
          {podeOperar && (
            <Card className="flex flex-wrap items-center gap-2 p-3">
              <span className="text-sm text-muted-foreground">
                {selecionados.length} {t("selecionadas")}
              </span>
              <select
                className="rounded-lg border bg-background px-3 py-2 text-sm"
                value={dono}
                onChange={(e) => setDono(e.target.value)}
                aria-label={t("Vendedor responsável (opcional)")}
              >
                <option value="">{t("Sem dono específico")}</option>
                {vendedores.map((v) => (
                  <option key={v.user_id} value={v.user_id}>
                    {v.full_name ?? v.user_id.slice(0, 8)}
                  </option>
                ))}
              </select>
              <Button size="sm" onClick={() => void importar(selecionados)}>
                {t("Adicionar ao CRM")}
              </Button>
            </Card>
          )}
          <div className="overflow-x-auto rounded-3xl border">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  {podeOperar && <TableHead />}
                  <TableHead>{t("Empresa")}</TableHead>
                  <TableHead>{t("Categoria")}</TableHead>
                  <TableHead>{t("Cidade")}</TableHead>
                  <TableHead>{t("Telefone")}</TableHead>
                  <TableHead className="text-right">{t("Avaliação")}</TableHead>
                  <TableHead className="text-right">{t("Score")}</TableHead>
                  <TableHead>{t("Status CRM")}</TableHead>
                  <TableHead>{t("Ações")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lista.slice(0, visiveis).map((p) => {
                  const zap = zapHref(p);
                  return (
                    <TableRow key={p.id} className="align-top">
                      {podeOperar && (
                        <TableCell>
                          <input
                            type="checkbox"
                            checked={selecionados.includes(p.id)}
                            onChange={() => alternar(p.id)}
                            aria-label={p.nome}
                          />
                        </TableCell>
                      )}
                      <TableCell>
                        <p className="font-medium">{p.nome}</p>
                        {p.website && (
                          <a
                            href={p.website.startsWith("http") ? p.website : `https://${p.website}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-muted-foreground underline"
                          >
                            {p.website.replace(/^https?:\/\/(www\.)?/, "").slice(0, 30)}
                          </a>
                        )}
                        {p.ja_e_cliente && (
                          <p className="text-xs font-medium text-green-600">{t("Cliente já cadastrado")}</p>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{p.categoria ?? "—"}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {[p.cidade, p.estado].filter(Boolean).join("/")}
                      </TableCell>
                      <TableCell className="tabular-nums">{p.telefone ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {p.nota !== null ? `★ ${p.nota} (${p.total_avaliacoes})` : "—"}
                      </TableCell>
                      <TableCell className="text-right font-bold tabular-nums">{p.score}</TableCell>
                      <TableCell>
                        {podeOperar ? (
                          <select
                            className="h-8 rounded-lg border bg-background px-2 text-xs"
                            value={p.status_comercial}
                            onChange={(e) => void mudarStatus(p.id, e.target.value)}
                            aria-label={t("Status comercial")}
                          >
                            {STATUS_COMERCIAL.map((s) => (
                              <option key={s} value={s}>
                                {ROTULO_STATUS_COMERCIAL[s]}
                              </option>
                            ))}
                          </select>
                        ) : (
                          ROTULO_STATUS_COMERCIAL[p.status_comercial]
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          <Button size="sm" variant="outline" onClick={() => setDetalheId(p.id)}>
                            {t("Ver")}
                          </Button>
                          {zap && (
                            <Button size="sm" variant="outline" asChild>
                              <a href={zap} target="_blank" rel="noopener noreferrer">
                                {t("WhatsApp")}
                              </a>
                            </Button>
                          )}
                          {podeOperar && (
                            <>
                              <Button size="sm" variant="outline" onClick={() => void importar([p.id])}>
                                {t("CRM")}
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => void excluir(p.id, p.nome)}>
                                {t("Excluir")}
                              </Button>
                            </>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("WhatsApp abre conversa manual — nunca campanha automática sem consentimento.")}
          </p>
          {lista.length > visiveis && (
            <Button size="sm" variant="outline" onClick={() => setVisiveis((v) => v + 200)} className="w-full">
              {t("Mostrar mais")} ({lista.length - visiveis} {t("restantes")})
            </Button>
          )}
        </>
      )}
      {detalhe && (
        <div className="fixed inset-y-0 right-0 z-50 w-full max-w-md overflow-y-auto border-l bg-background p-4 shadow-xl" role="dialog" aria-label={detalhe.nome}>
          <div className="mb-3 flex items-start justify-between gap-2">
            <div>
              <p className="font-medium text-text">{detalhe.nome}</p>
              <p className="text-xs text-muted-foreground">
                {[detalhe.categoria, [detalhe.cidade, detalhe.estado].filter(Boolean).join("/")].filter(Boolean).join(" · ")}
              </p>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setDetalheId(null)} aria-label={t("Fechar")}>
              ×
            </Button>
          </div>
          <div className="space-y-2 text-sm">
            {detalhe.nota !== null && <p>★ {detalhe.nota} · {detalhe.total_avaliacoes} {t("avaliações")}</p>}
            {detalhe.endereco && <p className="text-muted-foreground">{detalhe.endereco}</p>}
            {detalhe.telefone && <p className="tabular-nums">{detalhe.telefone}</p>}
            {detalhe.website && (
              <a
                href={detalhe.website.startsWith("http") ? detalhe.website : `https://${detalhe.website}`}
                target="_blank"
                rel="noopener noreferrer"
                className="block underline underline-offset-4"
              >
                {detalhe.website.replace(/^https?:\/\/(www\.)?/, "").slice(0, 40)}
              </a>
            )}
            <p className="text-muted-foreground">
              {t("Origem")}: {detalhe.provider} · {t("Score")} {detalhe.score}
              {detalhe.latitude !== null && ` · ${detalhe.latitude.toFixed(4)}, ${detalhe.longitude?.toFixed(4)}`}
            </p>
            <p className="text-muted-foreground">
              {t("Status")}: {ROTULO_STATUS_COMERCIAL[detalhe.status_comercial]}
              {detalhe.ja_e_cliente ? ` · ${t("Cliente já cadastrado")}` : ""}
            </p>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {(() => {
              const zap = zapHref(detalhe);
              return zap ? (
                <Button size="sm" variant="outline" asChild>
                  <a href={zap} target="_blank" rel="noopener noreferrer">
                    {t("WhatsApp")}
                  </a>
                </Button>
              ) : null;
            })()}
            {podeOperar && (
              <>
                <Button size="sm" onClick={() => void importar([detalhe.id])}>
                  {t("Adicionar ao CRM")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setSelecionados((s) => (s.includes(detalhe.id) ? s : [...s, detalhe.id]));
                    criarRota([...selecionados.filter((id) => id !== detalhe.id), detalhe.id]);
                  }}
                >
                  {t("Criar rota")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void excluir(detalhe.id, detalhe.nome)}>
                  {t("Excluir")}
                </Button>
              </>
            )}
            {detalhe.latitude !== null && (
              <Button size="sm" variant="outline" asChild>
                <a href={navegarHref(detalhe)} target="_blank" rel="noopener noreferrer">
                  {t("Ir até")}
                </a>
              </Button>
            )}
          </div>
        </div>
      )}
      {podeOperar && (
        <ImportarArquivoDialog
          aberto={importandoArquivo}
          onFechar={() => setImportandoArquivo(false)}
          onImportado={() => void buscar(filtros)}
        />
      )}
    </div>
  );
}
