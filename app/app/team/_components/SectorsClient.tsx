"use client";

import { useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { useAttendants, type AttendantAvailability } from "@/hooks/team/useAttendants";
import {
  useAssignSector,
  useCreateSector,
  useDeleteSector,
  useSectors,
  useUpdateSector,
  type Sector,
} from "@/hooks/team/useSectors";
import { SETOR_DESCRICAO_MAX, SETOR_NOME_MAX, type AvailabilitySchedule } from "@/lib/schemas/routing";
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
import { Clock, PencilSimple, Trash, X } from "@/lib/ui/icons";
import { HorarioDoSetorDialog } from "@/app/app/team/_components/HorarioDoSetor";
import { resumoDaJornada } from "@/lib/agenda/editor-de-jornada";
import { ChipDeEtiqueta } from "@/components/tags/ChipDeEtiqueta";
import { NOME_DO_TOM, PALETA_DE_ETIQUETAS } from "@/lib/tags/cor-da-etiqueta";
import { cn } from "@/lib/utils";

/**
 * Cadastro de setores de atendimento (migration 0801).
 *
 * Esta aba só CADASTRA. Quem põe o atendente no setor é a coluna "Setor" da aba
 * Atendimento, ao lado da jornada e da capacidade — é lá que se olha a pessoa
 * inteira. O número de atendentes por setor aqui é o elo entre as duas abas:
 * sem ele, o setor recém-criado pareceria pronto mesmo vazio.
 *
 * ─── Cor e membros DENTRO do card (#3876, fatia F3) ─────────────────────────
 *
 * A cor da fila usa o `ChipDeEtiqueta` — o MESMO componente que pinta a etiqueta
 * em oito telas, e o único ponto de render que aplica a régua de contraste do
 * repo (`escolheAFrente`, piso 4,5, #2373). Pintar a fila por fora dele criaria
 * um segundo caminho de cor, e é exatamente isso que
 * `tests/unit/chip-contraste-da-etiqueta.test.ts` reprova: a frente do texto é
 * CALCULADA, nunca escolhida por quem pinta. Sem cor, o card sai exatamente como
 * saía antes desta fatia — o nome em texto puro, sem chip nenhum.
 *
 * Os membros moram no card porque é aqui que a pergunta nasce ("quem atende o
 * comercial?"). A escrita reusa `PUT /api/v1/attendants/sector/[user_id]`, que
 * SUBSTITUI o conjunto de filas da pessoa: por isso toda chamada daqui manda a
 * lista COMPLETA dela, lida do roster. Mandar só a fila desta tela tiraria a
 * pessoa das outras — e é o defeito que ninguém percebe até a conversa cair na
 * fila errada.
 */
function SectorForm({
  initial,
  onSubmit,
  isPending,
  submitLabel,
}: {
  initial?: { name: string; description: string | null; color: string | null };
  onSubmit: (v: {
    name: string;
    description: string | null;
    color?: string | null;
  }) => Promise<unknown>;
  isPending: boolean;
  submitLabel: string;
}) {
  const t = useT();
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [color, setColor] = useState<string | null>(initial?.color ?? null);
  const nomeValido = name.trim().length > 0;

  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!nomeValido) return;
        try {
          await onSubmit({
            name: name.trim(),
            description: description.trim() || null,
            // Na CRIAÇÃO a cor não vai: a rota de POST não a conhece (o corpo é
            // estrito) e quem pinta um setor novo é o editar, com a paleta à
            // vista ao lado do chip que acabou de nascer.
            ...(initial ? { color } : {}),
          });
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
      {initial ? (
        <div className="space-y-1.5">
          <Label>{t("Cor do setor")}</Label>
          {/*
            Paleta FECHADA, a mesma dos oito tons medidos das etiquetas
            (`PALETA_DE_ETIQUETAS`, separação e contraste medidos em #1271).
            Seletor livre recriaria em cada instalação o problema que a paleta
            veio consertar — e o nome do tom é o rótulo acessível: cor nunca é
            o único portador de significado.
          */}
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("Cor do setor")}>
            {PALETA_DE_ETIQUETAS.map((tom) => (
              <button
                key={tom}
                type="button"
                aria-pressed={color === tom}
                aria-label={t(NOME_DO_TOM[tom] ?? tom)}
                title={tom}
                onClick={() => setColor(tom)}
                className={cn(
                  "size-11 rounded-full border-2 transition-transform lg:size-7",
                  color === tom
                    ? "border-foreground ring-2 ring-ring ring-offset-1 ring-offset-background"
                    : "border-transparent hover:scale-110",
                )}
                style={{ backgroundColor: tom }}
              />
            ))}
            <Button
              type="button"
              size="sm"
              variant={color === null ? "default" : "outline"}
              aria-pressed={color === null}
              onClick={() => setColor(null)}
            >
              {t("Sem cor")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("O texto sobre a cor é escolhido pelo sistema, para continuar legível.")}
          </p>
        </div>
      ) : null}
      <div className="flex sm:justify-end">
        <Button type="submit" disabled={!nomeValido || isPending} className="w-full sm:w-auto">
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** Nome legível do atendente no card — o mesmo critério do roster. */
function nomeDoAtendente(a: AttendantAvailability): string {
  return a.name ?? a.email ?? a.user_id;
}

export function SectorsClient({
  canManage,
  setoresLigado = true,
}: {
  canManage: boolean;
  /**
   * Módulo opcional (doc 213). A página já não desenha a aba quando ele está
   * desligado; esta porta é a segunda, e é o que impede um chamador novo de
   * fazer a tela pedir setores (e roster) numa instalação que não os tem.
   */
  setoresLigado?: boolean;
}) {
  const t = useT();
  const sectors = useSectors(setoresLigado);
  const roster = useAttendants(setoresLigado);
  const create = useCreateSector();
  const update = useUpdateSector();
  const remove = useDeleteSector();
  const assign = useAssignSector();
  const [editing, setEditing] = useState<Sector | null>(null);
  const [deleting, setDeleting] = useState<Sector | null>(null);
  const [horario, setHorario] = useState<Sector | null>(null);

  if (!setoresLigado) return null;

  const list = sectors.data?.data ?? [];
  const atendentes = roster.data?.data ?? [];
  const membrosDoSetor = (sectorId: string) =>
    atendentes.filter((a) => a.sector_ids.includes(sectorId));

  /**
   * Põe ou tira UMA fila da pessoa, mandando o conjunto inteiro dela. Fila que
   * a tela não mostra continua na lista — a rota substitui, não soma.
   */
  const alternarMembro = (atendente: AttendantAvailability, sectorId: string, entrar: boolean) => {
    const atuais = atendente.sector_ids.filter((id) => id !== sectorId);
    assign.mutate({
      userId: atendente.user_id,
      sectorIds: entrar ? [...atuais, sectorId] : atuais,
    });
  };

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
            {list.map((s) => {
              const membros = membrosDoSetor(s.id);
              const deFora = atendentes.filter((a) => !a.sector_ids.includes(s.id));
              return (
                <li key={s.id} data-testid="setor" className="px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        {/*
                          Com cor, o NOME é o chip pintado — o mesmo
                          `ChipDeEtiqueta` das etiquetas, com a cor forçada pelo
                          dado da fila. Sem cor, o nome continua sendo o `<span>`
                          de antes desta fatia: nada de chip cinza "vazio", que
                          faria o setor sem cor parecer diferente do que era.
                        */}
                        {s.color ? (
                          <ChipDeEtiqueta
                            tag={s.name}
                            cor={s.color}
                            data-testid="cor-do-setor"
                            className="font-medium"
                          />
                        ) : (
                          <span className="font-medium wrap-anywhere">{s.name}</span>
                        )}
                        <Badge variant={s.member_count > 0 ? "default" : "outline"}>
                          {s.member_count === 1
                            ? t("1 atendente")
                            : `${s.member_count} ${t("atendentes")}`}
                        </Badge>
                      </div>
                      {s.description ? (
                        <p className="text-xs text-muted-foreground wrap-anywhere">{s.description}</p>
                      ) : null}
                      {/*
                        O horário do setor, na linha do setor. Sem esta linha, a única
                        forma de saber que uma fila atende só até as 18h seria abrir
                        o diálogo de cada uma — e "por que ninguém recebeu depois das
                        18h?" voltaria a ser pergunta sem resposta na tela.
                      */}
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {s.schedule?.windows?.length
                          ? resumoDaJornada(s.schedule.windows, t).join(" · ")
                          : t("24 horas, todos os dias")}
                      </p>
                    </div>
                    {canManage ? (
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`${t("Horário do setor")} ${s.name}`}
                          onClick={() => setHorario(s)}
                        >
                          <Clock size={16} />
                        </Button>
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
                  </div>

                  {/*
                    Quem está na fila, DENTRO do card: é aqui que a pergunta
                    nasce, e ir à aba Atendimento para descobrir isso obrigava a
                    abrir pessoa por pessoa. A lista é derivada do roster
                    (`sector_ids`), não de um segundo leitor: o GET dos setores
                    continua devolvendo só o contador.
                  */}
                  <div className="mt-2">
                    <div data-testid="membros-do-setor">
                      <p className="text-xs font-medium text-muted-foreground">
                        {t("Membros do setor")}
                      </p>
                      {membros.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          {t("Nenhum atendente neste setor.")}
                        </p>
                      ) : (
                        <ul className="mt-1 flex flex-wrap items-center gap-1.5">
                          {membros.map((a) => (
                            <li
                              key={a.user_id}
                              className="inline-flex items-center gap-1 rounded-full border bg-surface-elevated px-2 py-0.5 text-xs"
                            >
                              <span>{nomeDoAtendente(a)}</span>
                              {canManage ? (
                                <button
                                  type="button"
                                  aria-label={`${t("Remover do setor")} ${nomeDoAtendente(a)}`}
                                  onClick={() => alternarMembro(a, s.id, false)}
                                  disabled={assign.isPending}
                                  className="inline-flex size-11 items-center justify-center rounded-full text-muted-foreground hover:text-destructive disabled:opacity-50 lg:size-6"
                                >
                                  <X size={12} />
                                </button>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    {canManage && deFora.length > 0 ? (
                      <select
                        aria-label={t("Adicionar pessoa ao setor")}
                        value=""
                        disabled={assign.isPending}
                        onChange={(e) => {
                          const escolhido = deFora.find((a) => a.user_id === e.target.value);
                          if (escolhido) alternarMembro(escolhido, s.id, true);
                        }}
                        className="mt-1.5 h-11 w-full max-w-xs rounded-md border bg-surface px-2 text-xs text-text disabled:opacity-50 sm:w-auto lg:h-8"
                      >
                        <option value="">{t("+ Adicionar pessoa")}</option>
                        {deFora.map((a) => (
                          <option key={a.user_id} value={a.user_id}>
                            {nomeDoAtendente(a)}
                          </option>
                        ))}
                      </select>
                    ) : null}
                  </div>
                </li>
              );
            })}
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
              initial={{ name: editing.name, description: editing.description, color: editing.color }}
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

      {horario ? (
        <HorarioDoSetorDialog
          setor={horario}
          open
          onOpenChange={(o) => !o && setHorario(null)}
          isPending={update.isPending}
          onSave={async (schedule: AvailabilitySchedule) => {
            const salvo = await update.mutateAsync({ id: horario.id, patch: { schedule } });
            // NÃO fecha aqui: o resumo do que ficou gravado só faz sentido se a
            // pessoa puder lê-lo ao lado do formulário. Quem fecha é quem decide
            // que terminou ("Fechar") — o resto é o diálogo se fechando sozinho
            // em cima da única prova que o operador tem.
            return (salvo as { data?: Sector }).data?.schedule ?? null;
          }}
        />
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
