"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { copyToClipboard } from "@/lib/clipboard";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export interface TrunkSettingsRow {
  organization_id: string;
  host: string;
  port: number;
  username: string;
  password_last4: string;
  from_domain: string | null;
  endpoint_name: string;
  is_active: boolean;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

const queryKey = ["voip", "trunk"] as const;

function useTrunkSettings(initialData: TrunkSettingsRow | null) {
  return useQuery({
    queryKey,
    queryFn: async () => {
      try {
        const res = await apiClient.get<{ data: TrunkSettingsRow | null }>("/api/v1/voip/trunk");
        return res.data;
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    initialData,
  });
}

interface FormState {
  host: string;
  port: string;
  username: string;
  password: string;
  from_domain: string;
  is_active: boolean;
}

function estadoInicial(row: TrunkSettingsRow | null): FormState {
  return {
    host: row?.host ?? "",
    port: row ? String(row.port) : "5060",
    username: row?.username ?? "",
    password: "",
    from_domain: row?.from_domain ?? "",
    is_active: row?.is_active ?? true,
  };
}

export function TrunkSettingsClient({
  initialData,
  canWrite,
}: {
  initialData: TrunkSettingsRow | null;
  canWrite: boolean;
}) {
  const t = useT();
  const [copiou, setCopiou] = useState<boolean | null>(null);
  const { data: trunk } = useTrunkSettings(initialData);
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(() => estadoInicial(trunk));
  // Guarda o que foi SALVO com sucesso (não o form ao vivo) — sem isto o bloco
  // de cópia mudaria a cada tecla digitada, antes da senha nova existir de
  // verdade no banco. O servidor nunca devolve a senha de volta (nem cifrada);
  // isto é a ÚNICA janela em que o bloco completo (com senha) existe pronto
  // pra colar — o mesmo espírito de "a chave nunca mais aparece depois de
  // salva" da tela de Credenciais de IA.
  const [ultimoSalvo, setUltimoSalvo] = useState<FormState | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        host: form.host,
        port: Number(form.port),
        username: form.username,
        from_domain: form.from_domain || null,
        is_active: form.is_active,
      };
      if (form.password) body.password = form.password;
      const res = await apiClient.put<{ data: TrunkSettingsRow }>("/api/v1/voip/trunk", body);
      return res.data;
    },
    onSuccess: (row) => {
      setUltimoSalvo({ ...form });
      setForm((f) => ({ ...f, password: "" }));
      queryClient.setQueryData(queryKey, row);
    },
    onError: (err) => showApiError(err),
  });

  const blocoParaColar = ultimoSalvo
    ? `[${trunk?.endpoint_name ?? ""}]
type=endpoint
context=from-trunk
disallow=all
allow=ulaw
allow=alaw
outbound_auth=${trunk?.endpoint_name ?? ""}-auth
aors=${trunk?.endpoint_name ?? ""}-aor
from_user=${ultimoSalvo.username}
${ultimoSalvo.from_domain ? `from_domain=${ultimoSalvo.from_domain}` : ""}

[${trunk?.endpoint_name ?? ""}-auth]
type=auth
auth_type=userpass
username=${ultimoSalvo.username}
password=${ultimoSalvo.password || "(senha não alterada nesta sessão — use a já configurada)"}

[${trunk?.endpoint_name ?? ""}-aor]
type=aor
contact=sip:${ultimoSalvo.host}:${ultimoSalvo.port}

[${trunk?.endpoint_name ?? ""}-registration]
type=registration
outbound_auth=${trunk?.endpoint_name ?? ""}-auth
server_uri=sip:${ultimoSalvo.host}:${ultimoSalvo.port}
client_uri=sip:${ultimoSalvo.username}@${ultimoSalvo.host}:${ultimoSalvo.port}
retry_interval=60`
    : null;

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("Provedor SIP")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="host">{t("Host")}</Label>
            <Input
              id="host"
              placeholder="sip.provedor.example"
              value={form.host}
              disabled={!canWrite}
              onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="port">{t("Porta")}</Label>
            <Input
              id="port"
              type="number"
              value={form.port}
              disabled={!canWrite}
              onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="username">{t("Usuário")}</Label>
            <Input
              id="username"
              value={form.username}
              disabled={!canWrite}
              onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">
              {t("Senha")}{" "}
              {trunk ? (
                <span className="text-muted-foreground">
                  ({t("configurada, termina em")} {trunk.password_last4})
                </span>
              ) : null}
            </Label>
            <Input
              id="password"
              type="password"
              placeholder={trunk ? t("Deixe em branco para manter a atual") : ""}
              value={form.password}
              disabled={!canWrite}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="from_domain">{t("From-domain (opcional)")}</Label>
            <Input
              id="from_domain"
              placeholder={t("IP público da VPS, se o provedor exigir")}
              value={form.from_domain}
              disabled={!canWrite}
              onChange={(e) => setForm((f) => ({ ...f, from_domain: e.target.value }))}
            />
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="is_active"
              checked={form.is_active}
              disabled={!canWrite}
              onCheckedChange={(checked) => setForm((f) => ({ ...f, is_active: checked }))}
            />
            <Label htmlFor="is_active">{t("Ativo")}</Label>
          </div>
          {canWrite && (
            <Button onClick={() => mutation.mutate()} disabled={mutation.isPending} className="w-fit">
              {mutation.isPending ? t("Salvando...") : t("Salvar")}
            </Button>
          )}
        </CardContent>
      </Card>

      {blocoParaColar && (
        <Card>
          <CardHeader>
            <CardTitle>{t("Cole em asterisk/pjsip.conf")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              {t(
                "Só aparece agora, logo após salvar — a senha não é guardada em claro, então este bloco completo não pode ser reconstruído depois.",
              )}
            </p>
            <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">{blocoParaColar}</pre>
            {/*
              Sempre `copyToClipboard`, nunca a API do navegador direto: ela só
              existe em contexto seguro, e o self-host servido por http://IP não
              é um — ali o botão não fazia nada, calado. O helper cai para
              textarea + execCommand e devolve se funcionou.
            */}
            <Button
              variant="outline"
              className="w-fit"
              onClick={async () => setCopiou(await copyToClipboard(blocoParaColar))}
            >
              {t(copiou === true ? "Copiado" : "Copiar")}
            </Button>
            {copiou === false && (
              <p role="alert" className="text-sm text-muted-foreground">
                {t("Não consegui copiar. Selecione o bloco acima e copie à mão.")}
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
