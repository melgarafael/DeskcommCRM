"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { criarPastasQueFaltam, desconectarODrive, iniciarConexaoDoDrive } from "@/app/actions/agencia/drive";
import { Button } from "@/components/ui/button";

/**
 * O Google Drive da agência em Configurações (docs/agencia/SPEC-acervo.md).
 * Mostra o estado, conecta, cria as pastas que faltam e explica o
 * pré-requisito do Google Cloud quando a conexão falha por ele.
 */
const RESULTADO: Record<string, { ok: boolean; texto: string }> = {
  conectado: { ok: true, texto: "Google Drive conectado. A pasta Clientes foi criada e compartilhada com a equipe." },
  cancelado: { ok: false, texto: "A conexão foi cancelada na tela do Google." },
  invalido: { ok: false, texto: "A volta do Google não pôde ser verificada. Tente conectar de novo." },
  sem_permissao: { ok: false, texto: "Quem iniciou a conexão não tem permissão para configurar a agência." },
  falhou: { ok: false, texto: "O Google recusou a conexão. Confira o passo a passo abaixo e tente de novo." },
};

export function SecaoDoDrive({
  estado,
  enderecoDeRetorno,
  resultado,
}: {
  estado: { conectado: boolean; contaEmail: string | null; ultimoErro: string | null };
  enderecoDeRetorno: string;
  resultado: string | null;
}) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(resultado ? (RESULTADO[resultado] ?? null) : null);
  const [pendente, startTransition] = useTransition();

  return (
    <section className="space-y-4 rounded-md border p-4">
      <div className="space-y-1">
        <h2 className="font-semibold">Google Drive da agência</h2>
        <p className="text-sm text-muted-foreground">
          Cada cliente ganha a pasta dele dentro de "Clientes", com as 8 subpastas. A central só enxerga as pastas que ela mesma criou.
        </p>
      </div>

      {estado.conectado ? (
        <p className="text-sm">
          Conectado{estado.contaEmail ? ` como ${estado.contaEmail}` : ""}.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">Não conectado.</p>
      )}
      {estado.ultimoErro && (
        <p role="alert" className="text-sm text-destructive">
          {estado.ultimoErro}
        </p>
      )}
      {msg && (
        <p role="status" className={msg.ok ? "text-sm text-muted-foreground" : "text-sm text-destructive"}>
          {msg.texto}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          disabled={pendente}
          onClick={() =>
            startTransition(async () => {
              const r = await iniciarConexaoDoDrive();
              if (r.ok) window.location.href = r.dados.url;
              else setMsg({ ok: false, texto: r.erro });
            })
          }
        >
          {estado.conectado ? "Reconectar" : "Conectar Google Drive"}
        </Button>
        {estado.conectado && (
          <>
            <Button
              variant="outline"
              disabled={pendente}
              onClick={() =>
                startTransition(async () => {
                  setMsg({ ok: true, texto: "Criando as pastas… pode levar um minuto." });
                  const r = await criarPastasQueFaltam();
                  setMsg(
                    r.ok
                      ? { ok: r.dados.falharam === 0, texto: `${r.dados.prontos} cliente(s) com pasta pronta${r.dados.falharam ? `, ${r.dados.falharam} falharam` : ""}.` }
                      : { ok: false, texto: r.erro },
                  );
                  router.refresh();
                })
              }
            >
              Criar pastas que faltam
            </Button>
            <Button
              variant="ghost"
              disabled={pendente}
              onClick={() =>
                startTransition(async () => {
                  if (!window.confirm("Desconectar o Google Drive? As pastas e arquivos continuam no Drive.")) return;
                  const r = await desconectarODrive();
                  setMsg(r.ok ? { ok: true, texto: "Google Drive desconectado." } : { ok: false, texto: r.erro });
                  router.refresh();
                })
              }
            >
              Desconectar
            </Button>
          </>
        )}
      </div>

      <details className="rounded-md bg-muted/40 p-3 text-sm">
        <summary className="cursor-pointer font-medium">Antes de conectar: o passo no Google Cloud</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
          <li>Abra o projeto do Google Cloud do app que a central usa para a Agenda.</li>
          <li>Em "APIs e serviços › Biblioteca", ative a Google Drive API.</li>
          <li>Na tela de consentimento OAuth, acrescente o escopo drive.file.</li>
          <li>
            Nas credenciais do app, em "URIs de redirecionamento autorizados", acrescente:
            <code className="mt-1 block break-all rounded bg-background px-2 py-1 text-xs">{enderecoDeRetorno}</code>
          </li>
          <li>Volte aqui e clique em "Conectar Google Drive" com a conta da agência.</li>
        </ol>
      </details>
    </section>
  );
}
