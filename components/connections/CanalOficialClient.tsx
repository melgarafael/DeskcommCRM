"use client";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useConnectOfficialChannel,
  useOfficialChannel,
  useRegistrarWebhookOficial,
  useUpdateOfficialCatalog,
} from "@/hooks/channels/useOfficialChannel";
import { copyToClipboard } from "@/lib/clipboard";
import { useT } from "@/hooks/i18n/useT";
import { ShoppingBag } from "@/lib/ui/icons";
import { ChannelAiAccess } from "./ChannelAiAccess";
import { ParaIntegrar } from "./ParaIntegrar";

/** Campo somente-leitura com botão de copiar — o que o operador cola na Meta. */
function ParaColar({
  rotulo,
  valor,
  semValor,
}: {
  rotulo: string;
  valor: string | null;
  /** O que dizer quando não há valor para mostrar — que nem sempre é "falta configurar". */
  semValor?: React.ReactNode;
}) {
  const t = useT();
  if (!valor) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {rotulo}
        </span>
        {semValor}
      </div>
    );
  }
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

export function CanalOficialClient() {
  const t = useT();
  const { data, isPending } = useOfficialChannel();
  const conectar = useConnectOfficialChannel();
  const registrarWebhook = useRegistrarWebhookOficial();
  const atualizarCatalogo = useUpdateOfficialCatalog();
  const [catalogInput, setCatalogInput] = useState("");
  const [form, setForm] = useState({
    phone_number_id: "",
    waba_id: "",
    token: "",
    catalog_id: "",
  });

  const estado = data?.data;

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    const r = await conectar.mutateAsync(form);
    toast.success(`${t("Conectado:")} ${r.data.displayName} ${r.data.phoneNumber ?? ""}`.trim());
    // O token some do formulário assim que grava — deixá-lo na tela seria mantê-lo
    // em memória do navegador sem motivo, e ele não volta em nenhum GET.
    setForm((f) => ({ ...f, token: "" }));
  }

  if (isPending) return <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>;

  return (
    <div className="flex flex-col gap-4" data-testid="canal-oficial-root">
      {estado?.connected ? (
        <Card className="p-4" data-testid="canal-conectado">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{estado.displayName}</span>
            {estado.phoneNumber ? (
              <Badge variant="outline" className="font-mono text-xs">
                {estado.phoneNumber}
              </Badge>
            ) : null}
            <Badge>{estado.status ?? "—"}</Badge>
            {/* Mostra que o token EXISTE, nunca qual é. */}
            <Badge variant={estado.hasToken ? "outline" : "destructive"}>
              {estado.hasToken ? t("credencial guardada") : t("sem credencial")}
            </Badge>
            {estado.catalogId ? (
              <Badge variant="secondary" className="font-mono text-xs">
                {t("Catálogo Meta:")} {estado.catalogId}
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            WABA <span className="font-mono">{estado.wabaId}</span> · {t("número")}{" "}
            <span className="font-mono">{estado.phoneNumberId}</span>
            {estado.catalogId ? (
              <>
                {" "}· {t("catálogo")}{" "}
                <span className="font-mono">{estado.catalogId}</span>
              </>
            ) : null}
          </p>
        </Card>
      ) : null}

      {estado?.connected ? (
        <Card className="flex flex-col gap-3 p-4 border-primary/20 shadow-sm" data-testid="card-catalogo-meta">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <ShoppingBag className="size-5 text-primary" />
              <div>
                <h2 className="font-medium text-base leading-none">
                  {t("Catálogo de Produtos Meta (Commerce Manager)")}
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("Vincule o catálogo para envio de produtos pelo Inbox e recomendação pelos Agentes de IA.")}
                </p>
              </div>
            </div>
            {estado.catalogId ? (
              <Badge variant="secondary" className="font-mono text-xs text-emerald-600 bg-emerald-50 dark:bg-emerald-950/40">
                {t("Catálogo Ativo:")} {estado.catalogId}
              </Badge>
            ) : (
              <Badge variant="outline" className="text-xs text-amber-600 dark:text-amber-400">
                {t("Nenhum catálogo vinculado")}
              </Badge>
            )}
          </div>

          <div className="mt-2 flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            <div className="relative flex-1 max-w-md">
              <Input
                id="input-catalogo-id"
                value={catalogInput}
                onChange={(e) => setCatalogInput(e.target.value)}
                placeholder={estado.catalogId ?? t("Cole aqui o ID do Catálogo (ex: 28651441394507856)")}
                className="font-mono text-sm"
              />
            </div>
            <Button
              type="button"
              variant="default"
              onClick={async () => {
                const val = catalogInput.trim();
                if (!val) {
                  toast.error(t("Informe o ID do Catálogo"));
                  return;
                }
                await atualizarCatalogo.mutateAsync(val);
                toast.success(t("Catálogo Meta salvo com sucesso!"));
                setCatalogInput("");
              }}
              disabled={atualizarCatalogo.isPending}
            >
              {atualizarCatalogo.isPending ? t("Salvando…") : t("Salvar Catálogo")}
            </Button>
            {estado.catalogId ? (
              <Button
                type="button"
                variant="outline"
                onClick={async () => {
                  await atualizarCatalogo.mutateAsync(null);
                  toast.success(t("Catálogo Meta desvinculado!"));
                  setCatalogInput("");
                }}
                disabled={atualizarCatalogo.isPending}
              >
                {t("Desvincular")}
              </Button>
            ) : null}
          </div>
        </Card>
      ) : null}

      {estado?.channel_session_id && <ChannelAiAccess channelId={estado.channel_session_id} />}

      {estado?.webhook ? (
        <Card className="flex flex-col gap-3 p-4">
          <div>
            <h2 className="font-medium">
              {estado.webhookRegistro?.registrado
                ? t("Webhook registrado pela instalação")
                : t("Cole isto no painel da Meta")}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {estado.webhookRegistro?.registrado ? (
                t(
                  "O CRM apontou o webhook deste número para cá — não é preciso colar nada no painel da Meta. Os valores abaixo ficam para conferência.",
                )
              ) : (
                <>
                  {t("Em")} <strong>WhatsApp → {t("Configuração")}</strong>
                  {t(", na seção de Webhook. Sem esse passo o canal envia, mas")}{" "}
                  <strong>{t("não recebe")}</strong>
                  {t(" — as respostas do cliente não chegam e a janela de 24 horas nunca abre.")}
                </>
              )}
            </p>
          </div>

          {/*
            O aviso só aparece quando o CRM TENTOU registrar e não conseguiu. Nulo
            (banco sem a migration 0311) cai no passo manual acima, que continua
            verdadeiro — a tela nunca diz "registrado" sem ter registrado.
          */}
          {estado.webhookRegistro && !estado.webhookRegistro.registrado ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
              <Badge
                variant="outline"
                className="border-amber-500/60 font-normal text-amber-700 dark:text-amber-400"
              >
                {t("Webhook pendente")}
              </Badge>
              <span className="text-sm">
                {estado.webhookRegistro.erro ?? t("o registro ainda não foi feito")}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => registrarWebhook.mutate()}
                disabled={registrarWebhook.isPending}
              >
                {registrarWebhook.isPending ? t("Tentando…") : t("Tentar de novo")}
              </Button>
            </div>
          ) : null}

          <ParaColar rotulo={t("URL de callback")} valor={estado.webhook.callbackUrl} />
          <ParaColar
            rotulo={t("Token de verificação")}
            valor={estado.webhook.verifyToken}
            semValor={
              // Desde a 0257 o token vive na tela de administração da instalação
              // e é mostrado UMA vez, quando é gerado. Mandar "definir no
              // servidor" quem já cadastrou tudo por lá seria mandá-lo editar um
              // arquivo que ele não precisa abrir — e o valor do arquivo nem é
              // mais o que a Meta precisa receber.
              <span className="flex flex-col items-start gap-1">
                {estado.webhook.verifyTokenOrigem === "instalacao" ? (
                  <span className="text-sm text-muted-foreground" data-testid="token-na-instalacao">
                    {t("Já cadastrado na administração da instalação. Ele aparece uma vez só, quando é gerado — se não foi guardado, quem administra a instalação gera outro em Admin › API Oficial (Meta).")}
                  </span>
                ) : (
                  <span className="text-sm text-destructive" data-testid="token-nao-configurado">
                    {t("Ainda não configurado. Quem administra a instalação cadastra em Admin › API Oficial (Meta), e o token aparece lá pronto para copiar.")}
                  </span>
                )}
                {estado.webhook.configurarEm ? (
                  <Link
                    href={estado.webhook.configurarEm}
                    data-testid="abrir-app-da-meta"
                    className="text-sm font-medium underline underline-offset-2"
                  >
                    {t("Abrir API Oficial (Meta) na administração")}
                  </Link>
                ) : null}
              </span>
            }
          />
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("Campos a assinar")}
            </span>
            <div className="flex flex-wrap gap-1">
              {estado.webhook.fields.map((f) => (
                <Badge key={f} variant="outline" className="font-mono text-xs">
                  {f}
                </Badge>
              ))}
            </div>
          </div>
        </Card>
      ) : null}

      {estado?.connected ? (
        <ParaIntegrar
          campos={[
            { rotulo: t("Endpoint da API"), valor: estado.endpoint ?? null },
            { rotulo: t("ID do número de telefone"), valor: estado.phoneNumberId ?? null },
            { rotulo: t("ID da conta do WhatsApp Business"), valor: estado.wabaId ?? null },
            { rotulo: t("ID do Catálogo Meta"), valor: estado.catalogId ?? null },
          ]}
          ajuda={
            <div className="space-y-1.5">
              <p>
                {t(
                  "O token de acesso é criado no painel da Meta: Configurações do Business → Usuários do sistema → gerar token permanente.",
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
              {t("Para operar em dois CRMs ao mesmo tempo, configure o reencaminhamento de mensagens.")}
            </>
          }
        />
      ) : null}

      <Card className="p-4">
        <h2 className="font-medium">
          {estado?.connected ? t("Trocar credencial") : t("Conectar canal oficial")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("Os valores vêm do seu app na Meta (")}
          <strong>WhatsApp → {t("Configuração da API")}</strong>
          {t("). A credencial é")} <strong>{t("validada com a Meta antes de ser gravada")}</strong>
          {t(" — se o número não responder, nada é salvo.")}
        </p>

        <form onSubmit={enviar} className="mt-4 flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pnid">{t("ID do número de telefone")}</Label>
            <Input
              id="pnid"
              value={form.phone_number_id}
              onChange={(e) => setForm((f) => ({ ...f, phone_number_id: e.target.value }))}
              placeholder="1103328999528818"
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="waba">{t("ID da conta do WhatsApp Business")}</Label>
            <Input
              id="waba"
              value={form.waba_id}
              onChange={(e) => setForm((f) => ({ ...f, waba_id: e.target.value }))}
              placeholder="2434045433735175"
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="catid">{t("ID do Catálogo Meta (Commerce Manager)")}</Label>
            <Input
              id="catid"
              value={form.catalog_id}
              onChange={(e) => setForm((f) => ({ ...f, catalog_id: e.target.value }))}
              placeholder={estado?.catalogId ?? t("Opcional — ex: 1234567890")}
            />
            <span className="text-xs text-muted-foreground">
              {t("ID do catálogo para envio e recebimento de produtos interativos no WhatsApp.")}
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tok">{t("Token de acesso")}</Label>
            <Input
              id="tok"
              type="password"
              value={form.token}
              onChange={(e) => setForm((f) => ({ ...f, token: e.target.value }))}
              placeholder={
                estado?.hasToken ? t("•••• (já guardado — preencha para trocar)") : "EAAG…"
              }
              required
            />
            <span className="text-xs text-muted-foreground">
              {t("Guardado cifrado. Não é exibido de volta em nenhum momento.")}
            </span>
          </div>
          <Button type="submit" disabled={conectar.isPending} data-testid="btn-conectar">
            {conectar.isPending ? t("Validando com a Meta…") : t("Validar e conectar")}
          </Button>
        </form>
      </Card>
    </div>
  );
}
