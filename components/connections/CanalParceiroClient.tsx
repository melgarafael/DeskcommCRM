"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import { copyToClipboard } from "@/lib/clipboard";
import { useT } from "@/hooks/i18n/useT";
import { ChannelAiAccess } from "./ChannelAiAccess";
import { ParaIntegrar } from "./ParaIntegrar";
import { RenomearConexao } from "./RenomearConexao";

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
 * mensagem — quando a instalação não conseguiu registrar o webhook sozinha.
 *
 * ─── Um clique, quando a instalação tem conta no provedor ───────────────────
 *
 * Com `um_clique`, o cliente da instalação não precisa de conta no provedor: o
 * botão abre a página de cadastro da Meta do próprio provedor, e a volta
 * (`/auth/partner-return/…`) traz a conta para cá pela URL. Quem conclui é o
 * SERVIDOR (`acao: "concluir"`), que confere a conta no perfil da organização
 * antes de gravar — a URL sozinha não prova nada. A chave própria continua
 * disponível, um passo abaixo.
 */

interface Estado {
  channel_session_id?: string | null;
  label: string;
  connected: boolean;
  account_id: string | null;
  phone_number: string | null;
  display_name: string | null;
  status: string | null;
  has_api_key: boolean;
  webhook_url: string | null;
  /** Endpoint base do provedor — usado no painel "Para integrar". */
  endpoint: string | null;
  /** A instalação tem conta no provedor: dá para conectar com um clique. */
  um_clique?: boolean;
  /** A conexão atual fala com o provedor pela chave da instalação. */
  pela_instalacao?: boolean;
  /** O webhook foi registrado pela instalação (o da chave própria, ou o único das conexões de um clique). */
  webhook_automatico?: boolean;
}

interface Conectado {
  webhook_url: string;
  /** `null` quando o webhook foi registrado sozinho: não há o que colar. */
  webhook_secret: string | null;
  phone_number: string | null;
  quality_rating: string | null;
  /** A instalação registrou o webhook sozinha: não há nada a colar. */
  webhook_automatico?: boolean;
}

/** O que a volta do provedor deixou na URL — conferido pelo servidor, nunca aqui. */
const PARAMS_DA_VOLTA = [
  "parceiro_estado",
  "parceiro_conta",
  "parceiro_perfil",
  "parceiro_erro",
] as const;

