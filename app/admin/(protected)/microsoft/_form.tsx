"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { updateMicrosoftOAuth } from "@/app/actions/settings/updateMicrosoftOAuth";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { MENSAGEM_DA_RECUSA_DE_ESCRITA, ehRecusaDeEscrita } from "@/lib/auth/recusa-de-escrita-de-admin";

interface Props {
  readonly clientIdSalvo: string | null;
  readonly diretorioSalvo: string | null;
  /** SE existe segredo gravado — nunca qual. */
  readonly temSegredoSalvo: boolean;
  readonly enderecoDeRetorno: string;
}

export function FormularioDaMicrosoft({
  clientIdSalvo,
  diretorioSalvo,
  temSegredoSalvo,
  enderecoDeRetorno,
}: Props) {
  const t = useT();
  const router = useRouter();
  const [clientId, setClientId] = useState(clientIdSalvo ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [diretorio, setDiretorio] = useState(diretorioSalvo ?? "");
  const [salvando, iniciar] = useTransition();
  const podeSalvar = clientId.trim().length >= 36 && (temSegredoSalvo || clientSecret.trim().length >= 10);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Agenda do Outlook desta instalação")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("Cadastre aqui o aplicativo registrado no Microsoft Entra ID. Depois, cada pessoa conecta a própria conta na Agenda, e o horário ocupado no Outlook deixa de ser oferecido no CRM.")}
        </p>
      </header>

      <Card className="flex flex-col gap-4 p-4">
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          <li>{t("No portal do Microsoft Entra, abra Registros de aplicativo e crie um registro.")}</li>
          <li>{t("Em tipos de conta, aceite contas de qualquer diretório e contas pessoais, ou só o seu diretório.")}</li>
          <li>{t("Em Autenticação, adicione a plataforma Web com o endereço de retorno abaixo.")}</li>
          <li>{t("Em Permissões de API, adicione as permissões delegadas User.Read, Calendars.Read e offline_access.")}</li>
          <li>{t("Em Certificados e segredos, crie um segredo do cliente e copie o Valor.")}</li>
        </ol>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="redirect">{t("Endereço de retorno")}</Label>
          <Input id="redirect" readOnly value={enderecoDeRetorno} data-testid="microsoft-redirect" />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="client-id">{t("ID do aplicativo (cliente)")}</Label>
          <Input
            id="client-id"
            data-testid="microsoft-client-id"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="00000000-0000-0000-0000-000000000000"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="client-secret">{t("Valor do segredo do cliente")}</Label>
          <Input
            id="client-secret"
            data-testid="microsoft-client-secret"
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {temSegredoSalvo
              ? t("Já existe uma chave cadastrada. Deixe em branco para mantê-la, ou digite uma nova para substituir.")
              : t("Ela é guardada cifrada e nunca volta a aparecer nesta tela.")}
          </p>
          <p className="text-xs text-warning">
            {t("O segredo da Microsoft vence. Anote a data e troque antes, senão as agendas param de atualizar.")}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="tenant">{t("ID do diretório (opcional)")}</Label>
          <Input id="tenant" data-testid="microsoft-tenant" value={diretorio} onChange={(e) => setDiretorio(e.target.value)} />
          <p className="text-xs text-muted-foreground">
            {t("Deixe em branco para aceitar contas de qualquer empresa e contas pessoais. Preencha se o aplicativo é só do seu diretório.")}
          </p>
        </div>

        <div className="flex justify-end">
          <Button
            data-testid="microsoft-salvar"
            disabled={!podeSalvar || salvando}
            onClick={() =>
              iniciar(async () => {
                const r = await updateMicrosoftOAuth({
                  client_id: clientId.trim(),
                  tenant: diretorio.trim(),
                  ...(clientSecret.trim() ? { client_secret: clientSecret.trim() } : {}),
                });
                if (!r.ok) {
                  toast.error(t(ehRecusaDeEscrita(r.error) ? MENSAGEM_DA_RECUSA_DE_ESCRITA[r.error] : r.error));
                  return;
                }
                toast.success(t("Credenciais da Microsoft salvas."));
                setClientSecret("");
                router.refresh();
              })
            }
          >
            {salvando ? t("Salvando…") : t("Salvar")}
          </Button>
        </div>
      </Card>
    </div>
  );
}
