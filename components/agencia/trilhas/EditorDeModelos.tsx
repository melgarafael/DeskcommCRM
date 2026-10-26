"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { salvarModeloDeTrilha } from "@/app/actions/agencia/trilhas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ROTULO_DO_TIPO, TIPOS_DE_REUNIAO, type TipoDeReuniao } from "@/lib/agencia/calendario/vocabulario";
import { problemaNoModelo } from "@/lib/agencia/trilhas/regras";
import {
  REGRAS_DE_PRAZO,
  ROTULO_DA_ETAPA,
  ROTULO_DA_REGRA,
  ROTULO_DO_TIPO_DE_PASSO,
  TIPOS_DE_PASSO,
  type RegraDePrazo,
  type TipoDePasso,
} from "@/lib/agencia/trilhas/vocabulario";
import { cn } from "@/lib/utils";

/**
 * O editor dos modelos de trilha (docs/agencia/SPEC-trilhas.md, R1–R2). A
 * validação (chaves, dependências, círculo) roda aqui para responder na hora e
 * de novo no servidor, que é quem decide.
 */
export interface PassoNoEditor {
  chave: string;
  etapa: number;
  ordem: number;
  titulo: string;
  descricao: string | null;
  tipo: TipoDePasso;
  reuniaoTipo: TipoDeReuniao | null;
  funcaoId: string | null;
  dependeDe: string[];
  regra: RegraDePrazo;
  dias: number | null;
  ancora: string | null;
  checklist: string[];
  executor: "humano" | "ia";
}

export interface ModeloNoEditor {
  id: string | null;
  nome: string;
  tipo: "recorrente" | "avulsa";
  ativo: boolean;
  passos: PassoNoEditor[];
}

const NOVO: ModeloNoEditor = { id: null, nome: "", tipo: "avulsa", ativo: true, passos: [] };

function chaveDe(titulo: string, existentes: readonly string[]): string {
  const base =
    titulo
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 34) || "passo";
  let chave = base.length >= 2 ? base : `${base}_passo`;
  for (let i = 2; existentes.includes(chave); i++) chave = `${base}_${i}`;
  return chave;
}

