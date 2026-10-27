"use client";

import { useRef, useState } from "react";

import { pedirAprovacao } from "@/app/actions/agencia/aprovacoes";
import { prepararEnvioDeArquivo } from "@/app/actions/agencia/envios";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ehAviso, ROTULO_DO_TIPO_DE_APROVACAO, type TipoDeAprovacao } from "@/lib/agencia/aprovacoes/vocabulario";
import { FORMAS_DO_TIPO, formatarTamanho, MIME_DE_PDF, MIMES_DE_IMAGEM, MIMES_DE_VIDEO, problemaNoArquivo } from "@/lib/agencia/envios/regras";
import { enviarEmPartes } from "@/lib/agencia/envios/tus";
import { cn } from "@/lib/utils";

/**
 * "Novo envio" (SPEC-envios): vídeo e arte sobem do navegador direto para a VPS,
 * em partes, com a barra de progresso; roteiro e aviso são escritos aqui. Também
 * serve para a NOVA VERSÃO de um envio que o cliente pediu para ajustar.
 */
export interface Prefixo {
  clienteId?: string;
  tipo?: TipoDeAprovacao;
  titulo?: string;
  origemId?: string | null;
  versao?: number;
  tarefaId?: string | null;
}

const TIPOS_NA_TELA: TipoDeAprovacao[] = ["video", "arte", "roteiro", "estrategia", "aviso"];

