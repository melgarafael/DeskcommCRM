"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { criarPastasQueFaltam, desconectarODrive, iniciarConexaoDoDrive } from "@/app/actions/agencia/drive";
import { Button } from "@/components/ui/button";

/**
 * A conexão Google da agência em Configurações (docs/agencia/SPEC-acervo.md e
 * SPEC-calendario.md, K1): uma conta para o Drive e para a Agenda das reuniões.
 * Mostra o estado, conecta, cria as pastas que faltam e explica o
 * pré-requisito do Google Cloud quando a conexão falha por ele.
 */
const RESULTADO: Record<string, { ok: boolean; texto: string }> = {
  conectado: { ok: true, texto: "Google conectado. A pasta Clientes foi criada e compartilhada com a equipe." },
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
  estado: { conectado: boolean; contaEmail: string | null; ultimoErro: string | null; agendaLiberada: boolean };
  enderecoDeRetorno: string;
  resultado: string | null;
}) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(resultado ? (RESULTADO[resultado] ?? null) : null);
  const [pendente, startTransition] = useTransition();

  return (
    <section className="space-y-4 rounded-md border p-4">
      <div className="space-y-1">
        <h2 className="font-semibold">Google da agência (Drive e Agenda)</h2>
        <p className="text-sm text-muted-foreground">
          Cada cliente ganha a pasta dele dentro de "Clientes", com as 8 subpastas, e as reuniões entram na Agenda da mesma conta com o
          link do Meet. A central só enxerga as pastas que ela mesma criou.
        </p>
      </div>

      {estado.conectado ? (
        <div className="space-y-1 text-sm">
          <p>Conectado{estado.contaEmail ? ` como ${estado.contaEmail}` : ""}.</p>
          <p data-testid="estado-da-agenda" className={estado.agendaLiberada ? "text-muted-foreground" : "text-amber-700 dark:text-amber-400"}>
            {estado.agendaLiberada
              ? "Agenda liberada: as reuniões vão para o Google com o link do Meet."
              : "A Agenda ainda não foi liberada. Clique em Reconectar e marque a permissão da Agenda na tela do Google."}
          </p>
        </div>
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
          {estado.conectado ? "Reconectar" : "Conectar Google"}
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
          <li>Em "APIs e serviços › Biblioteca", ative a Google Drive API (a Google Calendar API já está ativa, é a da Agenda).</li>
          <li>Na tela de consentimento OAuth, acrescente os escopos drive.file e calendar.events.</li>
          <li>
            Nas credenciais do app, em "URIs de redirecionamento autorizados", acrescente:
            <code className="mt-1 block break-all rounded-sm bg-background px-2 py-1 text-xs">{enderecoDeRetorno}</code>
          </li>
          <li>Volte aqui e clique em "Conectar Google" com a conta da agência, marcando as permissões do Drive e da Agenda.</li>
        </ol>
      </details>
    </section>
  );
}
