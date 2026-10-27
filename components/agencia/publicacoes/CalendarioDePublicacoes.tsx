"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  agendarPublicacao,
  cancelarPublicacao,
  marcarComoPublicada,
  pedirAprovacaoDaPublicacao,
  salvarPublicacao,
} from "@/app/actions/agencia/publicacoes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { rotuloCurtoDoDia, rotuloLongoDoDia } from "@/lib/agencia/calendario/regras";
import {
  FORMATOS,
  REDES,
  ROTULO_DA_REDE,
  ROTULO_DA_SITUACAO_DA_PUBLICACAO,
  ROTULO_DO_FORMATO,
  publicaSozinho,
  somarMeses,
  type Formato,
  type Rede,
  type SituacaoDaPublicacao,
} from "@/lib/agencia/publicacoes/regras";
import { cn } from "@/lib/utils";

export interface PublicacaoNaTela {
  id: string;
  clienteId: string;
  clienteNome: string;
  titulo: string;
  rede: Rede;
  formato: Formato;
  dia: string;
  hora: string;
  legenda: string;
  midiaUrl: string;
  responsavelId: string | null;
  situacao: SituacaoDaPublicacao;
  autoPublicar: boolean;
  comentario: string | null;
  postUrl: string | null;
  erro: string | null;
}

interface Props {
  mes: string;
  hoje: string;
  grade: string[][];
  clienteFiltro: string;
  abrir: string | null;
  podeEditar: boolean;
  clientes: Array<{ id: string; nome: string }>;
  membros: Array<{ id: string; nome: string }>;
  publicacoes: PublicacaoNaTela[];
}

const COR_DA_SITUACAO: Record<SituacaoDaPublicacao, string> = {
  rascunho: "border-dashed bg-background text-muted-foreground",
  em_aprovacao: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  aprovada: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
  agendada: "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200",
  publicando: "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200",
  publicada: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  falhou: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
  cancelada: "bg-muted text-muted-foreground line-through",
};

const DIAS = ["seg", "ter", "qua", "qui", "sex", "sáb", "dom"];

type Rascunho = Omit<PublicacaoNaTela, "id" | "clienteNome" | "situacao" | "autoPublicar" | "comentario" | "postUrl" | "erro"> & { id: string | null };

function nomeDoMes(mes: string): string {
  const [a, m] = mes.split("-").map(Number) as [number, number];
  const nome = new Date(Date.UTC(a, m - 1, 15)).toLocaleDateString("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" });
  // Só a primeira letra: "Novembro de 2026", nunca "Novembro De 2026".
  return nome.charAt(0).toUpperCase() + nome.slice(1);
}

