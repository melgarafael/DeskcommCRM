"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";

interface Caso {
  id: string; router_id: string; conversation_id: string | null; modo: string;
  context_message_count: number; origem: string; motivo_reserva: string | null;
  intent_jev: string | null; intent_tradicional: string | null; intent_final: string | null;
  agent_id_final: string | null; agent_id_esperado: string | null;
  modelo_jev: string | null; destino_jev: string | null; destino_tradicional: string | null;
  concordou_destino: boolean | null; revisao: string | null;
  custo_jev_cents: number | null; custo_tradicional_cents: number | null;
  custo_incompleto: boolean; tempo_total_ms: number; created_at: string;
}

interface Resultado {
  casos: Caso[];
  roteadores: Array<{ id: string; name: string }>;
  membros: Array<{ router_id: string; agent_id: string; intent_name: string }>;
  pode_revisar: boolean;
  resumo: {
    total: number; limite_amostra: number; periodo_dias: number; sem_reserva: number; reservas: number;
    motivos_reserva: Record<string, number>; custo_total_cents: number; custos_incompletos: number;
    mediana_ms: number | null; p95_ms: number | null; comparacoes_destino: number;
    concordancias_destino: number; comparacoes_intencao: number; concordancias_intencao: number;
    revisados: number; corretos_revisados: number;
  };
}

const dinheiro = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "USD", maximumFractionDigits: 6 });
function nomeDoModo(modo: string, t: (texto: string) => string): string {
  if (modo === "tradicional_comparacao") return t("IA tradicional decide; JEV observa");
  if (modo === "jev_comparacao") return t("JEV decide; comparação ativa");
  if (modo === "jev_sob_demanda") return t("JEV; reserva sob demanda");
  return modo;
}

function motivoDaReserva(motivo: string, t: (texto: string) => string): string {
  if (motivo === "falha_jev") return t("JEV não respondeu");
  if (motivo === "baixa_confianca") return t("Confiança abaixo do mínimo");
  if (motivo === "sem_intencao") return t("Nenhuma intenção identificada");
  if (motivo === "intencao_invalida") return t("Intenção fora do roteador");
  return motivo;
}

