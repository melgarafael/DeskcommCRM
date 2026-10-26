"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";

import { ligarOrganizacao, salvarContratacao, salvarEquipeDoCliente } from "@/app/actions/agencia/clientes";
import { ReunioesDoCliente } from "@/components/agencia/calendario/ReunioesDoCliente";
import { AcessosDoCliente, type FormularioDaFicha } from "@/components/agencia/cofre/AcessosDoCliente";
import { AprovacoesDoCliente, type AprovacaoDaFicha } from "@/components/agencia/aprovacoes/AprovacoesDoCliente";
import { ContratosDoCliente, type ContratoDaFicha } from "@/components/agencia/contratos/ContratosDoCliente";
import { TrilhaDoCliente, type ModeloParaIniciar } from "@/components/agencia/trilhas/TrilhaDoCliente";
import { EnvioParaODrive } from "@/components/agencia/EnvioParaODrive";
import { QuadroDeTarefas } from "@/components/agencia/tarefas/QuadroDeTarefas";
import type { ApoioDoQuadro } from "@/components/agencia/tarefas/ModalDaTarefa";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ApoioDaAgenda } from "@/lib/agencia/calendario/apoio";
import type { ReuniaoDaAgenda } from "@/lib/agencia/calendario/consultas";
import {
  QUANTIDADES,
  ROTULO_DA_QUANTIDADE,
  ROTULO_DO_SERVICO,
  SERVICOS,
  type Quantidades,
} from "@/lib/agencia/clientes/vocabulario";
import type { TarefaDoQuadro } from "@/lib/agencia/tarefas/consultas";
import type { TrilhaDaTela } from "@/lib/agencia/trilhas/consultas";
import type { ItemDoCofre } from "@/lib/agencia/cofre/vocabulario";
import { cn } from "@/lib/utils";

import { FormularioDoCliente, type DadosDoCliente } from "./FormularioDoCliente";

const ABAS_DA_FICHA = ["dados", "contratacoes", "contratos", "equipe", "trilha", "tarefas", "aprovacoes", "reunioes", "acessos", "arquivos"] as const;
type Aba = (typeof ABAS_DA_FICHA)[number];

export interface ContratacaoDaFicha {
  id?: string;
  tipo: "recorrente" | "avulsa";
  servicos: string[];
  quantidades: Quantidades;
  inicio: string;
  fim: string;
  situacao: "proposta" | "ativa" | "pausada" | "encerrada";
  observacoes: string;
}

const NOVA_CONTRATACAO: ContratacaoDaFicha = {
  tipo: "recorrente",
  servicos: [],
  quantidades: {},
  inicio: "",
  fim: "",
  situacao: "ativa",
  observacoes: "",
};