export function CalendarioDePublicacoes(p: Props) {
  const router = useRouter();
  const [aberta, setAberta] = useState<string | null>(p.abrir && p.publicacoes.some((x) => x.id === p.abrir) ? p.abrir : null);
  const [rascunho, setRascunho] = useState<Rascunho | null>(() => {
    const x = p.publicacoes.find((q) => q.id === p.abrir);
    return x ? deTela(x) : null;
  });
  const [mensagem, setMensagem] = useState<{ tipo: "ok" | "erro"; texto: string } | null>(null);
  const [postUrl, setPostUrl] = useState("");
  const [pendente, startTransition] = useTransition();
  const atual = aberta ? p.publicacoes.find((x) => x.id === aberta) ?? null : null;

  function deTela(x: PublicacaoNaTela): Rascunho {
    return { id: x.id, clienteId: x.clienteId, titulo: x.titulo, rede: x.rede, formato: x.formato, dia: x.dia, hora: x.hora, legenda: x.legenda, midiaUrl: x.midiaUrl, responsavelId: x.responsavelId };
  }
  function url(mudar: { mes?: string; cliente?: string | null }) {
    const q = new URLSearchParams();
    q.set("mes", mudar.mes ?? p.mes);
    const c = mudar.cliente === undefined ? p.clienteFiltro : mudar.cliente;
    if (c) q.set("cliente", c);
    return `/agencia/publicacoes?${q.toString()}`;
  }
  function abrirPublicacao(x: PublicacaoNaTela) {
    setAberta(x.id);
    setRascunho(deTela(x));
    setMensagem(null);
    setPostUrl(x.postUrl ?? "");
  }
  function nova(dia: string) {
    setAberta(null);
    setMensagem(null);
    setRascunho({ id: null, clienteId: p.clienteFiltro || p.clientes[0]?.id || "", titulo: "", rede: "instagram", formato: "feed", dia, hora: "18:00", legenda: "", midiaUrl: "", responsavelId: null });
  }
  function rodar(acao: () => Promise<{ ok: true } | { ok: false; erro: string }>, sucesso: string | ((r: unknown) => string)) {
    startTransition(async () => {
      const r = await acao();
      if (!r.ok) return setMensagem({ tipo: "erro", texto: r.erro });
      setMensagem({ tipo: "ok", texto: typeof sucesso === "string" ? sucesso : sucesso(r) });
      router.refresh();
    });
  }
  function salvar() {
    if (!rascunho) return;
    startTransition(async () => {
      const r = await salvarPublicacao({ ...rascunho, responsavelId: rascunho.responsavelId || null });
      if (!r.ok) return setMensagem({ tipo: "erro", texto: r.erro });
      setAberta(r.dados.id);
      setRascunho({ ...rascunho, id: r.dados.id });
      setMensagem({ tipo: "ok", texto: r.dados.aviso ?? "Publicação salva." });
      router.refresh();
    });
  }

  const doDia = (dia: string) => p.publicacoes.filter((x) => x.dia === dia);
  const doMes = p.publicacoes.filter((x) => x.dia.startsWith(p.mes));
  const editavel = p.podeEditar && (!atual || !["publicada", "publicando", "cancelada"].includes(atual.situacao));

  return (
    <div className="space-y-4" data-testid="calendario-de-publicacoes">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-2xl font-semibold tracking-tight">Publicações</h1>
        <select
          aria-label="Filtrar por cliente"
          value={p.clienteFiltro}
          onChange={(e) => router.push(url({ cliente: e.target.value || null }))}
          className="h-9 max-w-[12rem] rounded-md border bg-background px-2 text-sm"
        >
          <option value="">Todos os clientes</option>
          {p.clientes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.nome}
            </option>
          ))}
        </select>
        {p.podeEditar && p.clientes.length > 0 && (
          <Button type="button" onClick={() => nova(p.hoje.startsWith(p.mes) ? p.hoje : `${p.mes}-01`)}>
            Nova publicação
          </Button>
        )}
      </div>

      <div className="flex items-center gap-2 text-sm">
        <Link href={url({ mes: somarMeses(p.mes, -1) })} className="rounded-md border px-2 py-1 hover:bg-accent" aria-label="Mês anterior">
          ←
        </Link>
        <span className="min-w-[10rem] text-center font-medium" data-testid="mes-aberto">
          {nomeDoMes(p.mes)}
        </span>
        <Link href={url({ mes: somarMeses(p.mes, 1) })} className="rounded-md border px-2 py-1 hover:bg-accent" aria-label="Próximo mês">
          →
        </Link>
        <span className="ml-auto text-xs text-muted-foreground">
          {doMes.filter((x) => x.situacao === "publicada").length} de {doMes.filter((x) => x.situacao !== "cancelada").length} no ar
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        {/* Computador: grade do mês. */}
        <div className="overflow-hidden rounded-md border max-md:hidden" data-testid="grade-do-mes">
          <div className="grid grid-cols-7 border-b bg-muted/40 text-xs text-muted-foreground">
            {DIAS.map((d) => (
              <div key={d} className="px-2 py-1">
                {d}
              </div>
            ))}
          </div>
          {p.grade.map((semana) => (
            <div key={semana[0]} className="grid grid-cols-7 border-b last:border-b-0">
              {semana.map((dia) => (
                <div key={dia} className={cn("min-h-24 border-r p-1 last:border-r-0", !dia.startsWith(p.mes) && "bg-muted/30 text-muted-foreground")}>
                  <div className="flex items-center justify-between">
                    <span className={cn("text-xs", dia === p.hoje && "rounded bg-primary px-1 text-primary-foreground")}>{Number(dia.slice(8))}</span>
                    {p.podeEditar && (
                      <button type="button" onClick={() => nova(dia)} className="rounded px-1 text-xs text-muted-foreground hover:bg-accent" aria-label={`Nova publicação em ${rotuloCurtoDoDia(dia)}`}>
                        +
                      </button>
                    )}
                  </div>
                  <div className="mt-1 space-y-1">
                    {doDia(dia).map((x) => (
                      <button
                        key={x.id}
                        type="button"
                        onClick={() => abrirPublicacao(x)}
                        data-testid="publicacao-na-grade"
                        data-situacao={x.situacao}
                        className={cn("block w-full truncate rounded border px-1 py-0.5 text-left text-[11px]", COR_DA_SITUACAO[x.situacao], aberta === x.id && "ring-2 ring-primary")}
                        title={`${x.hora} ${x.titulo} — ${x.clienteNome}`}
                      >
                        {x.hora} {x.titulo}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* Celular: lista por dia. */}
        <ul className="space-y-2 md:hidden" data-testid="lista-de-publicacoes">
          {doMes.length === 0 && <li className="rounded-md border p-3 text-sm text-muted-foreground">Nada neste mês.</li>}
          {doMes.map((x) => (
            <li key={x.id}>
              <button type="button" onClick={() => abrirPublicacao(x)} className={cn("w-full rounded-md border p-3 text-left text-sm", COR_DA_SITUACAO[x.situacao])}>
                <span className="block font-medium">{x.titulo}</span>
                <span className="text-xs">
                  {rotuloCurtoDoDia(x.dia)} {x.hora} · {ROTULO_DA_REDE[x.rede]} · {x.clienteNome} · {ROTULO_DA_SITUACAO_DA_PUBLICACAO[x.situacao]}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <aside className="space-y-3 rounded-md border p-4 text-sm" data-testid="painel-da-publicacao">
          {!rascunho ? (
            <p className="text-muted-foreground">Clique numa publicação para ver os detalhes{p.podeEditar ? ", ou em + num dia para criar uma." : "."}</p>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-semibold">{rascunho.id ? "Publicação" : "Nova publicação"}</h2>
                {atual && (
                  <span className={cn("rounded border px-2 py-0.5 text-xs", COR_DA_SITUACAO[atual.situacao])} data-testid="situacao-da-publicacao">
                    {ROTULO_DA_SITUACAO_DA_PUBLICACAO[atual.situacao]}
                    {atual.situacao === "agendada" && (atual.autoPublicar ? " · publica sozinha" : " · postar à mão")}
                  </span>
                )}
              </div>
              {atual?.comentario && (
                <p className="rounded-md bg-amber-50 p-2 text-amber-900 dark:bg-amber-950 dark:text-amber-200" data-testid="comentario-do-cliente">
                  Ajuste pedido pelo cliente: {atual.comentario}
                </p>
              )}
              {atual?.erro && (
                <p className="rounded-md bg-red-50 p-2 text-red-900 dark:bg-red-950 dark:text-red-200" data-testid="erro-da-publicacao">
                  {atual.erro}
                </p>
              )}
              {atual?.postUrl && (
                <a href={atual.postUrl} target="_blank" rel="noreferrer" className="block truncate text-primary underline">
                  Ver o post
                </a>
              )}

              <fieldset disabled={!editavel || pendente} className="space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="pub-cliente">Cliente</Label>
                  <select id="pub-cliente" value={rascunho.clienteId} disabled={!!rascunho.id} onChange={(e) => setRascunho({ ...rascunho, clienteId: e.target.value })} className="h-9 w-full rounded-md border bg-background px-2">
                    {p.clientes.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.nome}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="pub-titulo">Nome</Label>
                  <Input id="pub-titulo" value={rascunho.titulo} onChange={(e) => setRascunho({ ...rascunho, titulo: e.target.value })} placeholder="Ex.: Reels da promoção" />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label htmlFor="pub-rede">Rede</Label>
                    <select id="pub-rede" value={rascunho.rede} onChange={(e) => setRascunho({ ...rascunho, rede: e.target.value as Rede })} className="h-9 w-full rounded-md border bg-background px-2">
                      {REDES.map((r) => (
                        <option key={r} value={r}>
                          {ROTULO_DA_REDE[r]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="pub-formato">Formato</Label>
                    <select id="pub-formato" value={rascunho.formato} onChange={(e) => setRascunho({ ...rascunho, formato: e.target.value as Formato })} className="h-9 w-full rounded-md border bg-background px-2">
                      {FORMATOS.map((f) => (
                        <option key={f} value={f}>
                          {ROTULO_DO_FORMATO[f]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="pub-dia">Dia</Label>
                    <Input id="pub-dia" type="date" value={rascunho.dia} onChange={(e) => setRascunho({ ...rascunho, dia: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="pub-hora">Hora</Label>
                    <Input id="pub-hora" type="time" value={rascunho.hora} onChange={(e) => setRascunho({ ...rascunho, hora: e.target.value })} />
                  </div>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="pub-legenda">Legenda</Label>
                  <textarea id="pub-legenda" value={rascunho.legenda} onChange={(e) => setRascunho({ ...rascunho, legenda: e.target.value })} rows={4} className="w-full rounded-md border bg-background p-2" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="pub-midia">Link da mídia</Label>
                  <Input id="pub-midia" value={rascunho.midiaUrl} onChange={(e) => setRascunho({ ...rascunho, midiaUrl: e.target.value })} placeholder="https://…" />
                  <p className="text-xs text-muted-foreground">Para publicar sozinho, o link precisa ser do próprio arquivo (.jpg, .png, .mp4), público.</p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="pub-responsavel">Responsável</Label>
                  <select id="pub-responsavel" value={rascunho.responsavelId ?? ""} onChange={(e) => setRascunho({ ...rascunho, responsavelId: e.target.value || null })} className="h-9 w-full rounded-md border bg-background px-2">
                    <option value="">Ninguém</option>
                    {p.membros.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.nome}
                      </option>
                    ))}
                  </select>
                </div>
                {editavel && (
                  <Button type="button" onClick={salvar} className="w-full">
                    Salvar publicação
                  </Button>
                )}
              </fieldset>

              {p.podeEditar && atual && (
                <div className="space-y-2 border-t pt-3">
                  {(atual.situacao === "rascunho" || atual.situacao === "falhou") && (
                    <Button type="button" variant="outline" className="w-full" disabled={pendente} onClick={() => rodar(() => pedirAprovacaoDaPublicacao(atual.id), (r) => `Enviada para o cliente aprovar. ${(r as { dados: { aviso: string } }).dados.aviso}`)}>
                      Pedir aprovação ao cliente
                    </Button>
                  )}
                  {(atual.situacao === "aprovada" || atual.situacao === "falhou") && (
                    <>
                      <Button type="button" variant="outline" className="w-full" disabled={pendente} onClick={() => rodar(() => agendarPublicacao(atual.id, false), "Agendada: poste à mão no horário e marque como publicada.")}>
                        Agendar (postar à mão)
                      </Button>
                      {publicaSozinho(atual.rede, atual.formato) && (
                        <Button type="button" className="w-full" disabled={pendente} onClick={() => rodar(() => agendarPublicacao(atual.id, true), "Agendada: a central publica sozinha no horário.")}>
                          Agendar e publicar sozinho
                        </Button>
                      )}
                    </>
                  )}
                  {!["publicada", "publicando", "cancelada"].includes(atual.situacao) && (
                    <div className="space-y-1">
                      <Label htmlFor="pub-post-url">Link do post (opcional)</Label>
                      <div className="flex gap-2">
                        <Input id="pub-post-url" value={postUrl} onChange={(e) => setPostUrl(e.target.value)} placeholder="https://… (link do post)" />
                        <Button type="button" variant="outline" disabled={pendente} onClick={() => rodar(() => marcarComoPublicada(atual.id, postUrl), "Marcada como publicada.")}>
                          Publicada
                        </Button>
                      </div>
                    </div>
                  )}
                  {!["publicada", "publicando", "cancelada"].includes(atual.situacao) && (
                    <Button
                      type="button"
                      variant="ghost"
                      className="w-full text-destructive"
                      disabled={pendente}
                      onClick={() => {
                        if (window.confirm("Cancelar esta publicação?")) rodar(() => cancelarPublicacao(atual.id), "Publicação cancelada.");
                      }}
                    >
                      Cancelar publicação
                    </Button>
                  )}
                </div>
              )}
              {atual && <p className="text-xs text-muted-foreground">{rotuloLongoDoDia(atual.dia)}, {atual.hora} · {atual.clienteNome}</p>}
            </>
          )}
          {mensagem && (
            <p role={mensagem.tipo === "erro" ? "alert" : "status"} data-testid="mensagem-da-publicacao" className={cn("text-sm", mensagem.tipo === "erro" ? "text-destructive" : "text-emerald-700 dark:text-emerald-400")}>
              {mensagem.texto}
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}