export function RoteamentoResultados() {
  const t = useT();
  const idioma = useTagDeIdioma();
  const [dias, setDias] = useState("30");
  const [modo, setModo] = useState("");
  const [routerId, setRouterId] = useState("");
  const [modelo, setModelo] = useState("");
  const [contexto, setContexto] = useState("");
  const [dados, setDados] = useState<Resultado | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    const q = new URLSearchParams({ dias });
    if (modo) q.set("modo", modo);
    if (routerId) q.set("router_id", routerId);
    if (modelo) q.set("modelo", modelo);
    if (contexto !== "") q.set("contexto", contexto);
    try {
      const r = await fetch(`/api/v1/ai/routing-results?${q}`);
      const j = await r.json() as { data?: Resultado; error?: { message?: string } };
      if (!r.ok || !j.data) throw new Error(j.error?.message ?? t("Não foi possível carregar o roteamento."));
      setDados(j.data); setErro(null);
    } catch (e) { setErro(e instanceof Error ? e.message : t("Não foi possível carregar o roteamento.")); }
  }, [dias, modo, routerId, modelo, contexto, t]);

  useEffect(() => {
    const id = window.setTimeout(() => void carregar(), 0);
    return () => window.clearTimeout(id);
  }, [carregar]);

  async function revisar(caso: Caso, revisao: "correto" | "incorreto" | null, esperado: string | null) {
    setSalvando(caso.id);
    try {
      const r = await fetch(`/api/v1/ai/routing-results/${caso.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ revisao, agent_id_esperado: esperado }),
      });
      const j = await r.json() as { error?: { message?: string } };
      if (!r.ok) throw new Error(j.error?.message ?? t("Não foi possível salvar a revisão."));
      await carregar();
    } catch (e) { toast.error(e instanceof Error ? e.message : t("Não foi possível salvar a revisão.")); }
    finally { setSalvando(null); }
  }

  const r = dados?.resumo;
  const modelos = [...new Set(dados?.casos.map((c) => c.modelo_jev).filter((v): v is string => !!v) ?? [])];
  const routers = dados?.roteadores ?? [];
  const porcentagem = (a: number, b: number) => b ? `${Math.round(100 * a / b)}% (${a}/${b})` : t("Sem pares");
  return (
    <div className="mx-auto w-full max-w-5xl space-y-5 p-6" data-testid="resultados-roteamento">
      <header>
        <div className="mb-2 flex gap-3 text-sm"><Link href="/app/ai/runs" className="underline">{t("Execuções")}</Link><span aria-current="page" className="font-medium">{t("Roteamento")}</span></div>
        <h1 className="text-2xl font-semibold">{t("Resultados do roteamento")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("Compare os modos e revise decisões reais. Concordância entre IAs não é prova de acerto.")}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t("A janela indica o histórico disponível. O JEV só recebe o que foi autorizado em Provedores.")}</p>
      </header>
      <Card className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5">
        <label className="text-xs">{t("Período")}
          <select className="mt-1 block w-full rounded-md border bg-background p-2" value={dias} onChange={(e) => setDias(e.target.value)}>
            {[7,30,90].map((n) => <option key={n} value={n}>{n} {t("dias")}</option>)}
          </select>
        </label>
        <label className="text-xs">{t("Modo")}
          <select className="mt-1 block w-full rounded-md border bg-background p-2" value={modo} onChange={(e) => setModo(e.target.value)}>
            <option value="">{t("Todos")}</option>{["tradicional_comparacao", "jev_comparacao", "jev_sob_demanda"].map((v) => <option key={v} value={v}>{nomeDoModo(v, t)}</option>)}
          </select>
        </label>
        <label className="text-xs">{t("Roteador")}
          <select className="mt-1 block w-full rounded-md border bg-background p-2" value={routerId} onChange={(e) => setRouterId(e.target.value)}>
            <option value="">{t("Todos")}</option>{routers.map((router) => <option key={router.id} value={router.id}>{router.name}</option>)}
          </select>
        </label>
        <label className="text-xs">{t("Modelo JEV")}
          <select className="mt-1 block w-full rounded-md border bg-background p-2" value={modelo} onChange={(e) => setModelo(e.target.value)}>
            <option value="">{t("Todos")}</option>{modelos.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <div><Label htmlFor="filtro-contexto" className="text-xs">{t("Mensagens anteriores")}</Label>
          <Input id="filtro-contexto" type="number" min={0} max={16} value={contexto} onChange={(e) => setContexto(e.target.value)} placeholder={t("Todas")} className="mt-1" />
        </div>
      </Card>
      {erro && <Card className="p-4 text-sm text-destructive">{erro} <Button size="sm" variant="outline" onClick={() => void carregar()}>{t("Tentar de novo")}</Button></Card>}
      {!dados && !erro && <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>}
      {r && <>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card className="p-4"><p className="text-xs text-muted-foreground">{t("Decisões examinadas")}</p><p className="text-xl font-semibold">{r.total}</p><p className="text-xs text-muted-foreground">{t("Até 500 casos recentes pelos filtros.")}</p></Card>
          <Card className="p-4"><p className="text-xs text-muted-foreground">{t("JEV sem reserva")}</p><p className="text-xl font-semibold">{r.sem_reserva}</p><p className="text-xs text-muted-foreground">{t("Reserva acionada")}: {r.reservas}</p></Card>
          <Card className="p-4"><p className="text-xs text-muted-foreground">{t("Custo conhecido")}</p><p className="text-xl font-semibold">{dinheiro.format(r.custo_total_cents / 100)}</p><p className="text-xs text-muted-foreground">{r.custos_incompletos ? `${r.custos_incompletos} ${t("casos sem preço completo")}` : t("JEV e reserva incluídos")}</p></Card>
          <Card className="p-4"><p className="text-xs text-muted-foreground">{t("Tempo total do roteamento")}</p><p className="text-xl font-semibold">{r.mediana_ms ?? "—"} ms</p><p className="text-xs text-muted-foreground">p95: {r.p95_ms ?? "—"} ms</p></Card>
        </div>
        <Card className="space-y-1 p-4 text-sm">
          <p>{t("Concordância de destino")}: <strong>{porcentagem(r.concordancias_destino, r.comparacoes_destino)}</strong> · {t("de intenção")}: <strong>{porcentagem(r.concordancias_intencao, r.comparacoes_intencao)}</strong></p>
          <p>{t("Acerto revisado por pessoa")}: <strong>{porcentagem(r.corretos_revisados, r.revisados)}</strong></p>
          <p className="text-xs text-muted-foreground">{t("A concordância usa apenas os modos comparativos. Reservas sob demanda não formam amostra geral de comparação.")}</p>
          {r.reservas > 0 && <p className="text-xs text-muted-foreground">{t("Motivos da reserva")}: {Object.entries(r.motivos_reserva).filter(([,n]) => n > 0).map(([m,n]) => `${motivoDaReserva(m, t)}: ${n}`).join(" · ")}</p>}
        </Card>
      </>}
      {dados && (dados.casos.length ? <div className="space-y-2">
        {dados.casos.map((c) => <Card key={c.id} className="space-y-2 p-4 text-sm" data-testid={`roteamento-${c.id}`}>
          <div className="flex flex-wrap justify-between gap-2"><strong>{nomeDoModo(c.modo, t)}</strong><span className="text-xs text-muted-foreground">{new Date(c.created_at).toLocaleString(idioma)} · {c.tempo_total_ms} ms</span></div>
          <p>{t("Escolha final")}: {c.intent_final ?? t("Sem intenção")} · {t("Origem")}: {c.origem === "reserva" ? t("Reserva tradicional") : c.origem === "jev" ? "JEV" : t("IA tradicional")}{c.motivo_reserva ? ` · ${motivoDaReserva(c.motivo_reserva, t)}` : ""}</p>
          <p className="text-xs text-muted-foreground">{t("Janela de histórico")}: {c.context_message_count} · {t("Intenção JEV")}: {c.intent_jev ?? "—"} · {t("Intenção tradicional")}: {c.intent_tradicional ?? "—"}</p>
          <p className="text-xs text-muted-foreground">JEV: {c.custo_jev_cents === null ? "—" : dinheiro.format(c.custo_jev_cents / 100)} · {t("Tradicional")}: {c.custo_tradicional_cents === null ? "—" : dinheiro.format(c.custo_tradicional_cents / 100)}{c.custo_incompleto ? ` · ${t("custo incompleto")}` : ""}</p>
          <div className="flex flex-wrap items-center gap-2">
            {c.conversation_id && <Link className="text-xs underline" href={`/app/inbox?id=${c.conversation_id}`}>{t("Abrir conversa")}</Link>}
            {dados.pode_revisar && <><label className="text-xs" htmlFor={`revisao-${c.id}`}>{t("Revisão")}</label>
              <select id={`revisao-${c.id}`} className="rounded-md border bg-background p-1 text-xs" value={c.revisao ?? ""} disabled={salvando === c.id}
                onChange={(e) => void revisar(c, e.target.value ? e.target.value as "correto" | "incorreto" : null, null)}>
                <option value="">{t("Não revisado")}</option><option value="correto">{t("Correto")}</option><option value="incorreto">{t("Incorreto")}</option>
              </select>
              {c.revisao === "incorreto" && <select aria-label={t("Agente esperado")} className="rounded-md border bg-background p-1 text-xs" value={c.agent_id_esperado ?? ""} disabled={salvando === c.id}
                onChange={(e) => void revisar(c, "incorreto", e.target.value || null)}>
                <option value="">{t("Escolher agente esperado")}</option>
                {dados.membros.filter((m) => m.router_id === c.router_id).map((m) => <option key={`${m.agent_id}-${m.intent_name}`} value={m.agent_id}>{m.intent_name}</option>)}
              </select>}
            </>}
          </div>
        </Card>)}
      </div> : <Card className="p-6 text-sm text-muted-foreground">{t("Ainda não há decisões de roteamento nesses filtros.")}</Card>)}
    </div>
  );
}
