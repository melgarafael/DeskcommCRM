"use client";

import { useState, useTransition, type FormEvent } from "react";
import { Check, CircleAlert, LoaderCircle, LockKeyhole, Mail, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";

import { connectHostingerEmail } from "@/app/actions/settings/connectHostingerEmail";
import { disconnectHostingerEmail } from "@/app/actions/settings/disconnectHostingerEmail";
import { setHostingerEmailAutomationEnabled } from "@/app/actions/settings/setHostingerEmailAutomation";
import { setHostingerEmailInboxSyncEnabled } from "@/app/actions/settings/setHostingerEmailInboxSync";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

interface ConnectionInfo {
  mailbox_email: string;
  status: "disconnected" | "healthy" | "error";
  outbound_automation_enabled: boolean;
  inbox_sync_enabled: boolean;
  last_sync_at: string | null;
  last_error_code: string | null;
}

interface Props {
  connection: ConnectionInfo | null;
  stateUnavailable: boolean;
}

type ConnectionError =
  | "validation_failed"
  | "unauthenticated"
  | "forbidden"
  | "mfa_required"
  | "authentication_failed"
  | "connection_failed"
  | "mailbox_unavailable"
  | "encryption_unavailable"
  | "database_error";

type DisconnectError = "unauthenticated" | "forbidden" | "mfa_required" | "database_error";
type AutomationSettingError =
  | "validation_failed"
  | "unauthenticated"
  | "forbidden"
  | "mfa_required"
  | "connection_unavailable"
  | "database_error";

const MENSAGENS: Record<ConnectionError, string> = {
  validation_failed: "Confira o endereço e informe a senha da caixa.",
  unauthenticated: "Sua sessão terminou. Entre novamente para conectar a caixa.",
  forbidden: "Somente um administrador da empresa pode conectar esta caixa.",
  mfa_required: "Confirme sua verificação em duas etapas e tente novamente.",
  authentication_failed: "A Hostinger recusou o acesso. Confira o e-mail e a senha da caixa.",
  connection_failed: "Não foi possível alcançar os serviços de e-mail da Hostinger agora.",
  mailbox_unavailable: "O acesso funcionou, mas a pasta de entrada não está disponível.",
  encryption_unavailable: "A proteção de segredos desta instalação não está disponível; nada foi salvo.",
  database_error: "Não foi possível salvar a conexão. Tente novamente em instantes.",
};
type InboxSettingError = AutomationSettingError;

const MENSAGENS_DESCONEXAO: Record<DisconnectError, string> = {
  unauthenticated: "Sua sessão terminou. Entre novamente para desconectar a caixa.",
  forbidden: "Somente um administrador da empresa pode desconectar esta caixa.",
  mfa_required: "Confirme sua verificação em duas etapas e tente novamente.",
  database_error: "Não foi possível remover a conexão. Tente novamente em instantes.",
};

const MENSAGENS_AUTOMACAO: Record<AutomationSettingError, string> = {
  validation_failed: "Não foi possível aplicar esta opção. Atualize a página e tente novamente.",
  unauthenticated: "Sua sessão terminou. Entre novamente para alterar esta opção.",
  forbidden: "Somente um administrador da empresa pode alterar esta opção.",
  mfa_required: "Confirme sua verificação em duas etapas e tente novamente.",
  connection_unavailable: "Conecte e verifique a caixa antes de ativar os envios.",
  database_error: "Não foi possível salvar a opção. Tente novamente.",
};

const MENSAGENS_ENTRADA: Record<InboxSettingError, string> = {
  ...MENSAGENS_AUTOMACAO,
};

export function EmailChannelSettings({ connection, stateUnavailable }: Props) {
  const router = useRouter();
  const [email, setEmail] = useState(connection?.mailbox_email ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const [automationError, setAutomationError] = useState<string | null>(null);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [outboundEnabled, setOutboundEnabled] = useState(
    connection?.outbound_automation_enabled ?? false,
  );
  const [inboxEnabled, setInboxEnabled] = useState(connection?.inbox_sync_enabled ?? false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [connectionStored, setConnectionStored] = useState(Boolean(connection));
  const [savedEmail, setSavedEmail] = useState(
    connection?.mailbox_email ?? null,
  );
  const [isPending, startTransition] = useTransition();
  const connectionMatchesEmail =
    !!savedEmail && savedEmail.toLowerCase() === email.trim().toLowerCase();
  const connectionHealthy = connectionMatchesEmail && connection?.status === "healthy";

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        const result = await connectHostingerEmail({ email, password });
        if (!result.ok) {
          setError(MENSAGENS[result.error]);
          return;
        }
        setEmail(result.email);
        setSavedEmail(result.email);
        setOutboundEnabled(result.outboundAutomationEnabled);
        setInboxEnabled(result.inboxSyncEnabled);
        setConnectionStored(true);
        router.refresh();
      } catch {
        setError(MENSAGENS.connection_failed);
      } finally {
        setPassword("");
      }
    });
  }

  function toggleAutomationSending(enabled: boolean) {
    setAutomationError(null);
    startTransition(async () => {
      try {
        const result = await setHostingerEmailAutomationEnabled(enabled);
        if (!result.ok) {
          setAutomationError(MENSAGENS_AUTOMACAO[result.error]);
          return;
        }
        setOutboundEnabled(result.enabled);
      } catch {
        setAutomationError(MENSAGENS_AUTOMACAO.database_error);
      }
    });
  }

  function toggleInboxSync(enabled: boolean) {
    setInboxError(null);
    startTransition(async () => {
      try {
        const result = await setHostingerEmailInboxSyncEnabled(enabled);
        if (!result.ok) {
          setInboxError(MENSAGENS_ENTRADA[result.error]);
          return;
        }
        setInboxEnabled(result.enabled);
        router.refresh();
      } catch {
        setInboxError(MENSAGENS_ENTRADA.database_error);
      }
    });
  }

  function disconnect() {
    setDisconnectError(null);
    startTransition(async () => {
      try {
        const result = await disconnectHostingerEmail();
        if (!result.ok) {
          setDisconnectError(MENSAGENS_DESCONEXAO[result.error]);
          return;
        }
        setConnectionStored(false);
        setSavedEmail(null);
        setEmail("");
        setPassword("");
        setDisconnectOpen(false);
        router.refresh();
      } catch {
        setDisconnectError(MENSAGENS_DESCONEXAO.database_error);
      }
    });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(18rem,0.8fr)]">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="rounded-md border border-border bg-surface p-2 text-muted-foreground">
              <Mail aria-hidden="true" size={20} />
            </div>
            <div>
              <CardTitle>Caixa da empresa</CardTitle>
              <CardDescription>Hostinger · entrada e saída protegidas por TLS</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {stateUnavailable ? (
            <div
              role="alert"
              className="mb-4 flex gap-3 rounded-md border border-warning/40 bg-warning-bg p-3 text-sm text-warning-fg"
            >
              <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <p>Não foi possível confirmar o estado salvo da caixa. Atualize a página antes de alterar a conexão.</p>
            </div>
          ) : null}
          <form className="space-y-4" onSubmit={submit}>
            <div className="space-y-2">
              <Label htmlFor="hostinger-email">Endereço de e-mail</Label>
              <Input
                id="hostinger-email"
                type="email"
                autoComplete="username"
                maxLength={254}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="hostinger-password">Senha da caixa</Label>
              <Input
                id="hostinger-password"
                type="password"
                autoComplete="off"
                maxLength={1_024}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
              <p className="text-xs text-muted-foreground">
                A senha é verificada e guardada cifrada. Ela nunca volta a aparecer nesta tela.
              </p>
            </div>

            {error ? (
              <div
                role="alert"
                className="flex gap-3 rounded-md border border-error/40 bg-error-bg p-3 text-sm text-error-fg"
              >
                <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                <div>
                  <p className="font-medium">Não foi possível conectar</p>
                  <p className="mt-1">{error}</p>
                </div>
              </div>
            ) : null}

            {connectionHealthy && !error ? (
              <div
                role="status"
                className="flex gap-3 rounded-md border border-success/40 bg-success-bg p-3 text-sm text-success-fg"
              >
                <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                <div>
                  <p className="font-medium">Caixa autenticada</p>
                  <p className="mt-1">
                    {savedEmail} passou na verificação de entrada e saída. Use os controles abaixo para liberar a leitura de mensagens novas e, separadamente, os envios automáticos da Zoe.
                  </p>
                </div>
              </div>
            ) : null}
            {savedEmail && !connectionHealthy && !error ? (
              <div
                role="status"
                className="flex gap-3 rounded-md border border-warning/40 bg-warning-bg p-3 text-sm text-warning-fg"
              >
                <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                <div>
                  <p className="font-medium">
                    {connectionMatchesEmail ? "Conexão indisponível" : "Alteração pendente"}
                  </p>
                  <p className="mt-1">
                    {connectionMatchesEmail
                      ? `A caixa ${savedEmail} está salva, mas precisa ser verificada novamente. As automações ficam bloqueadas até a conexão voltar.`
                      : `O endereço salvo é ${savedEmail}. Verifique e salve o novo endereço antes de usá-lo.`}
                  </p>
                </div>
              </div>
            ) : null}

            <Button type="submit" disabled={stateUnavailable || isPending || !email || !password}>
              {isPending ? (
                <>
                  <LoaderCircle aria-hidden="true" className="animate-spin" />
                  Verificando acesso...
                </>
              ) : (
                <>
                  <RefreshCw aria-hidden="true" />
                  Verificar e salvar
                </>
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <LockKeyhole aria-hidden="true" className="text-muted-foreground" size={18} />
            <CardTitle>Estado do canal</CardTitle>
          </div>
          <CardDescription>O teste não envia nem importa mensagens.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Entrada IMAP</span>
            <Badge variant={connectionHealthy ? "success" : connectionMatchesEmail && connection?.status === "error" ? "error" : "secondary"}>
              {connectionHealthy
                ? "Autenticada"
                : connectionMatchesEmail && connection?.status === "error"
                  ? "Falha na conexão"
                  : stateUnavailable
                    ? "Não verificada"
                    : "Não conectada"}
            </Badge>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Acesso SMTP</span>
            <Badge variant={connectionHealthy ? "success" : connectionMatchesEmail && connection?.status === "error" ? "error" : "secondary"}>
              {connectionHealthy
                ? "Verificado"
                : connectionMatchesEmail && connection?.status === "error"
                  ? "Falha na conexão"
                  : stateUnavailable
                    ? "Não verificada"
                    : "Não conectado"}
            </Badge>
          </div>
          {connectionStored && connectionMatchesEmail ? (
            <div className="space-y-3 rounded-md border border-border bg-surface p-3">
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-1">
                  <Label htmlFor="hostinger-inbox-sync" className="font-medium">
                    Receber mensagens e disponibilizar à Zoe
                  </Label>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Importa somente mensagens novas. Se houver um agente ativo neste canal, o conteúdo poderá ser processado pelo provedor de modelo configurado. O histórico anterior não é importado.
                  </p>
                </div>
                <Switch
                  id="hostinger-inbox-sync"
                  checked={inboxEnabled}
                  disabled={stateUnavailable || isPending || (!connectionHealthy && !inboxEnabled)}
                  onCheckedChange={toggleInboxSync}
                  aria-label="Receber mensagens novas e disponibilizar à Zoe"
                />
              </div>
              {inboxError ? <p role="alert" className="text-xs text-error-fg">{inboxError}</p> : null}
              <div className="flex items-center justify-between gap-4 border-t border-border pt-3">
                <div className="space-y-1">
                  <Label htmlFor="hostinger-automation-sending" className="font-medium">
                    Permitir envios automáticos da Zoe
                  </Label>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Desligado por padrão. Ao ativar, respostas da Zoe e regras de automação podem enviar por esta caixa sem pedir aprovação a cada mensagem.
                  </p>
                </div>
                <Switch
                  id="hostinger-automation-sending"
                  checked={outboundEnabled}
                  disabled={stateUnavailable || isPending || (!connectionHealthy && !outboundEnabled)}
                  onCheckedChange={toggleAutomationSending}
                  aria-label="Permitir que a Zoe e as automações enviem pela caixa Hostinger"
                />
              </div>
              {automationError ? (
                <p role="alert" className="text-xs text-error-fg">{automationError}</p>
              ) : null}
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Sincronização</span>
            <Badge variant="secondary">
              {stateUnavailable
                ? "Não verificada"
                : !connectionMatchesEmail && connection?.inbox_sync_enabled
                ? "Será desligada ao trocar a caixa"
                : inboxEnabled
                  ? connection?.status === "healthy"
                    ? "Ativada"
                    : "Pausada · conexão indisponível"
                  : "Desligada"}
            </Badge>
          </div>
          {inboxEnabled && connection?.last_sync_at ? (
            <p className="text-xs text-muted-foreground">
              Última sincronização: {new Date(connection.last_sync_at).toLocaleString("pt-BR")}
            </p>
          ) : null}
          {inboxEnabled && connection?.last_error_code ? (
            <p role="status" className="text-xs text-warning-fg">
              A última sincronização sinalizou um problema. As mensagens recebidas continuam seguras na caixa original.
            </p>
          ) : null}
          <p className="border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground">
            Ler a Inbox e autorizar envios automáticos são escolhas separadas. A conexão começa com as duas opções desligadas.
          </p>
          {connectionStored ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
              <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
                Desconectar remove do CRM a senha cifrada e desliga qualquer sincronização futura.
              </p>
              <AlertDialog
                open={disconnectOpen}
                onOpenChange={(open) => {
                  setDisconnectOpen(open);
                  if (open) setDisconnectError(null);
                }}
              >
                <AlertDialogTrigger asChild>
                  <Button type="button" variant="outline" disabled={stateUnavailable || isPending}>
                    Desconectar caixa
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Desconectar {connection?.mailbox_email ?? "esta caixa"}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      A credencial salva será removida e a sincronização ficará desligada. Para reconectar, será necessário informar e verificar a senha novamente.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  {disconnectError ? (
                    <div
                      role="alert"
                      className="rounded-md border border-error/40 bg-error-bg p-3 text-sm text-error-fg"
                    >
                      {disconnectError}
                    </div>
                  ) : null}
                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={isPending}>Manter conectada</AlertDialogCancel>
                    <AlertDialogAction
                      disabled={isPending || stateUnavailable}
                      onClick={(event) => {
                        event.preventDefault();
                        disconnect();
                      }}
                    >
                      {isPending ? "Desconectando…" : "Remover credencial"}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
