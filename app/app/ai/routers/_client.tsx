"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter as useNextRouter } from "next/navigation";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Signpost, Plus, Warning } from "@/lib/ui/icons";
import { usePermission } from "@/hooks/auth/AuthProvider";
import { useRouters, useCreateRouter, type RouterListItem } from "@/hooks/ai/useRouters";
import type { ChannelSessionLite } from "../agents/[id]/_components/AgentForm";
import { rotuloDoEstadoDoCanal } from "@/lib/channels/estado";
import { useT } from "@/hooks/i18n/useT";
import type { NumeroSemRoteador } from "./estado-dos-numeros";

interface Props {
  initialState: { routers: RouterListItem[] };
  channelSessions: ChannelSessionLite[];
  /**
   * #4340 — números que recebem conversas e NÃO têm roteador nenhum. A leitura
   * do servidor os calcula (`estado-dos-numeros.ts`); aqui eles ganham o
   * aviso. Antes desta fatia o número novo, depois da troca, não aparecia em
   * lugar nenhum e as conversas dele caíam no agente principal em silêncio.
   */
  numerosSemRoteador?: NumeroSemRoteador[];
}

function channelLabel(
  sessions: ChannelSessionLite[],
  id: string,
  t: (texto: string) => string = (texto) => texto,
): string {
  const s = sessions.find((c) => c.id === id);
  if (!s) return t("Número removido");
  return s.phone_number ? `${s.display_name} · ${s.phone_number}` : s.display_name;
}

export function RoutersClient({ initialState, channelSessions, numerosSemRoteador = [] }: Props) {
  const t = useT();
  const { data } = useRouters(initialState);
  const routers = data?.routers ?? [];
  const canManagePerm = usePermission("ai.routers.manage");
  const [createOpen, setCreateOpen] = React.useState(false);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex sm:justify-end">
        {canManagePerm && (
          <Button onClick={() => setCreateOpen(true)} className="w-full sm:w-auto">
            <Plus /> {t("Novo roteador")}
          </Button>
        )}
      </div>

      {routers.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 p-10 text-center">
          <Signpost size={32} className="text-muted-foreground" aria-hidden />
          <p className="max-w-md text-sm text-muted-foreground">
            {t(
              "Um roteador entende o que o cliente quer e entrega a conversa para o agente certo — um número de vendas fala com quem quer comprar, um de suporte com quem já é cliente, tudo no mesmo WhatsApp. Crie um para o seu número e escolha quais agentes ele aciona.",
            )}
          </p>
          {canManagePerm && (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus /> {t("Criar meu primeiro roteador")}
            </Button>
          )}
        </Card>
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {routers.map((r) => (
            <li key={r.id}>
              <Link href={`/app/ai/routers/${r.id}`}>
                <Card className="flex h-full flex-col gap-2 p-4 transition-colors hover:border-accent">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="truncate font-medium" title={r.name}>
                      {r.name}
                    </h3>
                    <Badge variant={r.is_active ? "success" : "neutral"} className="shrink-0 text-xs">
                      {r.is_active ? t("ativo") : t("inativo")}
                    </Badge>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {channelLabel(channelSessions, r.channel_session_id, t)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {r.member_count === 0
                      ? t("Sem intenções configuradas")
                      : `${r.member_count} ${r.member_count === 1 ? t("intenção") : t("intenções")}`}
                  </p>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {numerosSemRoteador.length > 0 && (
        <Card className="flex flex-col gap-2 border-amber-500/40 bg-amber-500/5 p-4" data-testid="numeros-sem-roteador">
          <p className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
            <Warning size={16} aria-hidden /> {t("Números sem roteador")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t(
              "As conversas destes números caem no agente principal do número — nenhum roteador decide a intenção delas, então elas não aparecem como roteadas. Crie um roteador para cada número que deve escolher o agente pelo que o cliente quer.",
            )}
          </p>
          <ul className="flex flex-col gap-1 text-sm">
            {numerosSemRoteador.map((numero) => (
              <li key={numero.id}>{numero.rotulo}</li>
            ))}
          </ul>
        </Card>
      )}

      <CreateRouterDialog
        key={createOpen ? "open" : "closed"}
        open={createOpen}
        onOpenChange={setCreateOpen}
        channelSessions={channelSessions}
      />
    </div>
  );
}

function CreateRouterDialog({
  open,
  onOpenChange,
  channelSessions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelSessions: ChannelSessionLite[];
}) {
  const t = useT();
  const nextRouter = useNextRouter();
  const create = useCreateRouter();
  const [name, setName] = React.useState("");
  const [channelSessionId, setChannelSessionId] = React.useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    create.mutate(
      { name, channel_session_id: channelSessionId },
      {
        onSuccess: (res) => {
          toast.success(t("Roteador criado — agora escolha as intenções."));
          onOpenChange(false);
          nextRouter.push(`/app/ai/routers/${res.id}`);
        },
        onError: showApiError,
      },
    );
  }

  const valid = name.trim().length > 0 && channelSessionId.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Novo roteador")}</DialogTitle>
          <DialogDescription>
            {t(
              "Escolha o número de WhatsApp que ele vai atender. Depois de criado, você define as intenções e para qual agente cada uma vai.",
            )}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="router-name">{t("Nome")}</Label>
            <Input
              id="router-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("Ex.: Roteador de vendas")}
              maxLength={120}
              autoFocus
              required
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="router-channel">{t("Número de WhatsApp")}</Label>
            <Select value={channelSessionId || undefined} onValueChange={setChannelSessionId}>
              <SelectTrigger id="router-channel">
                <SelectValue placeholder={t("Selecione um número")} />
              </SelectTrigger>
              <SelectContent>
                {channelSessions.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {/* Mesmo JSX do editor de agente, e o mesmo defeito: o
                        estado saía cru. Consertar só um lado deixaria o outro. */}
                    {s.display_name}
                    {s.phone_number ? ` · ${s.phone_number}` : ""} ·{" "}
                    {rotuloDoEstadoDoCanal(s.status, t)}
                  </SelectItem>
                ))}
                {channelSessions.length === 0 ? (
                  <SelectItem value="__none__" disabled>
                    {t("Nenhum número conectado")}
                  </SelectItem>
                ) : null}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t("Só é possível ter um roteador ativo por número.")}
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("Cancelar")}
            </Button>
            <Button type="submit" disabled={!valid || create.isPending}>
              {create.isPending ? t("Criando…") : t("Criar roteador")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
