"use client";

import { useRef, useState } from "react";

import { confirmarEnvioDeArquivo, iniciarEnvioDeArquivo } from "@/app/actions/agencia/arquivos";
import { Button } from "@/components/ui/button";

/**
 * Envio de arquivo para a pasta do cliente no Google Drive
 * (docs/agencia/SPEC-acervo.md, A5). O arquivo vai do navegador direto ao
 * Google, pela sessão resumível que o servidor abriu — não passa pela VPS.
 */
const SUBPASTAS = [
  "01 Formulário",
  "02 Contrato e proposta",
  "03 Planejamento",
  "04 Identidade visual",
  "05 Captações",
  "06 Edições",
  "07 Artes",
  "08 Relatórios",
] as const;

function enviarComProgresso(url: string, arquivo: File, aoAvancar: (pct: number) => void): Promise<{ id: string }> {
  return new Promise((resolver, rejeitar) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", arquivo.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) aoAvancar(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolver(JSON.parse(xhr.responseText) as { id: string });
        } catch {
          rejeitar(new Error("resposta ilegível do Google"));
        }
      } else rejeitar(new Error(`o Google respondeu ${xhr.status}`));
    };
    xhr.onerror = () => rejeitar(new Error("conexão interrompida"));
    xhr.send(arquivo);
  });
}

export function EnvioParaODrive({
  clienteId,
  tarefaId,
  subpastaInicial = "05 Captações",
  aoTerminar,
}: {
  clienteId: string;
  tarefaId: string | null;
  subpastaInicial?: (typeof SUBPASTAS)[number];
  /** Recebe os links dos arquivos enviados, na ordem. */
  aoTerminar?: (links: string[]) => void;
}) {
  const entrada = useRef<HTMLInputElement>(null);
  const [subpasta, setSubpasta] = useState<string>(subpastaInicial);
  const [estado, setEstado] = useState<{ tipo: "parado" } | { tipo: "enviando"; nome: string; pct: number } | { tipo: "erro"; texto: string } | { tipo: "ok"; texto: string }>({
    tipo: "parado",
  });

  async function enviar(arquivos: FileList | null) {
    if (!arquivos || arquivos.length === 0) return;
    const links: string[] = [];
    for (const arquivo of Array.from(arquivos)) {
      setEstado({ tipo: "enviando", nome: arquivo.name, pct: 0 });
      const sessao = await iniciarEnvioDeArquivo({
        clienteId,
        tarefaId,
        subpasta,
        nome: arquivo.name,
        mime: arquivo.type || "application/octet-stream",
        tamanho: arquivo.size,
      });
      if (!sessao.ok) {
        setEstado({ tipo: "erro", texto: sessao.erro });
        return;
      }
      try {
        const subido = await enviarComProgresso(sessao.dados.urlDeEnvio, arquivo, (pct) =>
          setEstado({ tipo: "enviando", nome: arquivo.name, pct }),
        );
        const conf = await confirmarEnvioDeArquivo({ clienteId, tarefaId, subpasta, driveFileId: subido.id });
        if (!conf.ok) {
          setEstado({ tipo: "erro", texto: conf.erro });
          return;
        }
        links.push(conf.dados.link);
      } catch (e) {
        setEstado({ tipo: "erro", texto: `O envio de ${arquivo.name} falhou: ${e instanceof Error ? e.message : "erro"}.` });
        return;
      }
    }
    setEstado({ tipo: "ok", texto: "Enviado para o Google Drive." });
    if (entrada.current) entrada.current.value = "";
    aoTerminar?.(links);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Subpasta do Drive"
          value={subpasta}
          onChange={(e) => setSubpasta(e.target.value)}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          {SUBPASTAS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input ref={entrada} type="file" multiple className="hidden" onChange={(e) => void enviar(e.target.files)} />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={estado.tipo === "enviando"}
          onClick={() => entrada.current?.click()}
        >
          Enviar arquivo
        </Button>
      </div>
      {estado.tipo === "enviando" && (
        <div className="space-y-1" role="status">
          <p className="truncate text-xs text-muted-foreground">
            Enviando {estado.nome}… {estado.pct}%
          </p>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-primary transition-all" style={{ width: `${estado.pct}%` }} />
          </div>
        </div>
      )}
      {estado.tipo === "erro" && (
        <p role="alert" className="text-xs text-destructive">
          {estado.texto}
        </p>
      )}
      {estado.tipo === "ok" && (
        <p role="status" className="text-xs text-muted-foreground">
          {estado.texto}
        </p>
      )}
    </div>
  );
}
