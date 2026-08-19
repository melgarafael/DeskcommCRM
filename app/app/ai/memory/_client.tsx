"use client";
import * as React from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Archive, ArrowsClockwise, Plus } from "@/lib/ui/icons";
import { usePermission } from "@/hooks/auth/AuthProvider";
import {
  useOrgMemory,
  usePublishOrgMemory,
  useCreateOrgMemoryEntry,
  useSetOrgMemoryEntryStatus,
  useOrgMemoryVersion,
  type OrgMemoryState,
  type OrgMemoryVersionMeta,
} from "@/hooks/ai/useOrgMemory";

interface Props {
  initialState: OrgMemoryState;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function OrgMemoryClient({ initialState }: Props) {
  const { data } = useOrgMemory(initialState);
  const document = data?.document ?? null;
  const versions = data?.versions ?? [];
  const entries = data?.entries ?? [];
  const canPublish = usePermission("ai.memory.publish");

  const [content, setContent] = React.useState(document?.content ?? "");
  const [historyTarget, setHistoryTarget] = React.useState<OrgMemoryVersionMeta | null>(null);
  const [showArchived, setShowArchived] = React.useState(false);
  const [formOpen, setFormOpen] = React.useState(false);
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");

  const publish = usePublishOrgMemory();
  const createEntry = useCreateOrgMemoryEntry();
  const setStatus = useSetOrgMemoryEntryStatus();
  const versionDetail = useOrgMemoryVersion(historyTarget?.id ?? null);

  // Sincroniza o textarea quando a versão ativa mudar sob nós (ex.: outro admin publicou).
  const lastSyncedRef = React.useRef(document?.version_id ?? null);
  React.useEffect(() => {
    if (document?.version_id !== lastSyncedRef.current) {
      lastSyncedRef.current = document?.version_id ?? null;
      setContent(document?.content ?? "");
    }
  }, [document?.version_id, document?.content]);

  const isDirty = content !== (document?.content ?? "");
  const canSubmitPublish = canPublish && isDirty && content.trim().length > 0;

  function handlePublish() {
    publish.mutate(content, {
      onSuccess: (res) => {
        toast.success(`Versão v${res.data.version_number} publicada — já vale para todos os agentes.`);
      },
      onError: showApiError,
    });
  }

  function handleRestore(versionContent: string, versionNumber: number) {
    setContent(versionContent);
    setHistoryTarget(null);
    toast.info(`Conteúdo da v${versionNumber} carregado no editor. Clique em "Publicar versão" para confirmar.`);
  }

  function handleCreateEntry(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !body.trim()) return;
    createEntry.mutate(
      { title: title.trim(), body: body.trim() },
      {
        onSuccess: () => {
          toast.success("Aprendizado adicionado.");
          setTitle("");
          setBody("");
          setFormOpen(false);
        },
        onError: showApiError,
      },
    );
  }

  function handleToggleArchive(id: string, next: "archived" | "active") {
    setStatus.mutate(
      { id, status: next },
      {
        onSuccess: () => {
          toast.success(next === "archived" ? "Aprendizado arquivado." : "Aprendizado reativado.");
        },
        onError: showApiError,
      },
    );
  }