/** Campo somente-leitura com botão de copiar — o que o operador cola do outro lado. */
function ParaColar({ rotulo, valor }: { rotulo: string; valor: string }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {rotulo}
      </span>
      <div className="flex items-center gap-2">
        <code className="flex-1 overflow-x-auto rounded-md bg-muted px-2 py-1.5 text-xs">
          {valor}
        </code>
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
  const router = useRouter();
  const params = useSearchParams();
  const [estado, setEstado] = useState<Estado | null>(null);
  const [accountId, setAccountId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [recemConectado, setRecemConectado] = useState<Conectado | null>(null);
  const [coexistencia, setCoexistencia] = useState(true);
  const [abrindo, setAbrindo] = useState(false);
  const [concluindo, setConcluindo] = useState(false);
  const [usarChavePropria, setUsarChavePropria] = useState(false);
  const voltaTratada = useRef(false);

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

  // A volta do provedor: conclui UMA vez e limpa a URL, para um recarregar da
  // página não tentar concluir de novo com o mesmo estado.
  useEffect(() => {
    const estadoDaVolta = params.get("parceiro_estado");
    if (!estadoDaVolta || voltaTratada.current) return;
    voltaTratada.current = true;
    const corpo = {
      acao: "concluir",
      estado: estadoDaVolta,
      account_id: params.get("parceiro_conta") ?? undefined,
      profile_id: params.get("parceiro_perfil") ?? undefined,
      erro: params.get("parceiro_erro") ?? undefined,
    };
    const limpa = new URLSearchParams(params.toString());
    for (const p of PARAMS_DA_VOLTA) limpa.delete(p);
    router.replace(`?${limpa.toString()}`, { scroll: false });
    setConcluindo(true);
    void (async () => {
      try {
        await apiClient.post("/api/v1/channels/partner/um-clique", corpo);
        toast.success(t("WhatsApp conectado. As mensagens já entram por aqui."));
        await carregar();
      } catch (e) {
        toast.error(e instanceof Error ? t(e.message) : t("Não foi possível conectar."));
      } finally {
        setConcluindo(false);
      }
    })();
  }, [params, router, t]);

  const abrirConexao = async () => {
    setAbrindo(true);
    try {
      const r = await apiClient.post<{ data: { url: string } }>(
        "/api/v1/channels/partner/um-clique",
        {
          acao: "iniciar",
          coexistencia,
        },
      );
      window.location.assign(r.data.url);
    } catch (e) {
      toast.error(e instanceof Error ? t(e.message) : t("Não foi possível abrir a conexão."));
      setAbrindo(false);
    }
  };

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
  const pelaInstalacao = conectado && (estado?.pela_instalacao ?? false);
  // Um clique para quem não conectou, ou para reconectar o que a instalação conectou.
  const mostrarUmClique = (estado?.um_clique ?? false) && (!conectado || pelaInstalacao);
  // A chave própria: sempre sem um clique; com ele, a pedido; e para quem já conectou assim.
  const mostrarChavePropria =
    !(estado?.um_clique ?? false) || usarChavePropria || (conectado && !pelaInstalacao);

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

        {estado?.channel_session_id && <ChannelAiAccess channelId={estado.channel_session_id} />}
        {estado?.channel_session_id && (
          <div>
            <RenomearConexao
              channelId={estado.channel_session_id}
              currentName={estado.display_name}
              onSaved={carregar}
            />
          </div>
        )}
        {concluindo && (
          <p className="text-sm text-muted-foreground" role="status">
            {t("Concluindo a conexão…")}
          </p>
        )}

        {mostrarUmClique && (
          <div className="flex flex-col gap-3 rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium">
                {conectado ? t("Reconectar o WhatsApp") : t("Conectar o WhatsApp com um clique")}
              </p>
              <p className="text-xs text-muted-foreground">
                {t(
                  "Abre a janela da Meta: você entra com o Facebook da empresa, escolhe o número e confirma. Não precisa de conta no provedor, e o webhook fica configurado sozinho.",
                )}
              </p>
            </div>
            <fieldset className="flex flex-col gap-2">
              <legend className="sr-only">{t("Como o número está hoje")}</legend>
              <label className="flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="parceiro-coexistencia"
                  className="mt-1"
                  checked={coexistencia}
                  onChange={() => setCoexistencia(true)}
                />
                <span>
                  {t("O número já usa o app WhatsApp Business")}
                  <span className="block text-xs text-muted-foreground">
                    {t(
                      "Continua funcionando no celular. A Meta mostra um QR para escanear com o app.",
                    )}
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="parceiro-coexistencia"
                  className="mt-1"
                  checked={!coexistencia}
                  onChange={() => setCoexistencia(false)}
                />
                <span>
                  {t("Número novo, ou que já está na API oficial")}
                  <span className="block text-xs text-muted-foreground">
                    {t("Só pelo CRM, sem o app no celular.")}
                  </span>
                </span>
              </label>
            </fieldset>
            <div>
              <Button onClick={abrirConexao} disabled={abrindo || concluindo}>
                {abrindo
                  ? t("Abrindo…")
                  : conectado
                    ? t("Reconectar meu WhatsApp")
                    : t("Conectar meu WhatsApp")}
              </Button>
            </div>
            {!conectado && !usarChavePropria && (
              <button
                type="button"
                className="self-start text-xs text-muted-foreground underline underline-offset-4"
                onClick={() => setUsarChavePropria(true)}
              >
                {t("Já tenho conta no")} {rotulo}
                {t(": usar a minha chave")}
              </button>
            )}
          </div>
        )}

        {mostrarChavePropria && (
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
        )}
      </Card>

      {/* Só depois de conectar: antes disso não há URL nem segredo a mostrar, e
          um passo 2 vazio faz parecer que falta algo que ainda não podia existir. */}
      {recemConectado?.webhook_automatico && (
        <Card className="flex flex-col gap-1 p-4">
          <h3 className="text-sm font-semibold">{t("Webhook configurado")}</h3>
          <p className="text-xs text-muted-foreground">
            {t(
              "A instalação registrou o webhook no provedor: só os eventos deste número chegam a esta organização. Não há nada para colar.",
            )}
          </p>
        </Card>
      )}

      {recemConectado && !recemConectado.webhook_automatico && (
        <Card className="flex flex-col gap-4 border-warning/40 bg-warning-bg p-4">
          <div>
            <h3 className="text-sm font-semibold">{t("Falta ligar a volta")}</h3>
            <p className="text-xs text-muted-foreground">
              {t("Cole os dois valores abaixo no webhook do seu provedor. Sem isso o CRM")}{" "}
              <strong>{t("envia mas não recebe")}</strong>
              {t(": a resposta do cliente não chega, e nada na tela avisa. O segredo aparece")}{" "}
              <strong>{t("uma única vez")}</strong>
              {t(" — se sair desta tela sem copiá-lo, reconecte para gerar outro.")}
            </p>
          </div>
          <ParaColar rotulo={t("URL do webhook")} valor={recemConectado.webhook_url} />
          {recemConectado.webhook_secret && (
            <ParaColar rotulo={t("Segredo (assinatura)")} valor={recemConectado.webhook_secret} />
          )}
          <p className="text-xs text-muted-foreground">
            {t(
              "Na inscrição do webhook no provedor, preencha o filtro de contas (accountIds) com a Conta deste número: assim só chegam aqui os eventos dele.",
            )}
          </p>
          {recemConectado.quality_rating && (
            <p className="text-xs text-muted-foreground">
              {t("Qualidade do número segundo a plataforma:")} {recemConectado.quality_rating}
            </p>
          )}
        </Card>
      )}

      {conectado && !recemConectado && estado?.webhook_automatico && (
        <Card className="flex flex-col gap-1 p-4">
          <h3 className="text-sm font-semibold">Webhook</h3>
          <p className="text-xs text-muted-foreground">
            {t("Configurado automaticamente no provedor: só os eventos deste número chegam aqui.")}
          </p>
        </Card>
      )}

      {conectado && !recemConectado && !estado?.webhook_automatico && estado?.webhook_url && (
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
          <p className="text-xs text-muted-foreground">
            {t(
              "Na inscrição do webhook no provedor, preencha o filtro de contas (accountIds) com a Conta deste número: assim só chegam aqui os eventos dele.",
            )}
          </p>
        </Card>
      )}

      {conectado && !pelaInstalacao ? (
        <ParaIntegrar
          campos={[
            { rotulo: t("Endpoint da API"), valor: estado?.endpoint ?? null },
            { rotulo: t("Conta"), valor: estado?.account_id ?? null },
          ]}
          ajuda={
            <div className="space-y-1.5">
              <p>
                {t(
                  "A chave de API está no painel do provedor, na conta conectada — este CRM não a exibe de volta.",
                )}
              </p>
              <p>
                {t(
                  "O webhook de um número aponta para um só destino. Para os dois CRMs receberem ao mesmo tempo, um deles precisa reencaminhar as mensagens ao outro.",
                )}
              </p>
            </div>
          }
          aviso={
            <>
              {t("Um número tem um único webhook.")}{" "}
              {t(
                "Para operar em dois CRMs ao mesmo tempo, configure o reencaminhamento de mensagens.",
              )}
            </>
          }
        />
      ) : null}
    </div>
  );
}
