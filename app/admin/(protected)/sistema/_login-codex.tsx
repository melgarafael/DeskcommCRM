"use client";

import { useState, useTransition } from "react";

import { conectarLoginCodex } from "@/app/actions/settings/conectarLoginCodex";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import {
  MENSAGEM_DA_RECUSA_DE_ESCRITA,
  ehRecusaDeEscrita,
} from "@/lib/auth/recusa-de-escrita-de-admin";

/**
 * O PAINEL DE LOGIN DO CODEX — o link, o campo de colagem e o aviso.
 *
 * ─── O defeito que ele fecha (issue #1639, fatia do login) ─────────────────
 *
 * O authorize do Codex devolve o navegador para `http://localhost:1455/auth/callback`
 * — endereço da LISTA BRANCA do cliente público do Codex — e ali não há
 * servidor nosso esperando. O código fica na tela de quem abriu o link, e
 * alguém precisa trazê-lo para cá. Colar é o desenho escolhido pelo mantenedor
 * (02/10): sem callback nosso, sem porta aberta, sem segredo de servidor
 * exposto na máquina de quem administra.
 *
 * ─── Por que o aviso é longo ───────────────────────────────────────────────
 *
 * Porque as três frases que ele diz são as que alguém só descobriria depois de
 * quebrar: o `client_id` e o `redirect_uri` são do Codex e não nossos; nada
 * ali é contrato público da OpenAI (pode mudar sem aviso); o recurso nasce
 * DESLIGADO; e a reserva de chamada continua sendo a chave de API da
 * organização. É o mesmo aviso que o mantenedor pediu com todas as letras.
 *
 * O painel não decide nada sozinho: o interruptor é o módulo `login_codex` da
 * mesma tela, e sem ele ligado o link não muda o comportamento de ninguém.
 */
export function PainelDeLoginCodex({ url, codeVerifier }: { url: string; codeVerifier: string }) {
  const t = useT();
  const [codigo, setCodigo] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [conectado, setConectado] = useState(false);
  const [pendente, startTransition] = useTransition();

  /** As falhas que a action devolve — na voz de quem opera a VPS. */
  const NOSSAS_MENSAGENS: Record<string, string> = {
    invalid_input:
      "O código colado não tem cara de código. Cole o endereço inteiro que o navegador mostrou.",
    troca_recusada:
      "A OpenAI recusou o código. Ele é de uso único: gere o link de novo e cole o código novo.",
    cifragem:
      "Este servidor não tem a chave de cifra (AI_CRED_AES_KEY) configurada, então o login não pode ser guardado.",
    banco: "O banco recusou a gravação. Tente de novo em instantes.",
  };

  function conectar() {
    setErro(null);
    const limpo = codigo.trim();
    startTransition(async () => {
      const r = await conectarLoginCodex({ codigo: limpo, codeVerifier });
      if (r.ok) {
        setConectado(true);
        setCodigo("");
        return;
      }
      setErro(
        t(
          ehRecusaDeEscrita(r.error)
            ? MENSAGEM_DA_RECUSA_DE_ESCRITA[r.error]
            : (NOSSAS_MENSAGENS[r.error] ?? "Não deu para conectar. Tente de novo em instantes."),
        ),
      );
    });
  }

  return (
    <Card data-testid="painel-login-codex">
      <CardHeader>
        <CardTitle>{t("Conectar a assinatura do Codex")}</CardTitle>
        <CardDescription>
          {t(
            "Abra o link, entre com a conta que tem a assinatura do Codex, e o navegador fica em localhost:1455 mostrando um código. Cole esse código aqui.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <Label htmlFor="codex-link" className="text-base">
            {t("Link de acesso")}
          </Label>
          <Input id="codex-link" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
        </div>

        <div className="flex items-end gap-3">
          <div className="flex-1 space-y-1">
            <Label htmlFor="codex-codigo" className="text-base">
              {t("Código que o navegador deixou")}
            </Label>
            <Input
              id="codex-codigo"
              value={codigo}
              onChange={(e) => setCodigo(e.target.value)}
              disabled={pendente}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <Button onClick={conectar} disabled={pendente || codigo.trim() === "" || conectado}>
            {t("Conectar")}
          </Button>
        </div>

        <div
          className="space-y-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-4 text-sm"
          data-testid="aviso-login-codex"
        >
          <p className="font-medium">{t("Antes de ligar")}</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              {t(
                "O client_id e o redirect_uri (http://localhost:1455/auth/callback) são os do Codex, não os nossos, e nada disso é contrato público da OpenAI: os dois podem mudar sem aviso.",
              )}
            </li>
            <li>
              {t(
                "Este recurso vem desligado por padrão; só quem administra a instalação pode ligá-lo, em Recursos opcionais.",
              )}
            </li>
            <li>
              {t(
                "Se a assinatura falhar, a chamada cai na reserva: a chave de API da organização, como sempre.",
              )}
            </li>
          </ul>
        </div>

        {conectado && (
          <p className="text-sm text-muted-foreground" role="status">
            {t(
              "Login guardado com cifra. Ligar o caminho do agente é a próxima fatia — enquanto isso, nada muda nas chamadas.",
            )}
          </p>
        )}
        {erro && (
          <p className="text-sm text-destructive" role="alert">
            {erro}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
