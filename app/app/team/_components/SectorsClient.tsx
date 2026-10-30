"use client";

import { useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import {
  useCreateSector,
  useDeleteSector,
  useSectors,
  useUpdateSector,
  type Sector,
} from "@/hooks/team/useSectors";
import { SETOR_DESCRICAO_MAX, SETOR_NOME_MAX } from "@/lib/schemas/routing";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { PencilSimple, Plus, Trash } from "@/lib/ui/icons";

/**
 * Cadastro de setores de atendimento (migration 0801).
 *
 * Esta aba só CADASTRA. Quem põe o atendente no setor é a coluna "Setor" da aba
 * Atendimento, ao lado da jornada e da capacidade — é lá que se olha a pessoa
 * inteira. O número de atendentes por setor aqui é o elo entre as duas abas:
 * sem ele, o setor recém-criado pareceria pronto mesmo vazio.
 */
function SectorForm({
  initial,
  onSubmit,
  isPending,
  submitLabel,
}: {
  initial?: { name: string; description: string | null };
  onSubmit: (v: { name: string; description: string | null }) => Promise<unknown>;
  isPending: boolean;
  submitLabel: string;
}) {
  const t = useT();
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const nomeValido = name.trim().length > 0;

  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!nomeValido) return;
        try {
          await onSubmit({ name: name.trim(), description: description.trim() || null });
          if (!initial) {
            setName("");
            setDescription("");
          }
        } catch {
          // O erro já virou toast no hook; o formulário fica como está para a
          // pessoa corrigir (nome repetido, por exemplo).
        }
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor={initial ? "setor-nome-edicao" : "setor-nome"}>{t("Nome do setor")}</Label>
        <Input
          id={initial ? "setor-nome-edicao" : "setor-nome"}
          value={name}
          maxLength={SETOR_NOME_MAX}
          placeholder={t("Ex.: Comercial, Suporte, Financeiro")}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={initial ? "setor-descricao-edicao" : "setor-descricao"}>
          {t("Descrição (opcional)")}
        </Label>
        <Textarea
          id={initial ? "setor-descricao-edicao" : "setor-descricao"}
          value={description}
          maxLength={SETOR_DESCRICAO_MAX}
          rows={2}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="flex sm:justify-end">
        <Button type="submit" disabled={!nomeValido || isPending} className="w-full sm:w-auto">
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

export function SectorsClient({ canManage }: { canManage: boolean }) {
  const t = useT();
  const sectors = useSectors();
  const create = useCreateSector();
  const update = useUpdateSector();
  const remove = useDeleteSector();
  const [editing, setEditing] = useState<Sector | null>(null);
  const [deleting, setDeleting] = useState<Sector | null>(null);

  const list = sectors.data?.data ?? [];

  return (
    <div className="space-y-6">
      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("Novo setor")}</CardTitle>
            <CardDescription>
              {t(
                "Agrupe os atendentes por área. Depois de criar, escolha o setor de cada atendente na aba Atendimento.",
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SectorForm
              onSubmit={(v) => create.mutateAsync(v)}
              isPending={create.isPending}
              submitLabel={t("Criar setor")}
            />
          </CardContent>
        </Card>
      ) : null}

      <div className="rounded-md border" data-testid="lista-de-setores">
        <div className="border-b px-4 py-3">
          <h2 className="text-sm font-semibold">{t("Setores")}</h2>
        </div>
        {sectors.isLoading ? (
          <div className="space-y-2 p-4">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : sectors.isError ? (
          <p className="p-4 text-sm text-destructive">{t("Erro ao carregar os setores.")}</p>
        ) : list.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            {t("Nenhum setor cadastrado ainda.")}
          </p>
        ) : (
          <ul className="divide-y">
            {list.map((s) => (
              <li
                key={s.id}
                data-testid="setor"
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium wrap-anywhere">{s.name}</span>
                    <Badge variant={s.member_count > 0 ? "default" : "outline"}>
                      {s.member_count === 1
                        ? t("1 atendente")
                        : `${s.member_count} ${t("atendentes")}`}
                    </Badge>
                  </div>
                  {s.description ? (
                    <p className="text-xs text-muted-foreground wrap-anywhere">{s.description}</p>
                  ) : null}
                </div>
                {canManage ? (
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`${t("Editar setor")} ${s.name}`}
                      onClick={() => setEditing(s)}
                    >
                      <PencilSimple size={16} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`${t("Apagar setor")} ${s.name}`}
                      onClick={() => setDeleting(s)}
                    >
                      <Trash size={16} />
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {editing ? (
        <Dialog open onOpenChange={(o) => !o && setEditing(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("Editar setor")}</DialogTitle>
            </DialogHeader>
            <SectorForm
              initial={{ name: editing.name, description: editing.description }}
              isPending={update.isPending}
              submitLabel={t("Salvar")}
              onSubmit={async (v) => {
                await update.mutateAsync({ id: editing.id, patch: v });
                setEditing(null);
              }}
            />
            <DialogFooter />
          </DialogContent>
        </Dialog>
      ) : null}

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("Apagar setor")} {deleting?.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "Os atendentes deste setor ficam sem setor. Jornada, carga e conversas deles não mudam.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleting) remove.mutate(deleting.id);
                setDeleting(null);
              }}
            >
              {t("Apagar")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
