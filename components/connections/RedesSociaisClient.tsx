"use client";
import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { apiClient } from "@/lib/api/client";
import { canalDesativado } from "@/lib/channels/desativado";
import { useT } from "@/hooks/i18n/useT";
import { ChannelAiAccess } from "./ChannelAiAccess";

type Account = {
  id: string;
  platform: string;
  username: string;
  active: boolean;
  inbox_supported: boolean;
  channel: { id: string; status: string; metadata?: Record<string, unknown> | null } | null;
};
type Orphaned = {
  channel_id: string;
  account_id: string;
  display_name: string | null;
  status: string;
};
type State = {
  label: string;
  configured: boolean;
  networks: { id: string; label: string; inbox: boolean }[];
  accounts: Account[];
  orphaned_channels: Orphaned[];
};
export function RedesSociaisClient() {
  const t = useT();
  const params = useSearchParams();
  const query = useQuery({
    queryKey: ["social-connections"],
    queryFn: async () => (await apiClient.get<{ data: State }>("/api/v1/channels/social")).data,
  });
  const state = query.data;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [profiles, setProfiles] = useState<{ id: string; name: string }[]>([]);
  const [profile, setProfile] = useState("");
  const [platform, setPlatform] = useState("instagram");
  const [editing, setEditing] = useState(false);
  const [health, setHealth] = useState<Record<string, string>>({});
  const [removing, setRemoving] = useState<{ account: Account; removeAccount: boolean } | null>(
    null,
  );
  const [excluding, setExcluding] = useState<Orphaned | null>(null);
  const [confirmandoDesvincular, setConfirmandoDesvincular] = useState(false);
  const load = () => query.refetch();
  async function togglePausado(account: Account) {
    if (!account.channel) return;
    const desligar = !canalDesativado(account.channel.metadata);
    setBusy(account.id);
    setError(null);
    try {
      await apiClient.patch(`/api/v1/channel-sessions/${account.channel.id}/disabled`, {
        disabled: desligar,
      });
      toast.success(t(desligar ? "Canal pausado." : "Canal reativado."));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível mudar o estado do canal.");
    } finally {
      setBusy(null);
    }
  }
  async function excluirOrfao(orfao: Orphaned) {
    setBusy(orfao.channel_id);
    setError(null);
    try {
      // A ação disconnect, não o DELETE de channel-sessions: só ela apaga a
      // assinatura de webhook no provedor (pelo id ou pela URL, #2412). A
      // assinatura é por chave, então sobreviveria à linha e entregaria num 404.
      await apiClient.post("/api/v1/channels/social", {
        action: "disconnect",
        account_id: orfao.account_id,
        remove_account: false,
      });
      toast.success(t("Canal excluído. A lista atualiza sem a linha órfã."));
      setExcluding(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível excluir o canal.");
    } finally {
      setBusy(null);
    }
  }
  async function desvincularPerfil() {
    setBusy("unlink");
    setError(null);
    try {
      await apiClient.post("/api/v1/channels/social", { action: "unlink" });
      toast.success(t("Perfil desvinculado. Dá para vincular outro perfil."));
      setConfirmandoDesvincular(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível desvincular o perfil.");
    } finally {
      setBusy(null);
    }
  }
  async function perform(id: string, body: Record<string, unknown>) {
    setBusy(id);
    setError(null);
    try {
      const result = await apiClient.post<{ data: Record<string, unknown> }>(
        "/api/v1/channels/social",
        body,
      );
      if (body.action === "profiles") {
        const found = result.data.profiles as { id: string; name: string }[];
        setProfiles(found);
        setProfile(found[0]?.id ?? "");
      } else if (body.action === "authorize") {
        window.location.assign(result.data.auth_url as string);
      } else if (body.action === "health") {
        setHealth((current) => ({
          ...current,
          [id]:
            result.data.status === "healthy"
              ? "Conexão verificada"
              : "A conexão precisa de atenção",
        }));
      } else if (body.action === "disconnect") {
        toast.success(
          t(body.remove_account ? "Conta desconectada." : "Conta removida do atendimento."),
        );
        await load();
      } else {
        setKey("");
        setEditing(false);
        toast.success(t("Configuração salva."));
        await load();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível concluir a conexão.");
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t("Redes sociais")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("Conecte suas contas e receba mensagens no atendimento.")} {state?.label}
          </p>
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={!!busy}>
          {t("Atualizar")}
        </Button>
      </div>
      {params.get("error") && (
        <p role="alert" className="rounded-md border p-3 text-sm">
          {t(
            "A autorização não foi concluída. Tente conectar novamente e aceite as permissões necessárias.",
          )}
        </p>
      )}
      {params.get("connected") && (
        <p role="status" className="rounded-md border p-3 text-sm">
          {t(
            "Autorização concluída. Confira a conta na lista e ative o atendimento, quando disponível.",
          )}
        </p>
      )}
      {(error || query.error) && (
        <p
          role="alert"
          className="rounded-md border border-destructive p-3 text-sm text-destructive"
        >
          {t(error ?? query.error?.message ?? "Não foi possível carregar as redes sociais.")}
        </p>
      )}
      {!state && !error && <p role="status">{t("Carregando…")}</p>}
      {(error || query.error) && (
        <Button variant="outline" onClick={() => setEditing(true)}>
          {t("Reconfigurar integração")}
        </Button>
      )}
      {((state && !state.configured) || editing) && (
        <Card className="space-y-4 p-4">
          <h3 className="font-semibold">{t("Vincular o provedor")}</h3>
          <div className="space-y-2">
            <Label htmlFor="social-api-key">{t("Chave de API")}</Label>
            <Input
              id="social-api-key"
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                setProfiles([]);
              }}
            />
            <p className="text-xs text-muted-foreground">
              {t("A chave fica cifrada no servidor e não é exibida novamente.")}
            </p>
            <p className="text-xs text-muted-foreground">
              {t(
                "Salvar atualiza a chave em todos os canais deste perfil, inclusive os arquivados.",
              )}
            </p>
          </div>
          <Button
            disabled={!!busy || key.trim().length < 8}
            onClick={() => void perform("profiles", { action: "profiles", api_key: key.trim() })}
          >
            {t("Buscar perfis")}
          </Button>
          {profiles.length > 0 && (
            <>
              <div className="space-y-2">
                <Label htmlFor="social-profile">{t("Perfil da empresa")}</Label>
                <select
                  id="social-profile"
                  className="w-full rounded-md border bg-background p-2"
                  value={profile}
                  onChange={(e) => setProfile(e.target.value)}
                >
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <Button
                disabled={!!busy || !profile}
                onClick={() =>
                  void perform("configure", {
                    action: "configure",
                    api_key: key.trim(),
                    profile_id: profile,
                  })
                }
              >
                {t("Salvar conexão")}
              </Button>
            </>
          )}
        </Card>
      )}
      {state?.configured && (
        <>
          <Card className="flex flex-wrap items-end gap-3 p-4">
            <div className="min-w-48 flex-1 space-y-2">
              <Label htmlFor="social-network">{t("Conectar uma rede")}</Label>
              <select
                id="social-network"
                className="w-full rounded-md border bg-background p-2"
                value={platform}
                onChange={(e) => setPlatform(e.target.value)}
              >
                {state.networks.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.label}
                  </option>
                ))}
              </select>
            </div>
            <Button
              disabled={!!busy}
              onClick={() => void perform("authorize", { action: "authorize", platform })}
            >
              {busy === "authorize" ? t("Abrindo…") : t("Autorizar conta")}
            </Button>
            <p className="w-full text-xs text-muted-foreground">
              {t(
                "Você autoriza na própria rede e retorna ao CRM. Cada perfil comporta uma conta por rede; use a mesma conta ao reconectar.",
              )}
            </p>
          </Card>
          <div className="grid gap-4 xl:grid-cols-2">
            {state.accounts.map((account) => (
              <Card key={account.id} className="flex flex-col gap-3 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                      {state.networks.find((n) => n.id === account.platform)?.label ??
                        account.platform}
                    </p>
                    <h3 className="font-semibold">{account.username}</h3>
                  </div>
                  <Badge variant={account.active ? "secondary" : "outline"}>
                    {account.active ? t("Vinculada") : t("Reconectar")}
                  </Badge>
                  {account.channel && canalDesativado(account.channel.metadata) && (
                    <Badge variant="neutral">{t("Pausado")}</Badge>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    disabled={!!busy}
                    onClick={() =>
                      void perform(account.id, { action: "health", account_id: account.id })
                    }
                  >
                    {t("Verificar conexão")}
                  </Button>
                  {account.channel && (
                    <Button
                      variant="outline"
                      disabled={!!busy}
                      onClick={() => void togglePausado(account)}
                    >
                      {canalDesativado(account.channel.metadata) ? t("Retomar") : t("Pausar")}
                    </Button>
                  )}
                  {account.inbox_supported &&
                    (!account.channel || account.channel.status !== "WORKING") && (
                      <Button
                        disabled={!!busy || !account.active}
                        onClick={() =>
                          void perform(account.id, { action: "inbox", account_id: account.id })
                        }
                      >
                        {t("Receber no atendimento")}
                      </Button>
                    )}
                  {account.channel && (
                    <Button asChild variant="outline">
                      <Link href="/app/inbox">{t("Abrir atendimento")}</Link>
                    </Button>
                  )}
                  {account.channel && (
                    <Button
                      variant="outline"
                      disabled={!!busy}
                      onClick={() => setRemoving({ account, removeAccount: false })}
                    >
                      {t("Remover do atendimento")}
                    </Button>
                  )}
                  <Button
                    variant="destructive"
                    disabled={!!busy}
                    onClick={() => setRemoving({ account, removeAccount: true })}
                  >
                    {t("Desconectar conta")}
                  </Button>
                </div>
                {health[account.id] && (
                  <p role="status" className="text-sm">
                    {t(health[account.id] ?? "")}
                  </p>
                )}
                {account.channel ? (
                  <>
                    <p className="text-sm">
                      {account.channel.status === "WORKING"
                        ? t("Recebimento configurado. Novas mensagens entram na caixa de entrada.")
                        : t(
                            "O recebimento precisa de atenção. Confira a conexão antes de atender.",
                          )}
                    </p>
                    <ChannelAiAccess channelId={account.channel.id} phoneTesting={false} />
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {account.inbox_supported
                      ? t(
                          "Ative para receber novas conversas. A IA começa pausada para evitar respostas duplicadas com outras automações.",
                        )
                      : t(
                          "Conta disponível no provedor. O atendimento por mensagens desta rede ainda não está integrado ao CRM.",
                        )}
                  </p>
                )}
              </Card>
            ))}
          </div>
          {state.accounts.length === 0 && (
            <p>{t("Nenhuma conta conectada neste perfil. Autorize uma rede para começar.")}</p>
          )}
          {(state.orphaned_channels ?? []).length > 0 && (
            <Card className="space-y-3 border-destructive p-4">
              <h3 className="font-semibold">{t("Canais sem conta no perfil")}</h3>
              <p className="text-sm text-muted-foreground">
                {t(
                  "Estas conexões apontam para contas que saíram do perfil no provedor (por exemplo, conta removida e recriada por lá). Exclua a linha órfã para fechar o aviso.",
                )}
              </p>
              {(state.orphaned_channels ?? []).map((orfao) => (
                <div
                  key={orfao.channel_id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
                >
                  <div>
                    <p className="font-medium">{orfao.display_name ?? orfao.account_id}</p>
                    <p className="text-xs text-muted-foreground">{orfao.status}</p>
                  </div>
                  <Button
                    variant="destructive"
                    disabled={!!busy}
                    onClick={() => setExcluding(orfao)}
                  >
                    {t("Excluir")}
                  </Button>
                </div>
              ))}
            </Card>
          )}
          <AlertDialog open={!!excluding} onOpenChange={(open) => !open && setExcluding(null)}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("Excluir o canal órfão?")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t(
                    "A linha sai da lista e os avisos dela são fechados. As conversas já recebidas continuam no CRM.",
                  )}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
                <AlertDialogAction onClick={() => excluding && void excluirOrfao(excluding)}>
                  {t("Excluir canal")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <div className="flex flex-wrap gap-2 self-start">
            <Button variant="ghost" onClick={() => setEditing(!editing)}>
              {t("Alterar credencial")}
            </Button>
            <Button
              variant="outline"
              disabled={!!busy}
              onClick={() => setConfirmandoDesvincular(true)}
            >
              {t("Desvincular perfil")}
            </Button>
          </div>
          <AlertDialog open={confirmandoDesvincular} onOpenChange={(open) => !open && setConfirmandoDesvincular(false)}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("Desvincular o perfil?")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t(
                    "O perfil sai do CRM. Só funciona sem canais sociais ativos: arquive ou exclua os canais antes. Dá para vincular outro perfil depois.",
                  )}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
                <AlertDialogAction onClick={() => void desvincularPerfil()}>
                  {t("Desvincular")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <AlertDialog open={!!removing} onOpenChange={(open) => !open && setRemoving(null)}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {removing?.removeAccount
                    ? t("Desconectar esta conta?")
                    : t("Remover do atendimento?")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {removing?.removeAccount
                    ? t(
                        "As mensagens param de chegar e a conta sai do provedor. Para usar de novo, será preciso autorizar a conta outra vez. As conversas já recebidas continuam no CRM.",
                      )
                    : t(
                        "As mensagens desta conta param de chegar no atendimento. A conta continua vinculada e pode voltar a receber depois. As conversas já recebidas continuam no CRM.",
                      )}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() =>
                    removing &&
                    void perform(removing.account.id, {
                      action: "disconnect",
                      account_id: removing.account.id,
                      remove_account: removing.removeAccount,
                    })
                  }
                >
                  {removing?.removeAccount ? t("Desconectar") : t("Remover")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </div>
  );
}