export function FichaDoCliente(p: {
  id: string;
  podeGerenciar: boolean;
  dados: DadosDoCliente;
  organizacaoId: string | null;
  organizacoes: Array<{ id: string; nome: string }>;
  contratacoes: ContratacaoDaFicha[];
  equipe: string[];
  membros: Array<{ id: string; nome: string }>;
  arquivos: Array<{ id: string; nome: string; link: string; subpasta: string; criado_em: string }>;
  drive: { conectado: boolean; pastaUrl: string | null; subpastasProntas: number };
  tarefas: TarefaDoQuadro[];
  apoio: ApoioDoQuadro;
  meuMembroId: string | null;
  podeCriarTarefa: boolean;
  podeAtribuir: boolean;
  reunioes: ReuniaoDaAgenda[];
  apoioDaAgenda: ApoioDaAgenda;
  podeGerenciarCalendario: boolean;
  agendaLiberada: boolean;
  trilha: TrilhaDaTela | null;
  modelosDeTrilha: ModeloParaIniciar[];
  formulario: FormularioDaFicha | null;
  cofre: ItemDoCofre[];
  podeVerSenhas: boolean;
  /** `null` = a pessoa não tem `contratos.gerenciar` (a aba não aparece). */
  aprovacoes: AprovacaoDaFicha[];
  contratos: {
    lista: ContratoDaFicha[];
    modelos: Array<{ id: string; nome: string }>;
    hoje: string;
    integracoes: { zapsign: boolean; infinitepay: boolean };
  } | null;
}) {
  const router = useRouter();
  // `?aba=trilha` (o link dos avisos da trilha) abre direto na aba.
  const pedida = useSearchParams().get("aba");
  const [aba, setAba] = useState<Aba>(() => ABAS_DA_FICHA.find((a) => a === pedida) ?? "dados");
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null);
  const [equipe, setEquipe] = useState(p.equipe);
  const [org, setOrg] = useState(p.organizacaoId ?? "");
  const [editando, setEditando] = useState<ContratacaoDaFicha | null>(null);
  const [pendente, startTransition] = useTransition();

  const avisar = (r: { ok: boolean; erro?: string }, texto: string) => {
    setMsg(r.ok ? { ok: true, texto } : { ok: false, texto: r.erro ?? "Algo deu errado." });
    router.refresh();
  };

  const ABAS: Array<[Aba, string]> = [
    ["dados", "Dados"],
    ["contratacoes", "Contratações"],
    ...(p.contratos ? ([["contratos", `Contratos (${p.contratos.lista.length})`]] as Array<[Aba, string]>) : []),
    ["equipe", "Equipe"],
    ["trilha", p.trilha && p.trilha.situacao === "ativa" ? `Trilha (${p.trilha.progresso.pct}%)` : "Trilha"],
    ["tarefas", `Tarefas (${p.tarefas.filter((t) => t.coluna !== "concluido").length})`],
    ["aprovacoes", `Aprovações (${p.aprovacoes.filter((a) => a.situacao === "pendente").length})`],
    ["reunioes", `Reuniões (${p.reunioes.filter((r) => r.situacao === "marcada").length})`],
    ["acessos", "Acessos"],
    ["arquivos", "Arquivos"],
  ];

  return (
    <div className="space-y-4">
      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <div className="flex w-max gap-1 border-b" role="tablist">
          {ABAS.map(([a, rotulo]) => (
            <button
              key={a}
              role="tab"
              aria-selected={aba === a}
              onClick={() => setAba(a)}
              className={cn(
                "min-h-10 border-b-2 px-3 text-sm",
                aba === a ? "border-foreground font-medium" : "border-transparent text-muted-foreground",
              )}
            >
              {rotulo}
            </button>
          ))}
        </div>
      </div>

      {msg && (
        <p role="status" className={cn("rounded-md border px-3 py-2 text-sm", !msg.ok && "border-destructive text-destructive")}>
          {msg.texto}
        </p>
      )}

      {aba === "dados" && (
        <div className="space-y-6">
          <FormularioDoCliente inicial={p.dados} somenteLeitura={!p.podeGerenciar} aoSalvar={() => avisar({ ok: true }, "Cliente salvo.")} />
          {p.podeGerenciar && (
            <section className="space-y-2 rounded-md border p-4">
              <h2 className="font-semibold">Organização no CRM</h2>
              <p className="text-sm text-muted-foreground">
                A organização do cliente na central — onde fica o atendimento e, mais adiante, as aprovações.
              </p>
              <div className="flex flex-wrap gap-2">
                <select
                  aria-label="Organização"
                  value={org}
                  onChange={(e) => setOrg(e.target.value)}
                  className="h-10 min-w-56 rounded-md border bg-background px-3 text-sm"
                >
                  <option value="">Sem organização</option>
                  {p.organizacoes.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.nome}
                    </option>
                  ))}
                </select>
                <Button
                  variant="outline"
                  disabled={pendente || org === (p.organizacaoId ?? "")}
                  onClick={() => startTransition(async () => avisar(await ligarOrganizacao(p.id, org || null), "Organização ligada."))}
                >
                  Ligar
                </Button>
                <Link href="/admin/tenants" className="inline-flex min-h-10 items-center text-sm underline underline-offset-4">
                  Criar organização no CRM
                </Link>
              </div>
            </section>
          )}
        </div>
      )}

      {aba === "contratacoes" && (
        <div className="space-y-3">
          {p.podeGerenciar && (
            <div className="flex justify-end">
              <Button onClick={() => setEditando({ ...NOVA_CONTRATACAO })}>Nova contratação</Button>
            </div>
          )}
          {p.contratacoes.length === 0 && !editando && <p className="text-sm text-muted-foreground">Nenhuma contratação registrada.</p>}
          {editando && (
            <FormularioDeContratacao
              valor={editando}
              aoCancelar={() => setEditando(null)}
              aoSalvar={(c) =>
                startTransition(async () => {
                  const r = await salvarContratacao({
                    ...c,
                    clienteId: p.id,
                    servicos: c.servicos as Array<(typeof SERVICOS)[number]>,
                    inicio: c.inicio || null,
                    fim: c.fim || null,
                    observacoes: c.observacoes || null,
                  });
                  if (r.ok) setEditando(null);
                  avisar(r, "Contratação salva.");
                })
              }
            />
          )}
          <ul className="space-y-2">
            {p.contratacoes.map((c) => (
              <li key={c.id} className="space-y-1 rounded-md border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">
                    {c.tipo === "recorrente" ? "Pacote recorrente" : "Serviço avulso"} · {c.situacao}
                  </span>
                  {p.podeGerenciar && (
                    <Button size="sm" variant="outline" onClick={() => setEditando(c)}>
                      Editar
                    </Button>
                  )}
                </div>
                <p className="text-sm">{c.servicos.map((s) => ROTULO_DO_SERVICO[s as (typeof SERVICOS)[number]] ?? s).join(", ")}</p>
                <p className="text-xs text-muted-foreground">
                  {QUANTIDADES.filter((q) => c.quantidades[q])
                    .map((q) => `${c.quantidades[q]} ${ROTULO_DA_QUANTIDADE[q].toLowerCase()}`)
                    .join(" · ") || "Sem quantidades"}
                  {c.inicio && ` · de ${c.inicio}`}
                  {c.fim && ` até ${c.fim}`}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {aba === "equipe" && (
        <section className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Quem atende este cliente. Quem está com "só os clientes que atende" vê só os clientes desta lista.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {p.membros.map((m) => (
              <label key={m.id} className="flex min-h-10 items-center gap-2 rounded-md border px-3 text-sm">
                <input
                  type="checkbox"
                  disabled={!p.podeGerenciar}
                  checked={equipe.includes(m.id)}
                  onChange={() => setEquipe((e) => (e.includes(m.id) ? e.filter((x) => x !== m.id) : [...e, m.id]))}
                />
                {m.nome}
              </label>
            ))}
          </div>
          {p.podeGerenciar && (
            <div className="flex justify-end">
              <Button disabled={pendente} onClick={() => startTransition(async () => avisar(await salvarEquipeDoCliente(p.id, equipe), "Equipe salva."))}>
                Salvar equipe
              </Button>
            </div>
          )}
        </section>
      )}

      {aba === "tarefas" && (
        <QuadroDeTarefas
          tarefas={p.tarefas}
          apoio={p.apoio}
          meuMembroId={p.meuMembroId}
          podeCriar={p.podeCriarTarefa}
          podeAtribuir={p.podeAtribuir}
          clienteFixo={p.id}
        />
      )}

      {aba === "trilha" && (
        <TrilhaDoCliente
          clienteId={p.id}
          trilha={p.trilha}
          modelos={p.modelosDeTrilha}
          contratacoes={p.contratacoes
            .filter((c) => c.id && c.situacao !== "encerrada")
            .map((c) => ({
              id: c.id!,
              rotulo: `${c.tipo === "recorrente" ? "Recorrente" : "Avulsa"}${c.servicos.length ? ` — ${c.servicos.map((s) => ROTULO_DO_SERVICO[s as keyof typeof ROTULO_DO_SERVICO] ?? s).join(", ")}` : ""}`,
            }))}
          podeGerenciar={p.podeGerenciar}
          podeMarcarReuniao={p.podeGerenciarCalendario}
          apoio={p.apoioDaAgenda}
          meuMembroId={p.meuMembroId}
          agendaLiberada={p.agendaLiberada}
        />
      )}

      {aba === "reunioes" && (
        <ReunioesDoCliente
          clienteId={p.id}
          reunioes={p.reunioes}
          apoio={p.apoioDaAgenda}
          meuMembroId={p.meuMembroId}
          podeGerenciar={p.podeGerenciarCalendario}
          agendaLiberada={p.agendaLiberada}
        />
      )}

      {aba === "contratos" && p.contratos && (
        <ContratosDoCliente
          clienteId={p.id}
          contratos={p.contratos.lista}
          modelos={p.contratos.modelos}
          contratacoes={p.contratacoes
            .filter((c) => c.id && c.situacao !== "encerrada")
            .map((c) => ({
              id: c.id!,
              rotulo: `${c.tipo === "recorrente" ? "Recorrente" : "Avulsa"}${c.servicos.length ? ` — ${c.servicos.map((s) => ROTULO_DO_SERVICO[s as keyof typeof ROTULO_DO_SERVICO] ?? s).join(", ")}` : ""}`,
            }))}
          hoje={p.contratos.hoje}
          integracoes={p.contratos.integracoes}
        />
      )}

      {aba === "aprovacoes" && (
        <AprovacoesDoCliente
          clienteId={p.id}
          organizacaoLigada={!!p.organizacaoId}
          aprovacoes={p.aprovacoes}
          arquivos={p.arquivos.map((a) => ({ id: a.id, nome: a.nome }))}
          tarefas={p.tarefas.filter((t) => t.coluna !== "concluido").map((t) => ({ id: t.id, titulo: t.titulo }))}
          podePedir={p.podeCriarTarefa}
        />
      )}

      {aba === "acessos" && (
        <AcessosDoCliente clienteId={p.id} formulario={p.formulario} cofre={p.cofre} podeGerenciar={p.podeGerenciar} podeVerSenhas={p.podeVerSenhas} />
      )}

      {aba === "arquivos" && (
        <section className="space-y-3">
          {!p.drive.conectado ? (
            <p className="text-sm text-muted-foreground">O Google Drive não está conectado. Quem administra conecta em Configurações.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3 text-sm">
                {p.drive.pastaUrl && (
                  <a href={p.drive.pastaUrl} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                    Abrir a pasta no Google Drive
                  </a>
                )}
                <span className="text-muted-foreground">{p.drive.subpastasProntas}/8 subpastas</span>
              </div>
              <EnvioParaODrive clienteId={p.id} tarefaId={null} subpastaInicial="03 Planejamento" aoTerminar={() => router.refresh()} />
            </>
          )}
          <ul className="divide-y rounded-md border">
            {p.arquivos.length === 0 && <li className="p-4 text-sm text-muted-foreground">Nenhum arquivo enviado pela central.</li>}
            {p.arquivos.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                <a href={a.link} target="_blank" rel="noreferrer" className="truncate underline underline-offset-4">
                  {a.nome}
                </a>
                <span className="text-xs text-muted-foreground">{a.subpasta}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function FormularioDeContratacao({
  valor,
  aoSalvar,
  aoCancelar,
}: {
  valor: ContratacaoDaFicha;
  aoSalvar: (c: ContratacaoDaFicha) => void;
  aoCancelar: () => void;
}) {
  const [c, setC] = useState(valor);
  return (
    <form
      className="space-y-3 rounded-md border p-4"
      onSubmit={(e) => {
        e.preventDefault();
        aoSalvar(c);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="contratacao-tipo">Tipo</Label>
          <select
            id="contratacao-tipo"
            value={c.tipo}
            onChange={(e) => setC({ ...c, tipo: e.target.value as ContratacaoDaFicha["tipo"] })}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          >
            <option value="recorrente">Pacote recorrente</option>
            <option value="avulsa">Serviço avulso</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="contratacao-inicio">Início</Label>
          <Input id="contratacao-inicio" type="date" value={c.inicio} onChange={(e) => setC({ ...c, inicio: e.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="contratacao-fim">Fim</Label>
          <Input id="contratacao-fim" type="date" value={c.fim} onChange={(e) => setC({ ...c, fim: e.target.value })} />
        </div>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Serviços</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {SERVICOS.map((s) => (
            <label key={s} className="flex min-h-9 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={c.servicos.includes(s)}
                onChange={() => setC({ ...c, servicos: c.servicos.includes(s) ? c.servicos.filter((x) => x !== s) : [...c.servicos, s] })}
              />
              {ROTULO_DO_SERVICO[s]}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {QUANTIDADES.map((q) => (
          <div key={q} className="space-y-1.5">
            <Label htmlFor={`quantidade-${q}`}>{ROTULO_DA_QUANTIDADE[q]}</Label>
            <Input
              id={`quantidade-${q}`}
              inputMode="numeric"
              value={c.quantidades[q] ?? ""}
              onChange={(e) => {
                const n = e.target.value.replace(/\D/g, "");
                setC({ ...c, quantidades: { ...c.quantidades, [q]: n === "" ? undefined : Math.min(999, Number(n)) } });
              }}
            />
          </div>
        ))}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="contratacao-situacao">Situação</Label>
        <select
          id="contratacao-situacao"
          value={c.situacao}
          onChange={(e) => setC({ ...c, situacao: e.target.value as ContratacaoDaFicha["situacao"] })}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm sm:w-56"
        >
          <option value="proposta">Proposta</option>
          <option value="ativa">Ativa</option>
          <option value="pausada">Pausada</option>
          <option value="encerrada">Encerrada</option>
        </select>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={aoCancelar}>
          Cancelar
        </Button>
        <Button type="submit">Salvar contratação</Button>
      </div>
    </form>
  );
}
