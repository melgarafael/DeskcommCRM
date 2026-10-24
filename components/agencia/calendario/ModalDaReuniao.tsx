"use client";

import { useState, useTransition } from "react";

import { cancelarReuniao, registrarResultado, salvarReuniao } from "@/app/actions/agencia/reunioes";
import { EnvioParaODrive } from "@/components/agencia/EnvioParaODrive";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ApoioDaAgenda, ClienteDaAgenda } from "@/lib/agencia/calendario/apoio";
import type { ReuniaoDaAgenda } from "@/lib/agencia/calendario/consultas";
import { diaDe, fechamentoUmaSemanaDepois, horaLocal, instanteDoDia, rotuloLongoDoDia, tituloSugerido } from "@/lib/agencia/calendario/regras";
import {
  FORMATOS,
  PAUTA_DA_APRESENTACAO,
  ROTULO_DA_SITUACAO,
  ROTULO_DO_FORMATO,
  ROTULO_DO_TIPO,
  SITUACOES_DA_REUNIAO,
  TIPOS_DE_REUNIAO,
  type Formato,
  type SituacaoDaReuniao,
  type TipoDeReuniao,
} from "@/lib/agencia/calendario/vocabulario";

/**
 * Marcar, ver e fechar uma reunião (docs/agencia/SPEC-calendario.md › Telas).
 * Datas e horas são lidas e escritas SEMPRE no fuso da agência
 * (`instanteDoDia`/`horaLocal`), qualquer que seja o fuso do aparelho.
 */
export interface NovaReuniao {
  dia: string;
  hora: string;
  clienteId: string | null;
}

interface Rascunho {
  tipo: TipoDeReuniao;
  titulo: string;
  tituloEditado: boolean;
  clienteId: string;
  dia: string;
  inicio: string;
  fim: string;
  formato: Formato;
  local: string;
  membros: string[];
  convidados: Array<{ nome: string; whatsapp: string; email: string }>;
  pauta: string;
  avisarCliente: boolean;
  marcarFechamento: boolean;
}

