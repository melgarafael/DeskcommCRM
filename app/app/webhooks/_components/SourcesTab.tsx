"use client";
import * as React from "react";
import { formatDistanceToNowStrict } from "date-fns";
import { ptBR } from "date-fns/locale";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PlugsConnected, Plus } from "@/lib/ui/icons";
import { useWebhookSources, type WebhookSourceRow } from "@/hooks/webhooks/useWebhookSources";
import { CreateSourceDialog } from "./CreateSourceDialog";
import { SourceDetail } from "./SourceDetail";

function lastReceivedLabel(iso: string | null): string {
  if (!iso) return "nunca recebeu";
  return `último recebimento ${formatDistanceToNowStrict(new Date(iso), { addSuffix: true, locale: ptBR })}`;
}

export function SourcesTab() {
  const { data, isLoading } = useWebhookSources();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [selected, setSelected] = React.useState<WebhookSourceRow | null>(null);

  const sources = data?.data ?? [];

  if (isLoading) {
    return (
      <div className="grid gap-3 pt-4 sm:grid-cols-2">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (sources.length === 0) {
    return (
      <div className="flex justify-center pt-10">
        <Card className="max-w-md">
          <CardHeader className="items-center text-center">
            <PlugsConnected className="mb-2 h-10 w-10 text-accent" />
            <CardTitle>Conecte sua landing page em 2 minutos</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-center">
            <ol className="space-y-2 text-left text-sm text-muted-foreground">
              <li>1. Crie uma fonte e diga em qual funil o contato entra.</li>
              <li>2. Copie o endereço ou o formulário pronto.</li>
              <li>3. Cole no seu site — cada envio vira um lead aqui dentro.</li>
            </ol>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus /> Criar primeira fonte
            </Button>
          </CardContent>
        </Card>
        <CreateSourceDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={setSelected}
        />
        {selected ? (
          <SourceDetail source={selected} open={!!selected} onOpenChange={() => setSelected(null)} />
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-4 pt-4">
      <div className="flex justify-end">
        <Button onClick={() => setCreateOpen(true)}>
          <Plus /> Nova fonte
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {sources.map((s) => (
          <Card
            key={s.id}
            className="cursor-pointer transition-colors hover:border-accent"
            onClick={() => setSelected(s)}
          >
            <CardHeader className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="truncate">{s.name}</CardTitle>
                <Badge variant={s.is_active ? "success" : "neutral"}>
                  {s.is_active ? "Ativa" : "Pausada"}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {lastReceivedLabel(s.last_received_at)}
              </p>
            </CardHeader>
          </Card>
        ))}
      </div>

      <CreateSourceDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={setSelected} />
      {selected ? (
        <SourceDetail source={selected} open={!!selected} onOpenChange={() => setSelected(null)} />
      ) : null}
    </div>
  );
}