export function NovoEnvio(p: { clientes: Array<{ id: string; nome: string }>; prefixo: Prefixo; aoTerminar: (aviso: string) => void; aoFechar: () => void }) {
  const [clienteId, setClienteId] = useState(p.prefixo.clienteId ?? p.clientes[0]?.id ?? "");
  const [tipo, setTipo] = useState<TipoDeAprovacao>(p.prefixo.tipo ?? "video");
  const [titulo, setTitulo] = useState(p.prefixo.titulo ?? "");
  const [descricao, setDescricao] = useState("");
  const [texto, setTexto] = useState("");
  const [link, setLink] = useState("");
  const [comLink, setComLink] = useState(false);
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [progresso, setProgresso] = useState<number | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const cancelar = useRef<AbortController | null>(null);

  const formas = FORMAS_DO_TIPO[tipo];
  const versao = p.prefixo.origemId ? (p.prefixo.versao ?? 1) + 1 : 1;
  const aceita =
    tipo === "video" ? MIMES_DE_VIDEO.join(",") : tipo === "arte" ? MIMES_DE_IMAGEM.join(",") : [...MIMES_DE_VIDEO, ...MIMES_DE_IMAGEM, MIME_DE_PDF].join(",");

  async function enviar() {
    setErro(null);
    if (titulo.trim().length < 2) return setErro("Dê um título ao envio.");
    if (arquivo) {
      const problema = problemaNoArquivo(tipo, arquivo.type, arquivo.size);
      if (problema) return setErro(problema);
    }
    setOcupado(true);
    try {
      let envio: { caminho: string; nome: string; mime: string; bytes: number } | null = null;
      if (arquivo && !comLink) {
        const perm = await prepararEnvioDeArquivo({ clienteId, tipo, nome: arquivo.name, mime: arquivo.type, bytes: arquivo.size });
        if (!perm.ok) throw new Error(perm.erro);
        cancelar.current = new AbortController();
        setProgresso(0);
        await enviarEmPartes(arquivo, perm.dados, setProgresso, cancelar.current.signal);
        envio = { caminho: perm.dados.caminho, nome: arquivo.name, mime: arquivo.type, bytes: arquivo.size };
      }
      const r = await pedirAprovacao({
        clienteId,
        tipo,
        titulo,
        descricao: descricao.trim() || null,
        link: comLink && link.trim() ? link.trim() : null,
        arquivoId: null,
        tarefaId: p.prefixo.tarefaId ?? null,
        origemId: p.prefixo.origemId ?? null,
        texto: formas.includes("texto") && texto.trim() ? texto.trim() : null,
        envio,
      });
      if (!r.ok) throw new Error(r.erro);
      p.aoTerminar(`${ehAviso(tipo) ? "Aviso enviado." : "Enviado para o cliente aprovar."} ${r.dados.aviso}`);
    } catch (e) {
      setErro(e instanceof DOMException && e.name === "AbortError" ? "Envio cancelado." : e instanceof Error ? e.message : "Não deu para enviar.");
    } finally {
      setOcupado(false);
      setProgresso(null);
      cancelar.current = null;
    }
  }

  return (
    <section className="space-y-4 rounded-md border p-4" data-testid="novo-envio">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">{p.prefixo.origemId ? `Nova versão (v${versao})` : "Novo envio"}</h2>
        <Button type="button" variant="ghost" size="sm" onClick={p.aoFechar} disabled={ocupado}>
          Fechar
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="envio-cliente">Cliente</Label>
          <select id="envio-cliente" value={clienteId} disabled={ocupado || !!p.prefixo.origemId} onChange={(e) => setClienteId(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
            {p.clientes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nome}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="envio-titulo">Título</Label>
          <Input id="envio-titulo" value={titulo} disabled={ocupado} onChange={(e) => setTitulo(e.target.value)} placeholder="Ex.: Reels da vitrine de Natal" />
        </div>
      </div>

      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Tipo do envio">
        {TIPOS_NA_TELA.map((x) => (
          <button
            key={x}
            type="button"
            role="radio"
            aria-checked={tipo === x}
            disabled={ocupado || !!p.prefixo.origemId}
            onClick={() => {
              setTipo(x);
              setArquivo(null);
              setComLink(false);
            }}
            className={cn("rounded-full border px-3 py-1 text-sm", tipo === x ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-accent/40")}
          >
            {ROTULO_DO_TIPO_DE_APROVACAO[x]}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {ehAviso(tipo) ? "O cliente lê e marca que está ciente." : "O cliente vê dentro do sistema e aprova ou pede ajustes."}
      </p>

      {formas.includes("arquivo") && !comLink && (
        <div className="space-y-1">
          <Label htmlFor="envio-arquivo">{tipo === "video" ? "Vídeo (até 2 GB)" : tipo === "arte" ? "Arte (imagem)" : "Arquivo (opcional)"}</Label>
          <input
            id="envio-arquivo"
            type="file"
            accept={aceita}
            disabled={ocupado}
            onChange={(e) => setArquivo(e.target.files?.[0] ?? null)}
            className="block w-full text-sm file:mr-3 file:rounded-md file:border file:bg-background file:px-3 file:py-1.5"
          />
          {arquivo && (
            <p className="text-xs text-muted-foreground" data-testid="arquivo-escolhido">
              {arquivo.name} · {formatarTamanho(arquivo.size)}
            </p>
          )}
        </div>
      )}

      {formas.includes("texto") && (
        <div className="space-y-1">
          <Label htmlFor="envio-texto">{tipo === "roteiro" ? "Roteiro" : tipo === "aviso" ? "Aviso" : "Texto"}</Label>
          <textarea id="envio-texto" value={texto} disabled={ocupado} onChange={(e) => setTexto(e.target.value)} rows={tipo === "aviso" ? 4 : 10} className="w-full rounded-md border bg-background p-2 text-sm" />
        </div>
      )}

      {(tipo === "video" || tipo === "arte") && (
        <div className="space-y-1">
          <Label htmlFor="envio-descricao">Descrição para o cliente</Label>
          <textarea id="envio-descricao" value={descricao} disabled={ocupado} onChange={(e) => setDescricao(e.target.value)} rows={3} className="w-full rounded-md border bg-background p-2 text-sm" placeholder="Legenda, contexto, o que observar…" />
        </div>
      )}

      {formas.includes("link") && (
        <div className="space-y-1">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={comLink} disabled={ocupado} onChange={(e) => setComLink(e.target.checked)} />
            Mandar um link em vez de subir o arquivo
          </label>
          {comLink && <Input aria-label="Link do material" value={link} disabled={ocupado} onChange={(e) => setLink(e.target.value)} placeholder="https://…" />}
        </div>
      )}

      {progresso !== null && (
        <div className="space-y-1" data-testid="progresso-do-envio">
          <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={Math.round(progresso * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full bg-primary transition-all" style={{ width: `${Math.round(progresso * 100)}%` }} />
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Subindo… {Math.round(progresso * 100)}%</span>
            <button type="button" className="underline" onClick={() => cancelar.current?.abort()}>
              Cancelar
            </button>
          </div>
        </div>
      )}
      {erro && (
        <p role="alert" className="text-sm text-destructive">
          {erro}
        </p>
      )}
      <Button type="button" onClick={enviar} disabled={ocupado || !clienteId}>
        {ocupado ? "Enviando…" : ehAviso(tipo) ? "Enviar aviso" : "Enviar para aprovar"}
      </Button>
    </section>
  );
}
