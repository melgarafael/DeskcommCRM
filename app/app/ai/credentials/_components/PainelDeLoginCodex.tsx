"use client";

import { useState, useTransition } from "react";

import {
  conectarLoginCodex,
  desconectarLoginCodexAgora,
} from "@/app/actions/settings/conectarLoginCodex";
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
 * O PAINEL DE LOGIN DO CODEX — o link, o campo de colagem, o aviso e o estado
 * da conta DESTE empresa.
 *
 * ─── Por que ele mora em Credenciais e não mais em /admin/sistema ──────────
 *
 * A decisão do mantenedor (PR #1672) foi "uma conta ChatGPT por empresa": o
 * interruptor continua sendo o da instalação, em `/admin/sistema`, mas quem
 * CONECTA é o admin da empresa, no mesmo lugar onde ela já guarda as outras
 * credenciais de IA. Quem revende escolhe se conecta a conta dele em cada
 * empresa ou deixa o cliente conectar a dele — e o caminho do revendedor é o
 * modo suporte `full`, que já resolve como admin da empresa.
 *
 * ─── O aviso é longo de propósito ──────────────────────────────────────────
 *
 * As três frases são as que alguém só descobre depois de quebrar: o
 * `client_id` e o `redirect_uri` são do Codex e não nossos; nada ali é
 * contrato público da OpenAI; o recurso nasce DESLIGADO (o interruptor é da
 * instalação); e a reserva de chamada continua sendo a chave de API da
 * organização.
 */
export function PainelDeLoginCodex({
  url,
  codeVerifier,
  conectado,
  validada,
}: {
  url: string;
  codeVerifier: string;
  /** Há linha de login nesta empresa? Vem do servidor, já filtrado por módulo. */
  conectado: boolean;
  /** `validated_at` preenchido — a troca (ou a renovação) provou o login. */
  validada: boolean;
}) {
  const t = useT();
  const [codigo, setCodigo] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [conectouAgora, setConectouAgora] = useState(false);
  const [pendente, startTransition] = useTransition();

  /** As falhas que as actions devolvem — na voz de quem opera a VPS. */
  const NOSSAS_MENSAGENS: Record<string, string> = {
    invalid_input:
      "O código colado não tem cara de código. Cole o endereço inteiro que o navegador mostrou.",
    troca_recusada:
      "A OpenAI recusou o código. Ele é de uso único: gere o link de novo e cole o código novo.",
    cifragem:
      "Este servidor não tem a chave de cifra (AI_CRED_AES_KEY) configurada, então o login não pode ser guardado.",
    banco: "O banco recusou a gravação. Tente de novo em instantes.",
    modulo_desligado:
      "O recurso está desligado nesta instalação. Só quem administra a instalação pode ligá-lo, em Recursos opcionais.",
    forbidden_role: "Somente o administrador desta empresa pode conectar a conta.",
    forbidden_tenant: "Você não tem uma empresa ativa para gravar esta conta.",
    unauthenticated: "Sessão expirada. Entre de novo.",
    somente_leitura: "Acompanhamento somente leitura ou encerrado.",
    retorno_sem_estado:
      "Cole o endereço inteiro da barra do navegador (começa com http://localhost:1455/auth/callback), não só o código.",
    estado_invalido:
      "Este endereço não veio do link desta tela, aberto por você nesta empresa — ou o link venceu (vale 10 minutos). Recarregue a página, abra o link de novo e cole o endereço novo.",
  };

  function conectar() {
    setErro(null);
    const limpo = codigo.trim();
    startTransition(async () => {
      const r = await conectarLoginCodex({ codigo: limpo, codeVerifier });
      if (r.ok) {
        setConectouAgora(true);
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

  function desconectar() {
    setErro(null);
    startTransition(async () => {
      const r = await desconectarLoginCodexAgora();
      if (r.ok) {
        setConectouAgora(false);
        return;
      }
      setErro(t(NOSSAS_MENSAGENS[r.error] ?? "Não deu para desconectar. Tente de novo em instantes."));
    });
  }

  const jaConectado = (conectado && !conectouAgora) || conectouAgora;

  return (
    <Card data-testid="painel-login-codex">
      <CardHeader>
        <CardTitle>{t("Conectar a assinatura do Codex")}</CardTitle>
        <CardDescription>
          {t(
            "Cada empresa conecta a própria conta do ChatGPT. Abra o link e entre com a conta que tem a assinatura. No fim, o navegador vai para um endereço em localhost:1455 que não abre — é esperado. Copie esse endereço inteiro, da barra do navegador, e cole aqui.",
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
              {t("Endereço em que o navegador parou")}
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
          <Button onClick={conectar} disabled={pendente || codigo.trim() === ""}>
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
                "Este recurso vem desligado por padrão; só quem administra a instalação pode ligá-lo, em Recursos opcionais. Ligado, cada empresa conecta a própria conta aqui.",
              )}
            </li>
            <li>
              {t(
                "Se a assinatura falhar, a chamada cai na reserva: a chave de API da organização, como sempre.",
              )}
            </li>
          </ul>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-lg border p-4 text-sm">
          <p data-testid="estado-login-codex">
            {jaConectado
              ? t(
                  "Conta conectada nesta empresa, guardada com cifra. O sistema renova o token antes de vencer — na janela de 8 dias, e também na hora em que o sistema acordar.",
                )
              : t("Nenhuma conta conectada nesta empresa ainda.")}
            {jaConectado && !validada && !conectouAgora
              ? ` ${t("Ainda sem validação registrada: gere o link de novo e conecte de novo.")}`
              : ""}
          </p>
          {jaConectado && (
            <Button variant="outline" onClick={desconectar} disabled={pendente}>
              {t("Desconectar")}
            </Button>
          )}
        </div>

        {conectouAgora && (
          <p className="text-sm text-muted-foreground" role="status">
            {t(
              "Login guardado com cifra nesta empresa. A partir de agora o agente fala por esta assinatura; se ela não estiver disponível ou falhar, a chamada cai na chave da empresa.",
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
