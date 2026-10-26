"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  cancelarTrilha,
  concluirPassoDaTrilha,
  iniciarTrilhaDoCliente,
  pularPassoDaTrilha,
  recriarTarefaDoPasso,
} from "@/app/actions/agencia/trilhas";
import { ModalDaReuniao, type NovaReuniao } from "@/components/agencia/calendario/ModalDaReuniao";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ApoioDaAgenda } from "@/lib/agencia/calendario/apoio";
import { diaDe, horaLocal } from "@/lib/agencia/calendario/regras";
import type { TipoDeReuniao } from "@/lib/agencia/calendario/vocabulario";
import { diaLocal, formatarDataHora } from "@/lib/agencia/tarefas/regras";
import { ROTULO_DA_COLUNA } from "@/lib/agencia/tarefas/vocabulario";
import type { PassoDaTela, TrilhaDaTela } from "@/lib/agencia/trilhas/consultas";
import { CHAVE_ASSINOU_PAGOU, ROTULO_DA_ETAPA, ROTULO_DA_SITUACAO_DO_PASSO } from "@/lib/agencia/trilhas/vocabulario";
import { Check, Lock } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

/**
 * A aba Trilha da ficha do cliente (docs/agencia/SPEC-trilhas.md › Telas).
 * O servidor decide o que pode; a tela só mostra os botões de quem pode.
 */
export interface ModeloParaIniciar {
  id: string;
  nome: string;
  passos: Array<{ chave: string; titulo: string }>;
}

function dataCurta(dia: string): string {
  const [a, m, d] = dia.split("-");
  return `${d}/${m}/${a}`;
}

function mesPorExtenso(dia: string): string {
  return new Date(`${dia.slice(0, 7)}-15T12:00:00Z`).toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
}

