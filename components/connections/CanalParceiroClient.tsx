"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import { copyToClipboard } from "@/lib/clipboard";
import { useT } from "@/hooks/i18n/useT";

/**
 * Conectar um número por um PROVEDOR PARCEIRO.
 *
 * ─── Por que a tela não escreve o nome do provedor ──────────────────────────
 *
 * O rótulo vem do servidor (`label`), e não de uma string aqui, porque o
 * `lint:channels` proíbe nomear provider fora de `lib/channels/` — e a razão é
 * anterior ao lint: no dia em que houver um segundo parceiro, esta tela não
 * muda. O que o usuário lê continua sendo a marca que ele contratou.
 *
 * ─── A ordem dos passos é a ordem em que dá errado ──────────────────────────
 *
 * Conectar são DUAS pontas: a chave, que deixa a gente FALAR com o provedor, e
 * o webhook, que deixa o provedor falar com a gente. Quem faz só a primeira
 * consegue enviar e nunca recebe — e o defeito aparece como "o cliente
 * respondeu e não chegou", horas depois, sem nada na tela dizendo por quê.
 *
 * Por isso o segundo passo só aparece DEPOIS de conectar, com a URL e o segredo
 * prontos para copiar, e um aviso explícito de que sem colá-los não entra
 * mensagem.
 */

interface Estado {
  label: string;
  connected: boolean;
  account_id: string | null;
  phone_number: string | null;
  display_name: string | null;
  status: string | null;
  has_api_key: boolean;
  webhook_url: string | null;
}

interface Conectado {
  webhook_url: string;
  webhook_secret: string;
  phone_number: string | null;
  quality_rating: string | null;
}

/** Campo somente-leitura com botão de copiar — o que o operador cola do outro lado. */
function ParaColar({ rotulo, valor }: { rotulo: string; valor: string }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {rotulo}
      </span>
      <div className="flex items-center gap-2">
        <code className="flex-1 overflow-x-auto rounded-md bg-muted px-2 py-1.5 text-xs">{valor}</code>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            await copyToClipboard(valor);
            toast.success(t("Copiado."));
          }}
        >
          {t("Copiar")}
        </Button>
      </div>
    </div>
  );
}

export function CanalParceiroClient() {
  const t = useT();
  const [estado, setEstado] = useState<Estado | null>(null);
  const [accountId, setAccountId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [recemConectado, setRecemConectado] = useState<Conectado | null>(null);

  const carregar = async () => {
    try {
      const r = await apiClient.get<{ data: Estado }>("/api/v1/channels/partner");
      setEstado(r.data);
      if (r.data.account_id) setAccountId(r.data.account_id);
    } catch {
      // Falha de leitura não deve travar a tela: o formulário continua servindo.
      setEstado(null);
    }
  };

  useEffect(() => {
    void carregar();
  }, []);

  const conectar = async () => {
    setSalvando(true);
    try {
      const r = await apiClient.post<{ data: Conectado }>("/api/v1/channels/partner", {
        account_id: accountId,
        api_key: apiKey,
      });
      setRecemConectado(r.data);
      // A chave sai da memória da tela assim que é gravada: ela não volta num
      // GET, e deixá-la no input só cria uma cópia a mais de um segredo.
      setApiKey("");
      toast.success(t("Canal conectado."));
      await carregar();
    } catch (e) {
      toast.error(e instanceof Error ? t(e.message) : t("Não foi possível conectar."));
    } finally {
      setSalvando(false);
    }
  };

  const rotulo = estado?.label ?? t("provedor parceiro");
  const conectado = estado?.connected ?? false;

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">
              {t("Conectar por")} {rotulo}
            </h3>
            <p className="text-xs text-muted-foreground">
              {t(
                "Um número oficial (WhatsApp Business) conectado através do seu provedor. As mensagens entram e saem pelo CRM, e os modelos aprovados são os mesmos da sua conta.",
              )}
            </p>
          </div>
          {conectado ? (
            <Badge variant="secondary">{t("Conectado")}</Badge>
          ) : (
            <Badge variant="outline">{t("Não conectado")}</Badge>
          )}
        </div>

        {conectado && (
          <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
            <p className="font-medium">{estado?.display_name ?? t("Número conectado")}</p>
            <p className="text-xs text-muted-foreground">
              {estado?.phone_number ?? t("sem número informado")} · {estado?.status ?? "—"}
            </p>
          </div>
        )}

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="parceiro-conta">{t("Conta")}</Label>
            <Input
              id="parceiro-conta"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              placeholder={t("id da conta conectada no provedor")}
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              {t("É o identificador do número no painel do provedor — não o da Meta.")}
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="parceiro-chave">{t("Chave de API")}</Label>
            <Input
              id="parceiro-chave"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                estado?.has_api_key ? t("gravada — preencha para trocar") : t("cole a chave")
              }
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              {t(
                "Guardada cifrada. Depois de gravar ela não é mostrada de novo — para trocar, cole a nova.",
              )}
            </p>
          </div>

          <div>
            <Button onClick={conectar} disabled={salvando || !accountId || !apiKey}>
              {salvando ? t("Verificando…") : conectado ? t("Reconectar") : t("Conectar")}
            </Button>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {t("A credencial é testada contra o provedor antes de ser gravada.")}
            </p>
          </div>
        </div>
      </Card>

      {/* Só depois de conectar: antes disso não há URL nem segredo a mostrar, e
          um passo 2 vazio faz parecer que falta algo que ainda não podia existir. */}
      {recemConectado && (
        <Card className="flex flex-col gap-4 border-warning/40 bg-warning-bg p-4">
          <div>
            <h3 className="text-sm font-semibold">{t("Falta ligar a volta")}</h3>
            <p className="text-xs text-muted-foreground">
              {t("Cole os dois valores abaixo no webhook do seu provedor. Sem isso o CRM")}{" "}
              <strong>{t("envia mas não recebe")}</strong>
              {t(
                ": a resposta do cliente não chega, e nada na tela avisa. O segredo aparece",
              )}{" "}
              <strong>{t("uma única vez")}</strong>
              {t(" — se sair desta tela sem copiá-lo, reconecte para gerar outro.")}
            </p>
          </div>
          <ParaColar rotulo={t("URL do webhook")} valor={recemConectado.webhook_url} />
          <ParaColar rotulo={t("Segredo (assinatura)")} valor={recemConectado.webhook_secret} />
          {recemConectado.quality_rating && (
            <p className="text-xs text-muted-foreground">
              {t("Qualidade do número segundo a plataforma:")} {recemConectado.quality_rating}
            </p>
          )}
        </Card>
      )}

      {conectado && !recemConectado && estado?.webhook_url && (
        <Card className="flex flex-col gap-3 p-4">
          <div>
            <h3 className="text-sm font-semibold">Webhook</h3>
            <p className="text-xs text-muted-foreground">
              {t(
                "O endereço que o provedor usa para entregar as mensagens. O segredo não é mostrado de novo — para obter um novo, reconecte.",
              )}
            </p>
          </div>
          <ParaColar rotulo={t("URL do webhook")} valor={estado.webhook_url} />
        </Card>
      )}
    </div>
  );
}
