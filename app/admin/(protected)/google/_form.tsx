"use client";

import { useT } from "@/hooks/i18n/useT";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { updateGoogleOAuth } from "@/app/actions/settings/updateGoogleOAuth";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  readonly clientIdSalvo: string | null;
  /**
   * SE existe segredo gravado — nunca QUAL. Devolver o valor para preencher o
   * campo o vazaria a cada render, para qualquer XSS, para o payload do RSC e
   * para o cache do navegador. Mesma disciplina de `hasToken` em
   * `app/api/v1/channels/official/route.ts`.
   */
  readonly temSegredoSalvo: boolean;
  readonly atualizadoEm: string | null;
  /** O par está no `.env` desta instalação (o piso de rollback). */
  readonly temNoAmbiente: boolean;
  readonly enderecoDeRetorno: string;
}

export function FormularioDoGoogle({
  clientIdSalvo,
  temSegredoSalvo,
  atualizadoEm,
  temNoAmbiente,
  enderecoDeRetorno,
}: Props) {
  const t = useT();
  const router = useRouter();
  const [clientId, setClientId] = useState(clientIdSalvo ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [salvando, iniciar] = useTransition();

  const podeSalvar =
    clientId.trim().length >= 10 &&
    // Sem segredo gravado, ele é OBRIGATÓRIO — salvar só o client id deixaria a
    // instalação com meia credencial, que é indistinguível de nenhuma para o
    // resolvedor e não diz isso a ninguém.
    (temSegredoSalvo || clientSecret.trim().length >= 10);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Google Agenda desta instalação")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("Com estas duas informações, quem atende consegue conectar a agenda pessoal do Google e ver os compromissos do CRM lá. Elas valem para a instalação inteira — cada pessoa conecta a conta dela depois, sozinha.")}
        </p>
      </header>

      <Card className="flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="redirect">{t("Endereço de retorno")}</Label>
          {/*
            O valor que precisa estar registrado no console do Google, pronto
            para copiar. Ele é comparado BYTE A BYTE pelo Google, então digitar à
            mão é a origem clássica do `redirect_uri_mismatch` — um erro que
            aponta para o Google e não para a divergência.
          */}
          <Input id="redirect" readOnly value={enderecoDeRetorno} data-testid="google-redirect" />
          <p className="text-xs text-muted-foreground">
            Cole exatamente isto em &ldquo;URIs de redirecionamento autorizados&rdquo;, na tela
            de credenciais do Google Cloud.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="client-id">ID do cliente</Label>
          <Input
            id="client-id"
            data-testid="google-client-id"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="000000000000-xxxxxxxx.apps.googleusercontent.com"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="client-secret">{t("Chave secreta do cliente")}</Label>
          <Input
            id="client-secret"
            data-testid="google-client-secret"
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={temSegredoSalvo ? "••••••••  (já cadastrada)" : "GOCSPX-…"}
          />
          <p className="text-xs text-muted-foreground">
            {temSegredoSalvo
              ? t("Já existe uma chave cadastrada. Deixe em branco para mantê-la, ou digite uma nova para substituir.")
              : t("Ela é guardada cifrada e nunca volta a aparecer nesta tela.")}
          </p>
        </div>

        {/*
          ONDE ESTÁ O QUE VALE. Sem isto, quem tem o par no `.env` abre a tela
          vazia e conclui que não há nada configurado — e a precedência (banco
          primeiro, `.env` como piso) fica invisível justamente para quem precisa
          entendê-la ao salvar.
        */}
        {temNoAmbiente ? (
          <p
            data-testid="google-tem-no-ambiente"
            className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground"
          >
            {t("Esta instalação já tem as credenciais no arquivo de configuração do servidor. O que você salvar aqui passa a valer no lugar delas; apagar o que está aqui faz o sistema voltar a usar as do arquivo.")}
          </p>
        ) : null}

        <p className="rounded-md border border-warning/40 bg-warning-bg p-3 text-xs leading-4 text-text-muted">
          {/*
            O efeito colateral que ninguém antecipa: trocar o client id ou a
            chave invalida os refresh tokens que o Google já emitiu para esta
            instalação. Toda conexão existente cai em `token_expired` no próximo
            passe do cron e exige reconexão manual. É comportamento do Google, e
            silencioso se a tela não avisar.
          */}
          <strong className="font-semibold text-text">{t("Ao trocar uma credencial já em uso:")}</strong>{" "}
          {t("quem já conectou a agenda vai precisar conectar de novo. O Google invalida as autorizações antigas quando o aplicativo muda — não há como evitar, e ninguém perde compromisso por isso.")}
        </p>

        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            {atualizadoEm ? `Última alteração em ${atualizadoEm}.` : t("Nunca configurado por aqui.")}
          </span>
          <Button
            data-testid="google-salvar"
            disabled={!podeSalvar || salvando}
            onClick={() =>
              iniciar(async () => {
                const r = await updateGoogleOAuth({
                  client_id: clientId.trim(),
                  // Campo vazio = "mantenha o que está gravado". Mandar string
                  // vazia faria o Zod recusar e a tela culpar quem só queria
                  // corrigir o id.
                  ...(clientSecret.trim() ? { client_secret: clientSecret.trim() } : {}),
                });
                if (!r.ok) {
                  toast.error(t(r.error));
                  return;
                }
                toast.success(t("Credenciais do Google salvas."));
                setClientSecret("");
                router.refresh();
              })
            }
          >
            {salvando ? "Salvando…" : "Salvar"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
