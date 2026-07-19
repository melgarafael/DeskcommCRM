"use client";
import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { formatDistanceToNowStrict } from "date-fns";
import { ptBR } from "date-fns/locale";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
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
import { Copy, Trash, CaretDown } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import {
  useDeleteWebhookSource,
  useUpdateWebhookSource,
  useWebhookSourceEvents,
  type WebhookSourceRow,
} from "@/hooks/webhooks/useWebhookSources";

interface Props {
  source: WebhookSourceRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function publicUrl(pathToken: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "";
  return `${base}/api/v1/webhooks/in/${pathToken}`;
}

function formSnippet(url: string): string {
  return `<form action="${url}" method="POST">
  <input name="nome" placeholder="Seu nome" required />
  <input name="telefone" placeholder="Seu WhatsApp" required />
  <input name="email" type="email" placeholder="Seu e-mail" />
  <button type="submit">Quero receber contato</button>
</form>`;
}

function curlSnippet(url: string): string {
  return `curl -X POST ${url} \\\n  -H 'Content-Type: application/json' \\\n  -d '{"nome":"...","telefone":"..."}'`;
}

async function copy(text: string, label: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  toast.success(label);
}

function relativeReceivedAt(iso: string): string {
  return formatDistanceToNowStrict(new Date(iso), { addSuffix: true, locale: ptBR });
}

export function SourceDetail({ source, open, onOpenChange }: Props) {
  const update = useUpdateWebhookSource();
  const del = useDeleteWebhookSource();
  const { data: eventsRes, refetch: refetchEvents } = useWebhookSourceEvents(
    open ? source.id : null,
  );
  const [testing, setTesting] = React.useState(false);
  const [testOk, setTestOk] = React.useState(false);

  const url = publicUrl(source.path_token);
  const events = eventsRes?.data ?? [];

  const sendTestLead = async () => {
    setTesting(true);
    setTestOk(false);
    try {
      // URL relativa de propósito: o teste bate no host que está servindo a
      // página, mesmo que NEXT_PUBLIC_APP_URL (usada na URL exibida p/ forms
      // externos) esteja desalinhada num self-host atrás de proxy.
      const res = await fetch(`/api/v1/webhooks/in/${source.path_token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nome: "Lead de Teste", telefone: "11999990000", utm_source: "teste" }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(
          body?.error?.message ??
            "Não funcionou. Confira se a fonte está ativa e se o funil/estágio ainda existem.",
        );
        return;
      }
      toast.success("Funcionou! Um lead de teste entrou no seu funil.");
      setTestOk(true);
      void refetchEvents();
    } catch {
      toast.error("Não conseguimos falar com o endereço. Confira sua internet e tente de novo.");
    } finally {
      setTesting(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <div className="flex items-center gap-2">
            <SheetTitle>{source.name}</SheetTitle>
            <Badge variant={source.is_active ? "success" : "neutral"}>
              {source.is_active ? "Ativa" : "Pausada"}
            </Badge>
          </div>
          <SheetDescription>
            Cada envio para o endereço abaixo vira um lead no seu funil, automaticamente.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-6">
          <section className="space-y-2">
            <p className="text-sm font-medium text-text">Endereço da fonte</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-sm border border-border bg-muted px-3 py-2 text-xs">
                {url}
              </code>
              <Button
                type="button"
                variant="secondary"
                size="icon"
                onClick={() => copy(url, "Endereço copiado.")}
              >
                <Copy />
              </Button>
            </div>
          </section>

          <section className="space-y-2">
            <p className="text-sm font-medium text-text">Formulário pronto para colar no seu site</p>
            <Textarea readOnly rows={6} value={formSnippet(url)} className="font-mono text-xs" />
            <Button
              type="button"
              variant="secondary"
              onClick={() => copy(formSnippet(url), "Formulário copiado.")}
            >
              <Copy /> Copiar formulário
            </Button>
          </section>

          <section className="space-y-2 rounded-sm border border-border">
            <details className="group p-3">
              <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-text">
                Como conectar no seu caso
                <CaretDown className="transition-transform group-open:rotate-180" />
              </summary>
              <div className="mt-3 space-y-4 text-sm text-muted-foreground">
                <div>
                  <p className="font-medium text-text">WordPress / Elementor</p>
                  <p>Cole o endereço acima no campo &quot;Action&quot; (ou &quot;URL de envio&quot;) do seu formulário.</p>
                </div>
                <div>
                  <p className="font-medium text-text">Zapier / n8n</p>
                  <p>Use a ação &quot;Webhooks&quot; → POST, apontando para o endereço acima.</p>
                </div>
                <div>
                  <p className="font-medium text-text">Formulário próprio</p>
                  <p>Use o HTML pronto logo acima — já aponta para o endereço certo.</p>
                </div>
              </div>
            </details>
          </section>

          <details className="rounded-sm border border-border p-3">
            <summary className="cursor-pointer list-none text-sm font-medium text-text">
              Para desenvolvedores
            </summary>
            <pre className="mt-3 overflow-x-auto rounded-sm bg-muted p-3 text-xs">
              <code>{curlSnippet(url)}</code>
            </pre>
          </details>

          <section className="space-y-3">
            <Button type="button" onClick={sendTestLead} disabled={testing}>
              {testing ? "Enviando…" : "Enviar lead de teste"}
            </Button>
            {testOk ? (
              <p className="text-sm">
                <Link href="/app/kanban" className="text-accent underline underline-offset-4">
                  Ver no Kanban
                </Link>
              </p>
            ) : null}
          </section>

          <section className="space-y-2">
            <p className="text-sm font-medium text-text">Últimos recebimentos</p>
            {events.length === 0 ? (
              <p className="text-sm text-muted-foreground">Ainda não chegou nada por aqui.</p>
            ) : (
              <ul className="space-y-1">
                {events.map((ev) => (
                  <li key={ev.id} className="flex items-center gap-2 text-sm">
                    <span
                      className={cn(
                        "h-2 w-2 shrink-0 rounded-full",
                        ev.valid_signature === false ? "bg-error" : "bg-success",
                      )}
                    />
                    <span className="text-muted-foreground">{relativeReceivedAt(ev.created_at)}</span>
                    {ev.valid_signature === false ? (
                      <span className="text-xs text-error">assinatura inválida</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="flex items-center justify-between rounded-sm border border-border p-3">
            <div>
              <p className="text-sm font-medium text-text">Fonte ativa</p>
              <p className="text-xs text-muted-foreground">Pausada, ela para de aceitar novos envios.</p>
            </div>
            <Switch
              checked={source.is_active}
              disabled={update.isPending}
              onCheckedChange={(checked) =>
                update.mutate(
                  { id: source.id, is_active: checked },
                  {
                    onSuccess: () =>
                      toast.success(checked ? "Fonte ativada." : "Fonte pausada."),
                  },
                )
              }
            />
          </section>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button type="button" variant="destructive">
                <Trash /> Excluir fonte
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Excluir esta fonte?</AlertDialogTitle>
                <AlertDialogDescription>
                  O endereço para de funcionar imediatamente. Leads já recebidos continuam no seu
                  funil — só a captação futura é interrompida. Essa ação não pode ser desfeita.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancelar</AlertDialogCancel>
                <AlertDialogAction
                  onClick={async () => {
                    await del.mutateAsync(source.id);
                    toast.success("Fonte excluída.");
                    onOpenChange(false);
                  }}
                >
                  Excluir
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </SheetContent>
    </Sheet>
  );
}