  const visibleEntries = entries.filter((e) => (showArchived ? e.status === "archived" : e.status === "active"));

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>Documento da organização</CardTitle>
              <CardDescription>
                O texto-base que qualquer agente de IA lê antes de responder — como a "política
                da casa" que todo atendente novo teria que decorar.
              </CardDescription>
            </div>
            {document ? (
              <Badge variant="success">v{document.version_number} ativa</Badge>
            ) : (
              <Badge variant="neutral">Nenhuma versão publicada ainda</Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Ex.: Nunca prometa desconto sem confirmar com um humano. Horário de atendimento: 9h–18h, seg-sex. Sempre chame o cliente pelo primeiro nome."
            className="min-h-[220px] font-mono text-[13px]"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">{content.length} caracteres</span>
            <div className="flex items-center gap-2">
              {!canPublish && (
                <span className="text-xs text-muted-foreground">
                  Somente admins podem publicar uma nova versão.
                </span>
              )}
              <Button
                onClick={handlePublish}
                disabled={!canSubmitPublish || publish.isPending}
              >
                {publish.isPending ? "Publicando…" : "Publicar versão"}
              </Button>
            </div>
          </div>

          {versions.length > 0 && (
            <div className="mt-4 border-t border-border pt-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">Histórico de versões</p>
              <ul className="flex flex-col gap-1">
                {versions.map((v) => (
                  <li key={v.id}>
                    <button
                      type="button"
                      onClick={() => setHistoryTarget(v)}
                      className="flex w-full items-center gap-3 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent-soft"
                    >
                      <span className="font-mono text-xs">v{v.version_number}</span>
                      <span className="text-xs text-muted-foreground">{formatDate(v.created_at)}</span>
                      {document?.version_id === v.id && (
                        <Badge variant="success" className="text-[10px]">ativa</Badge>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>Aprendizados</CardTitle>
              <CardDescription>
                Fatos e correções pontuais que os agentes também levam em conta — adicionados à
                mão ou aprendidos automaticamente pelo sistema a partir de conversas reais.
              </CardDescription>
            </div>
            <Button variant="secondary" size="sm" onClick={() => setFormOpen((v) => !v)}>
              <Plus /> Novo aprendizado
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {formOpen && (
            <form
              onSubmit={handleCreateEntry}
              className="flex flex-col gap-3 rounded-md border border-border bg-surface-elevated p-4"
            >
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="entry-title">Título</Label>
                <Input
                  id="entry-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Ex.: Não oferecer frete grátis no primeiro contato"
                  maxLength={200}
                  required
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="entry-body">O que o agente deve saber</Label>
                <Textarea
                  id="entry-body"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="Descreva a regra ou o aprendizado em texto simples."
                  className="min-h-[100px]"
                  required
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setFormOpen(false)}>
                  Cancelar
                </Button>
                <Button type="submit" size="sm" disabled={createEntry.isPending}>
                  {createEntry.isPending ? "Salvando…" : "Salvar aprendizado"}
                </Button>
              </div>
            </form>
          )}

          {entries.some((e) => e.status === "archived") && (
            <button
              type="button"
              onClick={() => setShowArchived((v) => !v)}
              className="self-start text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              {showArchived ? "Ver aprendizados ativos" : "Ver aprendizados arquivados"}
            </button>
          )}

          {visibleEntries.length === 0 ? (
            <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
              {showArchived
                ? "Nenhum aprendizado arquivado."
                : "Nenhum aprendizado ainda. Use \"+ Novo aprendizado\" para ensinar algo que os agentes devem lembrar em toda conversa — ou aguarde o sistema sugerir aprendizados automaticamente a partir do atendimento real."}
            </p>
          ) : (
            <ol className="flex flex-col gap-2">
              {visibleEntries.map((entry) => (
                <li
                  key={entry.id}
                  className="flex flex-col gap-1.5 rounded-md border border-border/60 p-3 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{entry.title}</span>
                    <Badge variant={entry.source === "flywheel" ? "info" : "neutral"} className="text-[10px]">
                      {entry.source === "flywheel" ? "aprendido automaticamente" : "manual"}
                    </Badge>
                    <span className="ml-auto text-xs text-muted-foreground">{formatDate(entry.created_at)}</span>
                  </div>
                  <p className="whitespace-pre-wrap text-text-muted">{entry.body}</p>
                  <div className="flex sm:justify-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={setStatus.isPending}
                      onClick={() =>
                        handleToggleArchive(entry.id, entry.status === "active" ? "archived" : "active")
                      }
                      className="w-full sm:w-auto"
                    >
                      {entry.status === "active" ? (
                        <>
                          <Archive /> Arquivar
                        </>
                      ) : (
                        <>
                          <ArrowsClockwise /> Reativar
                        </>
                      )}
                    </Button>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>

      <Dialog open={historyTarget != null} onOpenChange={(o) => !o && setHistoryTarget(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Versão v{historyTarget?.version_number}</DialogTitle>
            <DialogDescription>
              {historyTarget ? `Publicada em ${formatDate(historyTarget.created_at)}` : null}
            </DialogDescription>
          </DialogHeader>
          {versionDetail.isLoading ? (
            <p className="text-sm text-muted-foreground">Carregando…</p>
          ) : (
            <pre className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-surface-elevated p-4 font-mono text-[13px]">
              {versionDetail.data?.content}
            </pre>
          )}
          <DialogFooter>
            <Button
              variant="secondary"
              disabled={!versionDetail.data}
              onClick={() =>
                versionDetail.data &&
                handleRestore(versionDetail.data.content, versionDetail.data.version_number)
              }
            >
              Restaurar como nova versão
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
