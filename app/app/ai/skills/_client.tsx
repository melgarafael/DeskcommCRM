"use client";

import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import * as React from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { PuzzlePiece, UploadSimple, DownloadSimple, Trash, Info, PencilSimple, ArrowsClockwise } from "@/lib/ui/icons";
import { EditorDeSkill } from "./_components/EditorDeSkill";
import { usePermission } from "@/hooks/auth/AuthProvider";
import {
  useSkills,
  useInstallSkill,
  useUninstallSkill,
  useImportSkill,
  type SkillsState,
} from "@/hooks/ai/useSkills";
import { useT } from "@/hooks/i18n/useT";

interface Props {
  initialState: SkillsState;
}

function formatDate(iso: string, idioma: string): string {
  return new Date(iso).toLocaleString(idioma, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function SkillsClient({ initialState }: Props) {
  const tagDoIdioma = useTagDeIdioma();
  const t = useT();
  const { data } = useSkills(initialState);
  const installed = data?.installed ?? [];
  const catalog = data?.catalog ?? [];
  const canManage = usePermission("ai.skills.manage");

  const install = useInstallSkill();
  const uninstall = useUninstallSkill();
  const importSkill = useImportSkill();
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [pendingName, setPendingName] = React.useState<string | null>(null);
  const [editando, setEditando] = React.useState<string | null>(null);

  function handleInstall(name: string) {
    setPendingName(name);
    install.mutate(name, {
      onSuccess: () => {
        toast.success(`Skill "${name}" ${t("instalada — já vale para os agentes desta organização.")}`);
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
        toast.success(`Skill "${name}" ${t("desinstalada.")}`);
        setPendingName(null);
      },
      onError: (err) => {
        showApiError(err);
        setPendingName(null);
      },
    });
  }

  // Catalogo publicou versão nova após a cópia da org: adotar re-faz o install
  // (POST /install), que aponta o ponteiro da org para a versão ATUAL de
  // plataforma numa cópia NOVA — a versão que a org tinha fica intacta no
  // histórico, a releitura carrega o texto novo.
  function handleAdotarVersao(name: string) {
    setPendingName(name);
    install.mutate(name, {
      onSuccess: () => {
        toast.success(t("Versão nova adotada — a sua cópia agora usa a versão mais recente do catálogo."));
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
        toast.success(`Skill "${res.data.name}" ${t("enviada e instalada com sucesso.")}`);
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
              <CardTitle>{t("Skills instaladas")}</CardTitle>
              <CardDescription>
                {t(
                  "O que seus agentes já sabem fazer além da conversa comum — cada skill só entra em ação quando o assunto pede.",
                )}
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
                  <UploadSimple /> {importSkill.isPending ? t("Enviando…") : t("Enviar skill (.zip)")}
                </Button>
              </>
            )}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {installed.length === 0 ? (
            <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
              {t('Nenhuma skill instalada ainda. Instale uma pronta do catálogo abaixo ou envie a sua em "Enviar skill (.zip)".')}
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
                      {skill.source === "catalog" ? t("do catálogo") : t("manual")}
                    </Badge>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {t("atualizada em")} {formatDate(skill.updated_at, tagDoIdioma)}
                    </span>
                  </div>
                  {skill.description && <p className="text-text-muted">{skill.description}</p>}
                  {skill.versao_nova_catalogo && (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-accent bg-accent-soft p-2.5 text-xs">
                      <span className="flex flex-col gap-1.5 text-text">
                        <span className="flex items-center gap-1.5">
                          <Info className="shrink-0" aria-hidden />
                          {t(
                            "Há uma versão nova desta skill no catálogo. Se você editou esta cópia, suas alterações ficam só no Histórico de versões: ao adotar, a versão nova do catálogo passa a ser a ativa. Confira antes de adotar.",
                          )}
                        </span>
                        {skill.comparativo && skill.comparativo.mudou_em.length > 0 && (
                          <span className="flex flex-col gap-1 pl-6">
                            <span className="font-medium text-text">
                              {t("Se você adotar a versão do catálogo, muda:")}
                            </span>
                            <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-text-muted">
                              {skill.comparativo.mudou_em.includes("descricao") && (
                                <span>• {t("Descrição")}</span>
                              )}
                              {skill.comparativo.mudou_em.includes("matcher") &&
                                (skill.comparativo.any_adicionadas.length > 0 ||
                                  skill.comparativo.any_removidas.length > 0) && (
                                  <span>
                                    • {t("Palavras-chave de ativação")}:{" "}
                                    {skill.comparativo.any_adicionadas.length > 0 && (
                                      <span className="text-accent">+{skill.comparativo.any_adicionadas.join(", ")}</span>
                                    )}
                                    {skill.comparativo.any_adicionadas.length > 0 &&
                                      skill.comparativo.any_removidas.length > 0 && <span aria-hidden> </span>}
                                    {skill.comparativo.any_removidas.length > 0 && (
                                      <span className="text-destructive">−{skill.comparativo.any_removidas.join(", ")}</span>
                                    )}
                                  </span>
                                )}
                              {skill.comparativo.mudou_em.includes("corpo") && (
                                <span>
                                  • {t("Procedimento (corpo)")}: +{skill.comparativo.linhas_adicionadas} −
                                  {skill.comparativo.linhas_removidas}
                                </span>
                              )}
                            </span>
                          </span>
                        )}
                      </span>
                      {canManage && (
                        <Button
                          size="sm"
                          disabled={install.isPending && pendingName === skill.name}
                          onClick={() => handleAdotarVersao(skill.name)}
                          className="w-full sm:w-auto"
                        >
                          <ArrowsClockwise />
                          {install.isPending && pendingName === skill.name ? t("Adotando…") : t("Adotar versão nova")}
                        </Button>
                      )}
                    </div>
                  )}
                  {canManage && (
                    <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setEditando(skill.name)}
                        className="w-full sm:w-auto"
                      >
                        <PencilSimple /> {t("Editar")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={uninstall.isPending && pendingName === skill.name}
                        onClick={() => handleUninstall(skill.name)}
                        className="w-full sm:w-auto"
                      >
                        <Trash /> {t("Desinstalar")}
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
              {t(
                "Use Editar para ajustar o texto de uma skill instalada — cada salvamento cria uma versão nova e a anterior fica no histórico. Também dá para reenviar um .zip com o mesmo nome; a sua versão passa a valer no lugar da do catálogo.",
              )}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("Catálogo")}</CardTitle>
          <CardDescription>
            {t("Skills prontas, mantidas pela plataforma, disponíveis para instalar com um clique.")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {catalog.length === 0 ? (
            <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
              {t("Nenhuma skill nova no catálogo — você já instalou tudo que a plataforma oferece hoje.")}
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
                        {install.isPending && pendingName === skill.name ? t("Instalando…") : t("Instalar")}
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {editando !== null && (
        <EditorDeSkill
          nome={editando}
          aberto
          aoMudarAberto={(aberto) => {
            if (!aberto) setEditando(null);
          }}
        />
      )}
    </div>
  );
}
