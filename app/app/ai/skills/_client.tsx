"use client";
import * as React from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { PuzzlePiece, UploadSimple, DownloadSimple, Trash, Info } from "@/lib/ui/icons";
import { usePermission } from "@/hooks/auth/AuthProvider";
import {
  useSkills,
  useInstallSkill,
  useUninstallSkill,
  useImportSkill,
  type SkillsState,
} from "@/hooks/ai/useSkills";

interface Props {
  initialState: SkillsState;
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

export function SkillsClient({ initialState }: Props) {
  const { data } = useSkills(initialState);
  const installed = data?.installed ?? [];
  const catalog = data?.catalog ?? [];
  const canManage = usePermission("ai.skills.manage");

  const install = useInstallSkill();
  const uninstall = useUninstallSkill();
  const importSkill = useImportSkill();
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [pendingName, setPendingName] = React.useState<string | null>(null);

  function handleInstall(name: string) {
    setPendingName(name);
    install.mutate(name, {
      onSuccess: () => {
        toast.success(`Skill "${name}" instalada — já vale para os agentes desta organização.`);
        setPendingName(null);
      },
      onError: (err) => {
        showApiError(err);
        setPendingName(null);
      },
    });
  }

  function handleUninstall(name: string) {
    setPendingName(name);
    uninstall.mutate(name, {
      onSuccess: () => {
        toast.success(`Skill "${name}" desinstalada.`);
        setPendingName(null);
      },
      onError: (err) => {
        showApiError(err);
        setPendingName(null);
      },
    });
  }

  function handleFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    importSkill.mutate(file, {
      onSuccess: (res) => {
        toast.success(`Skill "${res.data.name}" enviada e instalada com sucesso.`);
      },
      onError: showApiError,
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>Skills instaladas</CardTitle>
              <CardDescription>
                O que seus agentes já sabem fazer além da conversa comum — cada skill só entra
                em ação quando o assunto pede.
              </CardDescription>
            </div>
            {canManage && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".zip"
                  className="hidden"
                  onChange={handleFileChosen}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={importSkill.isPending}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <UploadSimple /> {importSkill.isPending ? "Enviando…" : "Enviar skill (.zip)"}
                </Button>
              </>
            )}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {installed.length === 0 ? (
            <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
              Nenhuma skill instalada ainda. Instale uma pronta do catálogo abaixo ou envie a
              sua em "Enviar skill (.zip)".
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {installed.map((skill) => (
                <li
                  key={skill.name}
                  className="flex flex-col gap-1.5 rounded-md border border-border/60 p-3 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <PuzzlePiece className="text-accent" aria-hidden />
                    <span className="font-medium">{skill.name}</span>
                    <Badge variant={skill.source === "catalog" ? "info" : "neutral"} className="text-[10px]">
                      {skill.source === "catalog" ? "do catálogo" : "manual"}
                    </Badge>
                    <span className="ml-auto text-xs text-muted-foreground">
                      atualizada em {formatDate(skill.updated_at)}
                    </span>
                  </div>
                  {skill.description && <p className="text-text-muted">{skill.description}</p>}
                  {canManage && (
                    <div className="flex sm:justify-end">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={uninstall.isPending && pendingName === skill.name}
                        onClick={() => handleUninstall(skill.name)}
                        className="w-full sm:w-auto"
                      >
                        <Trash /> Desinstalar
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-start gap-2 rounded-md bg-accent-soft p-3 text-xs text-text-muted">
            <Info className="mt-0.5 shrink-0" aria-hidden />
            <p>
              Para personalizar uma skill instalada, basta reenviar um .zip com o mesmo nome —
              a sua versão passa a valer no lugar da do catálogo. Não há editor dentro do sistema
              nesta fase.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Catálogo</CardTitle>
          <CardDescription>
            Skills prontas, mantidas pela plataforma, disponíveis para instalar com um clique.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {catalog.length === 0 ? (
            <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
              Nenhuma skill nova no catálogo — você já instalou tudo que a plataforma oferece
              hoje.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {catalog.map((skill) => (
                <li
                  key={skill.name}
                  className="flex flex-col gap-1.5 rounded-md border border-border/60 p-3 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <PuzzlePiece aria-hidden />
                    <span className="font-medium">{skill.name}</span>
                  </div>
                  {skill.description && <p className="text-text-muted">{skill.description}</p>}
                  {canManage && (
                    <div className="flex sm:justify-end">
                      <Button
                        size="sm"
                        disabled={install.isPending && pendingName === skill.name}
                        onClick={() => handleInstall(skill.name)}
                        className="w-full sm:w-auto"
                      >
                        <DownloadSimple />
                        {install.isPending && pendingName === skill.name ? "Instalando…" : "Instalar"}
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