export function TrilhaDoCliente(p: {
  clienteId: string;
  trilha: TrilhaDaTela | null;
  modelos: ModeloParaIniciar[];
  contratacoes: Array<{ id: string; rotulo: string }>;
  podeGerenciar: boolean;
  podeMarcarReuniao: boolean;
  apoio: ApoioDaAgenda;
  meuMembroId: string | null;
  agendaLiberada: boolean;
}) {
  const router = useRouter();
  const [pendente, startTransition] = useTransition();
  const [erro, setErro] = useState<string | null>(null);
  const [modeloId, setModeloId] = useState(p.modelos[0]?.id ?? "");
  const [contratacaoId, setContratacaoId] = useState(p.contratacoes[0]?.id ?? "");
  const [aPartirDe, setAPartirDe] = useState("");
  const [hoje] = useState(() => diaLocal(new Date()));
  const [datas, setDatas] = useState<Record<string, string>>({});
  const [reuniao, setReuniao] = useState<NovaReuniao | null>(null);

  function agir(acao: () => Promise<{ ok: boolean; erro?: string }>) {
    setErro(null);
    startTransition(async () => {
      const r = await acao();
      if (!r.ok) setErro(r.erro ?? "Algo deu errado.");
      router.refresh();
    });
  }

  if (!p.trilha || p.trilha.situacao === "cancelada") {
    const modelo = p.modelos.find((m) => m.id === modeloId);
    return (
      <section className="space-y-4 rounded-md border p-4" data-testid="trilha-vazia">
        <div className="space-y-1">
          <h2 className="font-semibold">Este cliente ainda não tem trilha</h2>
          <p className="text-sm text-muted-foreground">
            A trilha monta as Etapas 1 e 2 sozinha: cada passo vira tarefa ou reunião quando chega a vez, com prazo e responsável.
          </p>
        </div>
        {!p.podeGerenciar ? (
          <p className="text-sm text-muted-foreground">Quem gerencia os clientes inicia a trilha.</p>
        ) : p.modelos.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum modelo de trilha ativo. Crie um em Trilhas › Modelos.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="trilha-modelo">Modelo</Label>
              <select
                id="trilha-modelo"
                value={modeloId}
                onChange={(e) => {
                  setModeloId(e.target.value);
                  setAPartirDe("");
                }}
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              >
                {p.modelos.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.nome}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="trilha-contratacao">Contratação</Label>
              <select
                id="trilha-contratacao"
                value={contratacaoId}
                onChange={(e) => setContratacaoId(e.target.value)}
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              >
                <option value="">Nenhuma</option>
                {p.contratacoes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.rotulo}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="trilha-inicio">Começar em</Label>
              <select
                id="trilha-inicio"
                value={aPartirDe}
                onChange={(e) => setAPartirDe(e.target.value)}
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              >
                <option value="">Do começo</option>
                {(modelo?.passos ?? []).map((x) => (
                  <option key={x.chave} value={x.chave}>
                    {x.titulo}
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-3">
              <Button
                type="button"
                disabled={pendente || !modeloId}
                onClick={() =>
                  agir(() =>
                    iniciarTrilhaDoCliente({
                      clienteId: p.clienteId,
                      modeloId,
                      contratacaoId: contratacaoId || null,
                      aPartirDe: aPartirDe || null,
                    }),
                  )
                }
              >
                {pendente ? "Iniciando…" : "Iniciar trilha"}
              </Button>
              <p className="pt-2 text-xs text-muted-foreground">
                Avulso que vira recorrente entra direto no Fechamento: escolha &quot;Reunião de Fechamento&quot; em &quot;Começar em&quot;.
              </p>
            </div>
          </div>
        )}
        {erro && (
          <p role="alert" className="text-sm text-destructive">
            {erro}
          </p>
        )}
      </section>
    );
  }

  const t = p.trilha;
  const etapas = [...new Set(t.passos.map((x) => x.etapa))].sort((a, b) => a - b);
  const tituloDe = new Map(t.passos.map((x) => [x.chave, x.titulo]));

  const linha = (x: PassoDaTela) => {
    const feito = x.situacao === "concluido" || x.situacao === "pulado";
    const aberto = x.situacao === "liberado" || x.situacao === "em_andamento";
    const pendentes = x.dependeDe.filter((d) => {
      const dep = t.passos.find((y) => y.chave === d);
      return dep && dep.situacao !== "concluido" && dep.situacao !== "pulado";
    });
    return (
      <li key={x.id} className={cn("space-y-2 p-3", x.situacao === "bloqueado" && "opacity-70")} data-testid="passo-da-trilha" data-situacao={x.situacao}>
        <div className="flex items-start gap-3">
          <span
            className={cn(
              "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs",
              x.situacao === "concluido" && "border-primary bg-primary text-primary-foreground",
              x.situacao === "pulado" && "border-dashed text-muted-foreground",
              x.situacao === "em_andamento" && "border-primary text-primary",
            )}
            aria-label={ROTULO_DA_SITUACAO_DO_PASSO[x.situacao]}
          >
            {x.situacao === "bloqueado" ? <Lock size={13} aria-hidden /> : x.situacao === "concluido" ? <Check size={13} aria-hidden /> : null}
          </span>
          <div className="min-w-0 flex-1">
            <p className={cn("text-sm font-medium", x.situacao === "pulado" && "text-muted-foreground line-through")}>{x.titulo}</p>
            <p className="text-xs text-muted-foreground">
              {[
                ROTULO_DA_SITUACAO_DO_PASSO[x.situacao],
                x.tipo === "reuniao" ? "Reunião" : x.tipo === "marco" ? "Marco" : null,
                x.tarefa?.responsaveis.length ? x.tarefa.responsaveis.join(", ") : x.funcaoNome,
                x.tarefa ? ROTULO_DA_COLUNA[x.tarefa.coluna] : null,
                x.reuniao ? `${x.reuniao.situacao === "realizada" ? "Realizada" : "Marcada"} ${formatarDataHora(x.reuniao.inicio)}` : null,
                feito && x.concluidoEm && !x.reuniao ? `em ${formatarDataHora(x.concluidoEm)}` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              {x.prazo && aberto && !x.reuniao && (
                <span className={cn(x.atrasado && "font-medium text-destructive")}>
                  {" · "}
                  {x.tipo === "reuniao" ? "sugerida para " : x.atrasado ? "atrasado desde " : "prazo "}
                  {formatarDataHora(x.prazo)}
                </span>
              )}
            </p>
            {x.situacao === "bloqueado" && pendentes.length > 0 && (
              <p className="text-xs text-muted-foreground">Espera: {pendentes.map((d) => tituloDe.get(d) ?? d).join(", ")}</p>
            )}
          </div>
        </div>

        {(aberto || x.tarefa || x.reuniao) && (
          <div className="flex flex-wrap items-center gap-2 pl-9">
            {x.tarefa && (
              <Link href={`/agencia/tarefas?abrir=${x.tarefa.id}`} className="rounded-md border px-2 py-1 text-xs">
                Abrir tarefa
              </Link>
            )}
            {x.reuniao && (
              <Link href={`/agencia/calendario?abrir=${x.reuniao.id}`} className="rounded-md border px-2 py-1 text-xs">
                Ver reunião
              </Link>
            )}
            {aberto && x.tipo === "tarefa" && !x.tarefa && p.podeGerenciar && (
              <Button type="button" size="sm" variant="outline" disabled={pendente} onClick={() => agir(() => recriarTarefaDoPasso(x.id))}>
                Criar a tarefa de novo
              </Button>
            )}
            {aberto && x.tipo === "reuniao" && !x.reuniao && p.podeMarcarReuniao && (
              <Button
                type="button"
                size="sm"
                disabled={pendente}
                onClick={() =>
                  setReuniao({
                    dia: x.prazo && diaDe(x.prazo) >= hoje ? diaDe(x.prazo) : hoje,
                    hora: x.prazo && diaDe(x.prazo) >= hoje ? horaLocal(x.prazo) : "10:00",
                    clienteId: p.clienteId,
                    tipo: (x.reuniaoTipo ?? "outra") as TipoDeReuniao,
                    trilhaPassoId: x.id,
                  })
                }
              >
                Marcar reunião
              </Button>
            )}
            {aberto && x.tipo !== "tarefa" && p.podeGerenciar && (
              <>
                <Input
                  type="date"
                  aria-label={`Quando: ${x.titulo}`}
                  value={datas[x.id] ?? hoje}
                  max={hoje}
                  onChange={(e) => setDatas({ ...datas, [x.id]: e.target.value })}
                  className="h-8 w-40"
                />
                <Button
                  type="button"
                  size="sm"
                  variant={x.tipo === "marco" ? "default" : "outline"}
                  disabled={pendente}
                  onClick={() => agir(() => concluirPassoDaTrilha(x.id, datas[x.id] ?? hoje))}
                >
                  {x.chave === CHAVE_ASSINOU_PAGOU ? "Assinado e pago" : x.tipo === "marco" ? "Concluir" : "Aconteceu (fora do calendário)"}
                </Button>
              </>
            )}
            {!feito && p.podeGerenciar && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={pendente}
                onClick={() => {
                  if (window.confirm(`Pular "${x.titulo}"? Os passos que dependem dele são liberados.`)) agir(() => pularPassoDaTrilha(x.id));
                }}
              >
                Pular
              </Button>
            )}
          </div>
        )}
      </li>
    );
  };

  return (
    <section className="space-y-4" data-testid="trilha-do-cliente">
      <div className="space-y-2 rounded-md border p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-semibold">
            {t.modeloNome}
            {t.situacao === "concluida" && <span className="ml-2 text-sm font-normal text-muted-foreground">· concluída</span>}
          </h2>
          <span className="text-sm text-muted-foreground" data-testid="progresso-da-trilha">
            {t.progresso.feitos} de {t.progresso.total} passos · {t.progresso.pct}%
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={t.progresso.pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-primary transition-all" style={{ width: `${t.progresso.pct}%` }} />
        </div>
        {t.assinouPagouEm && t.contratoInicio && t.preparacaoFim && (
          <p className="text-sm" data-testid="datas-do-contrato">
            Assinado e pago em {dataCurta(t.assinouPagouEm)} · contrato a partir de {dataCurta(t.contratoInicio)}
            {t.contratoFim ? ` até ${dataCurta(t.contratoFim)} (mínimo de 3 meses)` : ""} · preparação até {dataCurta(t.preparacaoFim)} · primeira
            postagem em {mesPorExtenso(diaDe(new Date(new Date(`${t.preparacaoFim}T12:00:00Z`).getTime() + 86_400_000).toISOString()))}
          </p>
        )}
      </div>

      {erro && (
        <p role="alert" className="text-sm text-destructive">
          {erro}
        </p>
      )}

      {etapas.map((e) => (
        <div key={e} className="space-y-2">
          <h3 className={cn("text-sm font-semibold", t.etapaAtual === e && "text-primary")}>
            {ROTULO_DA_ETAPA[e] ?? `Etapa ${e}`}
            {t.etapaAtual === e && " · agora"}
          </h3>
          <ul className="divide-y rounded-md border">{t.passos.filter((x) => x.etapa === e).map(linha)}</ul>
        </div>
      ))}

      {p.podeGerenciar && t.situacao === "ativa" && (
        <Button
          type="button"
          variant="ghost"
          className="text-destructive"
          disabled={pendente}
          onClick={() => {
            if (window.confirm("Cancelar a trilha deste cliente? As tarefas já criadas continuam no quadro.")) agir(() => cancelarTrilha(t.id));
          }}
        >
          Cancelar trilha
        </Button>
      )}

      {reuniao && (
        <ModalDaReuniao
          key={reuniao.trilhaPassoId ?? "nova"}
          aberto
          reuniao={null}
          nova={reuniao}
          apoio={p.apoio}
          meuMembroId={p.meuMembroId}
          podeGerenciar={p.podeMarcarReuniao}
          agendaLiberada={p.agendaLiberada}
          aoFechar={(mudou) => {
            setReuniao(null);
            if (mudou) router.refresh();
          }}
        />
      )}
    </section>
  );
}