export function EditorDeModelos({ modelos, funcoes }: { modelos: ModeloNoEditor[]; funcoes: Array<{ id: string; nome: string }> }) {
  const router = useRouter();
  const [escolhido, setEscolhido] = useState<number | "novo">(modelos.length ? 0 : "novo");
  const [rascunho, setRascunho] = useState<ModeloNoEditor>(() => structuredClone(modelos[0] ?? NOVO));
  const [aberto, setAberto] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null);
  const [pendente, startTransition] = useTransition();

  function escolher(i: number | "novo") {
    setEscolhido(i);
    setRascunho(structuredClone(i === "novo" ? NOVO : modelos[i]!));
    setAberto(null);
    setMsg(null);
  }

  function mudarPasso(chave: string, p: Partial<PassoNoEditor>) {
    setRascunho((r) => ({ ...r, passos: r.passos.map((x) => (x.chave === chave ? { ...x, ...p } : x)) }));
  }

  function adicionar() {
    const titulo = "Novo passo";
    const chave = chaveDe(titulo, rascunho.passos.map((x) => x.chave));
    const ultimo = rascunho.passos.at(-1);
    setRascunho((r) => ({
      ...r,
      passos: [
        ...r.passos,
        {
          chave,
          etapa: ultimo?.etapa ?? 1,
          ordem: (ultimo?.ordem ?? 0) + 1,
          titulo,
          descricao: null,
          tipo: "tarefa",
          reuniaoTipo: null,
          funcaoId: null,
          dependeDe: ultimo ? [ultimo.chave] : [],
          regra: "manual",
          dias: null,
          ancora: null,
          checklist: [],
          executor: "humano",
        },
      ],
    }));
    setAberto(chave);
  }

  function remover(chave: string) {
    const dependentes = rascunho.passos.filter((x) => x.dependeDe.includes(chave) || x.ancora === chave);
    if (dependentes.length) {
      setMsg({ ok: false, texto: `Antes, tire "${chave}" de: ${dependentes.map((d) => d.titulo).join(", ")}.` });
      return;
    }
    setRascunho((r) => ({ ...r, passos: r.passos.filter((x) => x.chave !== chave) }));
  }

  const problema = rascunho.passos.length
    ? problemaNoModelo(
        rascunho.passos.map((x) => ({
          chave: x.chave,
          titulo: x.titulo,
          tipo: x.tipo,
          reuniaoTipo: x.reuniaoTipo,
          dependeDe: x.dependeDe,
          regra: x.regra,
          ancora: x.ancora,
        })),
      )
    : null;

  function salvar() {
    setMsg(null);
    startTransition(async () => {
      const { id, ...resto } = rascunho;
      const r = await salvarModeloDeTrilha({ ...resto, ...(id ? { id } : {}) });
      if (!r.ok) {
        setMsg({ ok: false, texto: r.erro });
        return;
      }
      setMsg({ ok: true, texto: "Modelo salvo. Vale para as trilhas que começarem a partir de agora." });
      router.refresh();
    });
  }

  const etapas = [...new Set(rascunho.passos.map((x) => x.etapa))].sort((a, b) => a - b);

  return (
    <div className="grid gap-4 md:grid-cols-[14rem_1fr]">
      <nav className="flex gap-2 overflow-x-auto md:flex-col" aria-label="Modelos">
        {modelos.map((m, i) => (
          <button
            key={m.id}
            type="button"
            onClick={() => escolher(i)}
            className={cn("shrink-0 rounded-md border px-3 py-2 text-left text-sm", escolhido === i && "border-foreground font-medium")}
          >
            {m.nome}
            {!m.ativo && <span className="block text-xs text-muted-foreground">desativado</span>}
          </button>
        ))}
        <button
          type="button"
          onClick={() => escolher("novo")}
          className={cn("shrink-0 rounded-md border border-dashed px-3 py-2 text-left text-sm", escolhido === "novo" && "border-foreground")}
        >
          + Novo modelo
        </button>
      </nav>

      <div className="min-w-0 space-y-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_10rem_auto] sm:items-end">
          <div className="space-y-1">
            <Label htmlFor="modelo-nome">Nome</Label>
            <Input id="modelo-nome" value={rascunho.nome} onChange={(e) => setRascunho({ ...rascunho, nome: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="modelo-tipo">Para</Label>
            <select
              id="modelo-tipo"
              value={rascunho.tipo}
              onChange={(e) => setRascunho({ ...rascunho, tipo: e.target.value as "recorrente" | "avulsa" })}
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            >
              <option value="recorrente">Recorrente</option>
              <option value="avulsa">Avulsa</option>
            </select>
          </div>
          <label className="flex h-9 items-center gap-2 text-sm">
            <input type="checkbox" checked={rascunho.ativo} onChange={(e) => setRascunho({ ...rascunho, ativo: e.target.checked })} />
            Ativo
          </label>
        </div>

        {etapas.map((e) => (
          <div key={e} className="space-y-2">
            <h3 className="text-sm font-semibold">{ROTULO_DA_ETAPA[e] ?? `Etapa ${e}`}</h3>
            <ul className="divide-y rounded-md border">
              {rascunho.passos
                .filter((x) => x.etapa === e)
                .sort((a, b) => a.ordem - b.ordem)
                .map((x) => (
                  <li key={x.chave} className="space-y-3 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <button type="button" onClick={() => setAberto(aberto === x.chave ? null : x.chave)} className="min-w-0 text-left">
                        <span className="block text-sm font-medium">{x.titulo}</span>
                        <span className="block text-xs text-muted-foreground">
                          {[
                            ROTULO_DO_TIPO_DE_PASSO[x.tipo],
                            x.tipo === "tarefa" ? funcoes.find((f) => f.id === x.funcaoId)?.nome : null,
                            x.dependeDe.length ? `depois de ${x.dependeDe.map((d) => rascunho.passos.find((y) => y.chave === d)?.titulo ?? d).join(", ")}` : "começa liberado",
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => remover(x.chave)}>
                        Tirar
                      </Button>
                    </div>
                    {aberto === x.chave && (
                      <div className="grid gap-3 rounded-md bg-muted/40 p-3 sm:grid-cols-2">
                        <div className="space-y-1 sm:col-span-2">
                          <Label htmlFor={`p-titulo-${x.chave}`}>Título</Label>
                          <Input id={`p-titulo-${x.chave}`} value={x.titulo} onChange={(ev) => mudarPasso(x.chave, { titulo: ev.target.value })} />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor={`p-tipo-${x.chave}`}>Tipo</Label>
                          <select
                            id={`p-tipo-${x.chave}`}
                            value={x.tipo}
                            onChange={(ev) => mudarPasso(x.chave, { tipo: ev.target.value as TipoDePasso })}
                            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                          >
                            {TIPOS_DE_PASSO.map((t) => (
                              <option key={t} value={t}>
                                {ROTULO_DO_TIPO_DE_PASSO[t]}
                              </option>
                            ))}
                          </select>
                        </div>
                        {x.tipo === "reuniao" ? (
                          <div className="space-y-1">
                            <Label htmlFor={`p-reuniao-${x.chave}`}>Tipo de reunião</Label>
                            <select
                              id={`p-reuniao-${x.chave}`}
                              value={x.reuniaoTipo ?? ""}
                              onChange={(ev) => mudarPasso(x.chave, { reuniaoTipo: (ev.target.value || null) as TipoDeReuniao | null })}
                              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                            >
                              <option value="">Escolha</option>
                              {TIPOS_DE_REUNIAO.map((t) => (
                                <option key={t} value={t}>
                                  {ROTULO_DO_TIPO[t]}
                                </option>
                              ))}
                            </select>
                          </div>
                        ) : x.tipo === "tarefa" ? (
                          <div className="space-y-1">
                            <Label htmlFor={`p-funcao-${x.chave}`}>Função</Label>
                            <select
                              id={`p-funcao-${x.chave}`}
                              value={x.funcaoId ?? ""}
                              onChange={(ev) => mudarPasso(x.chave, { funcaoId: ev.target.value || null })}
                              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                            >
                              <option value="">Sem função (quem gerencia)</option>
                              {funcoes.map((f) => (
                                <option key={f.id} value={f.id}>
                                  {f.nome}
                                </option>
                              ))}
                            </select>
                          </div>
                        ) : (
                          <div />
                        )}
                        <div className="space-y-1">
                          <Label htmlFor={`p-etapa-${x.chave}`}>Etapa</Label>
                          <Input
                            id={`p-etapa-${x.chave}`}
                            type="number"
                            min={1}
                            max={9}
                            value={x.etapa}
                            onChange={(ev) => mudarPasso(x.chave, { etapa: Math.min(9, Math.max(1, Number(ev.target.value) || 1)) })}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor={`p-ordem-${x.chave}`}>Ordem na etapa</Label>
                          <Input
                            id={`p-ordem-${x.chave}`}
                            type="number"
                            min={0}
                            value={x.ordem}
                            onChange={(ev) => mudarPasso(x.chave, { ordem: Math.max(0, Number(ev.target.value) || 0) })}
                          />
                        </div>
                        <fieldset className="space-y-1 sm:col-span-2">
                          <legend className="text-sm font-medium">Depende de</legend>
                          <div className="flex flex-wrap gap-2">
                            {rascunho.passos
                              .filter((y) => y.chave !== x.chave)
                              .map((y) => (
                                <label key={y.chave} className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs">
                                  <input
                                    type="checkbox"
                                    checked={x.dependeDe.includes(y.chave)}
                                    onChange={(ev) =>
                                      mudarPasso(x.chave, {
                                        dependeDe: ev.target.checked ? [...x.dependeDe, y.chave] : x.dependeDe.filter((d) => d !== y.chave),
                                      })
                                    }
                                  />
                                  {y.titulo}
                                </label>
                              ))}
                          </div>
                        </fieldset>
                        <div className="space-y-1">
                          <Label htmlFor={`p-regra-${x.chave}`}>Prazo</Label>
                          <select
                            id={`p-regra-${x.chave}`}
                            value={x.regra}
                            onChange={(ev) => mudarPasso(x.chave, { regra: ev.target.value as RegraDePrazo })}
                            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                          >
                            {REGRAS_DE_PRAZO.map((r) => (
                              <option key={r} value={r}>
                                {ROTULO_DA_REGRA[r]}
                              </option>
                            ))}
                          </select>
                        </div>
                        {(x.regra === "apos_liberar" || x.regra === "apos_ancora") && (
                          <div className="grid grid-cols-2 gap-2">
                            <div className="space-y-1">
                              <Label htmlFor={`p-dias-${x.chave}`}>Dias</Label>
                              <Input
                                id={`p-dias-${x.chave}`}
                                type="number"
                                min={0}
                                value={x.dias ?? 0}
                                onChange={(ev) => mudarPasso(x.chave, { dias: Math.max(0, Number(ev.target.value) || 0) })}
                              />
                            </div>
                            {x.regra === "apos_ancora" && (
                              <div className="space-y-1">
                                <Label htmlFor={`p-ancora-${x.chave}`}>Depois de</Label>
                                <select
                                  id={`p-ancora-${x.chave}`}
                                  value={x.ancora ?? ""}
                                  onChange={(ev) => mudarPasso(x.chave, { ancora: ev.target.value || null })}
                                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                                >
                                  <option value="">Escolha</option>
                                  {rascunho.passos
                                    .filter((y) => y.chave !== x.chave)
                                    .map((y) => (
                                      <option key={y.chave} value={y.chave}>
                                        {y.titulo}
                                      </option>
                                    ))}
                                </select>
                              </div>
                            )}
                          </div>
                        )}
                        {x.tipo === "tarefa" && (
                          <div className="space-y-1 sm:col-span-2">
                            <Label htmlFor={`p-checklist-${x.chave}`}>Checklist da tarefa (um item por linha)</Label>
                            <textarea
                              id={`p-checklist-${x.chave}`}
                              rows={3}
                              value={x.checklist.join("\n")}
                              onChange={(ev) =>
                                mudarPasso(x.chave, {
                                  checklist: ev.target.value
                                    .split("\n")
                                    .map((l) => l.trim())
                                    .filter(Boolean),
                                })
                              }
                              className="w-full rounded-md border bg-background p-2 text-sm"
                            />
                          </div>
                        )}
                        <div className="space-y-1 sm:col-span-2">
                          <Label htmlFor={`p-descricao-${x.chave}`}>Descrição</Label>
                          <Input
                            id={`p-descricao-${x.chave}`}
                            value={x.descricao ?? ""}
                            onChange={(ev) => mudarPasso(x.chave, { descricao: ev.target.value || null })}
                          />
                        </div>
                      </div>
                    )}
                  </li>
                ))}
            </ul>
          </div>
        ))}

        <Button type="button" variant="outline" onClick={adicionar}>
          Adicionar passo
        </Button>

        {problema && (
          <p role="alert" className="text-sm text-destructive">
            {problema}
          </p>
        )}
        {msg && (
          <p role="status" className={msg.ok ? "text-sm text-muted-foreground" : "text-sm text-destructive"}>
            {msg.texto}
          </p>
        )}
        <div className="flex justify-end">
          <Button type="button" onClick={salvar} disabled={pendente || !!problema || rascunho.nome.trim().length < 2}>
            {pendente ? "Salvando…" : "Salvar modelo"}
          </Button>
        </div>
      </div>
    </div>
  );
}