function somarMinutos(hora: string, minutos: number): string {
  const [h, m] = hora.split(":").map(Number);
  const total = Math.min(((h ?? 0) * 60 + (m ?? 0) + minutos + 1440) % 1440, 23 * 60 + 59);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function minutosDe(hora: string): number {
  const [h, m] = hora.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function convidadosDoCliente(c: ClienteDaAgenda | undefined): Rascunho["convidados"] {
  if (!c || (!c.responsavelNome && !c.whatsapp && !c.email)) return [];
  return [{ nome: c.responsavelNome || c.nome, whatsapp: c.whatsapp, email: c.email }];
}

function novoRascunho(n: NovaReuniao, apoio: ApoioDaAgenda, meuMembroId: string | null): Rascunho {
  const cliente = apoio.clientes.find((c) => c.id === n.clienteId);
  const tipo: TipoDeReuniao = cliente ? "apresentacao" : "interna";
  return {
    tipo,
    titulo: tituloSugerido(tipo, cliente?.nome ?? null),
    tituloEditado: false,
    clienteId: cliente?.id ?? "",
    dia: n.dia,
    inicio: n.hora,
    fim: somarMinutos(n.hora, 60),
    formato: "online",
    local: "",
    membros: meuMembroId ? [meuMembroId] : [],
    convidados: convidadosDoCliente(cliente),
    pauta: tipo === "apresentacao" ? PAUTA_DA_APRESENTACAO : "",
    avisarCliente: true,
    marcarFechamento: tipo === "apresentacao",
  };
}

function daReuniao(r: ReuniaoDaAgenda): Rascunho {
  return {
    tipo: r.tipo,
    titulo: r.titulo,
    tituloEditado: true,
    clienteId: r.clienteId ?? "",
    dia: diaDe(r.inicio),
    inicio: horaLocal(r.inicio),
    fim: horaLocal(r.fim),
    formato: r.formato,
    local: r.local ?? "",
    membros: r.membros,
    convidados: r.convidados,
    pauta: r.pauta ?? "",
    avisarCliente: r.avisarCliente,
    marcarFechamento: false,
  };
}

const ERRO_SEM_AGENDA = "sem_agenda";

export function ModalDaReuniao({
  aberto,
  reuniao,
  nova,
  apoio,
  meuMembroId,
  podeGerenciar,
  agendaLiberada,
  aoFechar,
}: {
  aberto: boolean;
  reuniao: ReuniaoDaAgenda | null;
  nova: NovaReuniao;
  apoio: ApoioDaAgenda;
  meuMembroId: string | null;
  podeGerenciar: boolean;
  agendaLiberada: boolean;
  aoFechar: (mudou: boolean) => void;
}) {
  // Quem abre monta o modal de novo a cada reunião (`key`): o rascunho nasce do que veio, sem efeito.
  const [r, setR] = useState<Rascunho>(() => (reuniao ? daReuniao(reuniao) : novoRascunho(nova, apoio, meuMembroId)));
  const [resultado, setResultado] = useState(() => ({
    situacao: (reuniao?.situacao ?? "marcada") as SituacaoDaReuniao,
    ata: reuniao?.ata ?? "",
    gravacaoUrl: reuniao?.gravacaoUrl ?? "",
  }));
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [pendente, startTransition] = useTransition();
  const [abertoEm] = useState(() => Date.now());

  const cancelada = reuniao?.situacao === "cancelada";
  const editavel = podeGerenciar && !cancelada;
  const cliente = apoio.clientes.find((c) => c.id === r.clienteId);

  function mudar(p: Partial<Rascunho>) {
    setR((atual) => {
      const prox = { ...atual, ...p };
      if (!prox.tituloEditado && (p.tipo !== undefined || p.clienteId !== undefined)) {
        prox.titulo = tituloSugerido(prox.tipo, apoio.clientes.find((c) => c.id === prox.clienteId)?.nome ?? null);
      }
      return prox;
    });
  }

  function trocarCliente(id: string) {
    const c = apoio.clientes.find((x) => x.id === id);
    // Em reunião nova, os convidados acompanham o cliente escolhido.
    mudar({ clienteId: id, ...(reuniao ? {} : { convidados: convidadosDoCliente(c) }) });
  }

  function trocarTipo(tipo: TipoDeReuniao) {
    const pautaPadrao = !reuniao && (r.pauta === "" || r.pauta === PAUTA_DA_APRESENTACAO);
    mudar({
      tipo,
      ...(pautaPadrao ? { pauta: tipo === "apresentacao" ? PAUTA_DA_APRESENTACAO : "" } : {}),
      marcarFechamento: tipo === "apresentacao" && !reuniao,
    });
  }

  function trocarInicio(inicio: string) {
    const duracao = Math.max(minutosDe(r.fim) - minutosDe(r.inicio), 15);
    mudar({ inicio, fim: somarMinutos(inicio, duracao) });
  }

  function salvar() {
    setErro(null);
    setAviso(null);
    if (!r.dia || !r.inicio || !r.fim) return setErro("Informe o dia e o horário.");
    if (minutosDe(r.fim) <= minutosDe(r.inicio)) return setErro("O fim tem de ser depois do início.");
    startTransition(async () => {
      const res = await salvarReuniao({
        ...(reuniao ? { id: reuniao.id } : {}),
        tipo: r.tipo,
        titulo: r.titulo,
        clienteId: r.clienteId || null,
        inicio: instanteDoDia(r.dia, r.inicio).toISOString(),
        fim: instanteDoDia(r.dia, r.fim).toISOString(),
        formato: r.formato,
        local: r.formato === "presencial" ? r.local : null,
        pauta: r.pauta || null,
        membros: r.membros,
        convidados: r.convidados.filter((c) => c.nome.trim()),
        avisarCliente: r.avisarCliente,
        marcarFechamento: r.marcarFechamento,
      });
      if (!res.ok) return setErro(res.erro);
      aoFechar(true);
    });
  }

  function salvarResultado(extra: Partial<typeof resultado> = {}) {
    if (!reuniao) return;
    const dados = { ...resultado, ...extra };
    startTransition(async () => {
      const res = await registrarResultado({
        id: reuniao.id,
        situacao: dados.situacao === "cancelada" ? "marcada" : dados.situacao,
        ata: dados.ata || null,
        gravacaoUrl: dados.gravacaoUrl || null,
      });
      if (!res.ok) return setErro(res.erro);
      setAviso("Salvo.");
      aoFechar(true);
    });
  }

  function cancelar() {
    if (!reuniao) return;
    const quem = reuniao.avisarCliente && reuniao.clienteId ? " O cliente e os convidados serão avisados." : "";
    if (!window.confirm(`Cancelar esta reunião?${quem}`)) return;
    startTransition(async () => {
      const res = await cancelarReuniao(reuniao.id);
      if (!res.ok) return setErro(res.erro);
      aoFechar(true);
    });
  }

  const fechamento =
    !reuniao && r.tipo === "apresentacao" && r.marcarFechamento && r.dia && r.inicio
      ? fechamentoUmaSemanaDepois(instanteDoDia(r.dia, r.inicio).toISOString(), instanteDoDia(r.dia, r.fim).toISOString())
      : null;
  // "Depois da reunião" aparece a partir de 1 hora antes do início.
  const passou = reuniao ? new Date(reuniao.inicio).getTime() < abertoEm + 60 * 60_000 : false;

  return (
    <Dialog open={aberto} onOpenChange={(v) => !v && aoFechar(false)}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl" data-testid="modal-da-reuniao">
        <DialogHeader>
          <DialogTitle>{reuniao ? reuniao.titulo : "Nova reunião"}</DialogTitle>
          <DialogDescription>
            {reuniao
              ? `${rotuloLongoDoDia(diaDe(reuniao.inicio))}, ${horaLocal(reuniao.inicio)}–${horaLocal(reuniao.fim)} · ${ROTULO_DA_SITUACAO[reuniao.situacao]}`
              : "Marque a reunião; o link do Meet e o convite saem sozinhos quando o Google está conectado."}
          </DialogDescription>
        </DialogHeader>

        {reuniao && !cancelada && (
          <div className="space-y-2 rounded-md border p-3 text-sm">
            {reuniao.meetUrl ? (
              <a href={reuniao.meetUrl} target="_blank" rel="noreferrer" className="block font-medium underline underline-offset-4">
                Entrar no Google Meet
              </a>
            ) : reuniao.formato === "online" && !reuniao.googleErro ? (
              <p className="text-muted-foreground">O link do Meet ainda não chegou do Google.</p>
            ) : null}
            {reuniao.googleLink && (
              <a href={reuniao.googleLink} target="_blank" rel="noreferrer" className="block text-muted-foreground underline underline-offset-4">
                Abrir no Google Agenda
              </a>
            )}
            {reuniao.googleErro === ERRO_SEM_AGENDA ? (
              <p className="text-muted-foreground">
                Esta reunião está só na central: a conexão Google da agência ainda não liberou a Agenda. Em Configurações, clique em
                Reconectar.
              </p>
            ) : reuniao.googleErro ? (
              <p role="alert" className="text-destructive">
                Não foi para o Google Agenda: {reuniao.googleErro} Salve de novo para tentar outra vez.
              </p>
            ) : null}
          </div>
        )}

        <fieldset disabled={!editavel || pendente} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="reuniao-tipo">Tipo</Label>
              <select
                id="reuniao-tipo"
                value={r.tipo}
                onChange={(e) => trocarTipo(e.target.value as TipoDeReuniao)}
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              >
                {TIPOS_DE_REUNIAO.map((t) => (
                  <option key={t} value={t}>
                    {ROTULO_DO_TIPO[t]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="reuniao-cliente">Cliente</Label>
              <select
                id="reuniao-cliente"
                value={r.clienteId}
                onChange={(e) => trocarCliente(e.target.value)}
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              >
                <option value="">Sem cliente (interna)</option>
                {apoio.clientes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nome}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="reuniao-titulo">Título</Label>
            <Input id="reuniao-titulo" value={r.titulo} onChange={(e) => mudar({ titulo: e.target.value, tituloEditado: true })} />
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="col-span-2 space-y-1 sm:col-span-1">
              <Label htmlFor="reuniao-dia">Dia</Label>
              <Input id="reuniao-dia" type="date" value={r.dia} onChange={(e) => mudar({ dia: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="reuniao-inicio">Início</Label>
              <Input id="reuniao-inicio" type="time" step={900} value={r.inicio} onChange={(e) => trocarInicio(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="reuniao-fim">Fim</Label>
              <Input id="reuniao-fim" type="time" step={900} value={r.fim} onChange={(e) => mudar({ fim: e.target.value })} />
            </div>
          </div>

          <div className="space-y-2">
            <span className="text-sm font-medium">Formato</span>
            <div className="flex flex-wrap gap-2">
              {FORMATOS.map((f) => (
                <label key={f} className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm has-[:checked]:border-foreground">
                  <input type="radio" name="reuniao-formato" checked={r.formato === f} onChange={() => mudar({ formato: f })} />
                  {ROTULO_DO_FORMATO[f]}
                </label>
              ))}
            </div>
            {r.formato === "presencial" && (
              <Input aria-label="Endereço" placeholder="Endereço" value={r.local} onChange={(e) => mudar({ local: e.target.value })} />
            )}
            {r.formato === "online" && !agendaLiberada && (
              <p className="text-xs text-muted-foreground">
                O link do Meet só é criado com a Agenda Google liberada (Configurações › Google).
              </p>
            )}
          </div>

          <div className="space-y-2">
            <span className="text-sm font-medium">Da agência</span>
            {apoio.membros.length === 0 ? (
              <p className="text-xs text-muted-foreground">Ninguém da equipe cadastrado ainda.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {apoio.membros.map((m) => (
                  <label key={m.id} className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm has-[:checked]:border-foreground">
                    <input
                      type="checkbox"
                      checked={r.membros.includes(m.id)}
                      onChange={(e) =>
                        mudar({ membros: e.target.checked ? [...r.membros, m.id] : r.membros.filter((x) => x !== m.id) })
                      }
                    />
                    {m.nome}
                  </label>
                ))}
              </div>
            )}
          </div>

          {r.clienteId && (
            <div className="space-y-2">
              <span className="text-sm font-medium">Convidados do cliente</span>
              {r.convidados.map((c, i) => (
                <div key={i} className="grid gap-2 rounded-md border p-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
                  <Input
                    aria-label="Nome do convidado"
                    placeholder="Nome"
                    value={c.nome}
                    onChange={(e) => mudar({ convidados: r.convidados.map((x, j) => (j === i ? { ...x, nome: e.target.value } : x)) })}
                  />
                  <Input
                    aria-label="WhatsApp do convidado"
                    placeholder="WhatsApp"
                    inputMode="tel"
                    value={c.whatsapp}
                    onChange={(e) => mudar({ convidados: r.convidados.map((x, j) => (j === i ? { ...x, whatsapp: e.target.value } : x)) })}
                  />
                  <Input
                    aria-label="E-mail do convidado"
                    placeholder="E-mail"
                    type="email"
                    value={c.email}
                    onChange={(e) => mudar({ convidados: r.convidados.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)) })}
                  />
                  <Button type="button" variant="ghost" size="sm" onClick={() => mudar({ convidados: r.convidados.filter((_, j) => j !== i) })}>
                    Tirar
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => mudar({ convidados: [...r.convidados, { nome: "", whatsapp: "", email: "" }] })}
              >
                Adicionar convidado
              </Button>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1" checked={r.avisarCliente} onChange={(e) => mudar({ avisarCliente: e.target.checked })} />
                <span>
                  Avisar o cliente no WhatsApp da agência
                  <span className="block text-xs text-muted-foreground">
                    Dia, hora e o link — sai dentro do horário de avisos. O convite do Google vai a quem tem e-mail.
                  </span>
                </span>
              </label>
            </div>
          )}

          {!reuniao && r.tipo === "apresentacao" ? (
            <label className="flex items-start gap-2 rounded-md border p-3 text-sm">
              <input type="checkbox" className="mt-1" checked={r.marcarFechamento} onChange={(e) => mudar({ marcarFechamento: e.target.checked })} />
              <span>
                Marcar o Fechamento uma semana depois
                {fechamento && (
                  <span className="block text-xs text-muted-foreground">
                    {rotuloLongoDoDia(diaDe(fechamento.inicio))}, às {horaLocal(fechamento.inicio)}
                  </span>
                )}
              </span>
            </label>
          ) : null}

          <div className="space-y-1">
            <Label htmlFor="reuniao-pauta">Pauta</Label>
            <textarea
              id="reuniao-pauta"
              rows={r.tipo === "apresentacao" ? 10 : 4}
              value={r.pauta}
              onChange={(e) => mudar({ pauta: e.target.value })}
              className="w-full rounded-md border bg-background p-2 text-sm"
            />
          </div>
        </fieldset>

        {erro && (
          <p role="alert" className="text-sm text-destructive">
            {erro}
          </p>
        )}

        {editavel && (
          <div className="flex flex-wrap justify-between gap-2">
            {reuniao ? (
              <Button type="button" variant="ghost" onClick={cancelar} disabled={pendente} className="text-destructive">
                Cancelar reunião
              </Button>
            ) : (
              <span />
            )}
            <Button type="button" onClick={salvar} disabled={pendente}>
              {pendente ? "Salvando…" : reuniao ? "Salvar mudanças" : "Marcar reunião"}
            </Button>
          </div>
        )}

        {reuniao && !cancelada && passou && (
          <fieldset disabled={!podeGerenciar || pendente} className="space-y-3 border-t pt-4">
            <legend className="text-sm font-semibold">Depois da reunião</legend>
            <div className="space-y-1">
              <Label htmlFor="reuniao-situacao">Como foi</Label>
              <select
                id="reuniao-situacao"
                value={resultado.situacao}
                onChange={(e) => setResultado({ ...resultado, situacao: e.target.value as SituacaoDaReuniao })}
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              >
                {SITUACOES_DA_REUNIAO.filter((s) => s !== "cancelada").map((s) => (
                  <option key={s} value={s}>
                    {ROTULO_DA_SITUACAO[s]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="reuniao-ata">Ata</Label>
              <textarea
                id="reuniao-ata"
                rows={6}
                value={resultado.ata}
                onChange={(e) => setResultado({ ...resultado, ata: e.target.value })}
                placeholder="O que foi decidido, próximos passos…"
                className="w-full rounded-md border bg-background p-2 text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="reuniao-gravacao">Gravação (link)</Label>
              <Input
                id="reuniao-gravacao"
                placeholder="https://…"
                value={resultado.gravacaoUrl}
                onChange={(e) => setResultado({ ...resultado, gravacaoUrl: e.target.value })}
              />
              {reuniao.clienteId && (
                <div className="pt-1">
                  <p className="pb-1 text-xs text-muted-foreground">Ou envie o arquivo para a pasta do cliente no Drive:</p>
                  <EnvioParaODrive
                    clienteId={reuniao.clienteId}
                    tarefaId={null}
                    subpastaInicial="03 Planejamento"
                    aoTerminar={(links) => {
                      const link = links[0];
                      if (link) salvarResultado({ gravacaoUrl: link });
                    }}
                  />
                </div>
              )}
            </div>
            {aviso && (
              <p role="status" className="text-sm text-muted-foreground">
                {aviso}
              </p>
            )}
            <div className="flex justify-end">
              <Button type="button" variant="outline" onClick={() => salvarResultado()} disabled={pendente}>
                Salvar resultado
              </Button>
            </div>
          </fieldset>
        )}

        {cliente && !reuniao && !cliente.whatsapp && !cliente.email && (
          <p className="text-xs text-muted-foreground">O cadastro deste cliente não tem WhatsApp nem e-mail; inclua o convidado acima.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
