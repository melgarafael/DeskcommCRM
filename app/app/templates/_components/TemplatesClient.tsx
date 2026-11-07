"use client";

import { useT } from "@/hooks/i18n/useT";
import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import type { DropResult } from "@hello-pangea/dnd";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Plus } from "@/lib/ui/icons";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import {
  CHAVE_DOS_GRUPOS,
  CHAVE_DOS_TEMPLATES,
  useGruposDeRespostas,
  useMessageTemplates,
  useMoverGrupo,
  useMoverTemplate,
  type GrupoDeRespostas,
  type MessageTemplate,
} from "@/hooks/inbox/useMessageTemplates";
import { secoesDeRespostas } from "@/lib/templates/grupos";
import { TemplateFormDialog } from "./TemplateFormDialog";
import { ListaDeRespostas, chaveDaSecao } from "./ListaDeRespostas";

const TEMPLATES_KEY = CHAVE_DOS_TEMPLATES;

interface Props {
  canShare: boolean;
  currentUserId: string;
}

/**
 * A TELA DAS RESPOSTAS RÁPIDAS (#3244 + #3245).
 *
 * ─── O que o arrasto manda no fio ───────────────────────────────────────────
 *
 * O VIZINHO da esquerda (`depois_de`), nunca o índice: é o que a rota
 * (`PUT /api/v1/message-templates/[id]/ordem`) espera, e é o que faz a posição
 * gravada sobreviver a uma lista que mudou entre o arrasto e a resposta.
 *
 * Soltar numa OUTRA seção é o gesto de mudar de grupo: o mesmo `DropResult`
 * traz seções diferentes, e aí a tela manda o `grupo_id` no PATCH e, logo
 * depois, a posição na rota de ordem. Duas chamadas e não uma rota nova: o
 * vínculo e a posição são campos da MESMA linha, mas cada um tem a sua régua
 * (o PATCH é `partial`, a ordem tem conta própria).
 *
 * ─── A ordem otimista, e por que ela é LOCAL ────────────────────────────────
 *
 * `@hello-pangea/dnd` repinta a lista pelo que o pai renderiza: sem uma ordem
 * nova no MESMO render do `onDragEnd`, a linha solta voltaria para o lugar de
 * origem e só depois saltaria, quando o refetch da invalidação chegasse. A
 * ordem fica num estado local — POR SEÇÃO (`chave`) — e é DESCARTADA quando a
 * resposta chega (sucesso ou erro): quem manda na tela continua sendo o
 * servidor.
 *
 * ─── Grupo é OPCIONAL ──────────────────────────────────────────────────────
 *
 * Sem grupo nenhum, `ListaDeRespostas` devolve a lista plana de hoje, e esta
 * tela não desenha cabeçalho, botão de grupo nem nada que tenha mudado. Quem
 * nunca usou o recurso tem a mesma tela de antes, byte a byte.
 */
export function TemplatesClient({ canShare, currentUserId }: Props) {
  const t = useT();
  const { data: templates, isLoading } = useMessageTemplates();
  const { data: grupos } = useGruposDeRespostas();
  const qc = useQueryClient();
  const mover = useMoverTemplate();
  const moverGrupo = useMoverGrupo();
  const del = useMutation({
    mutationFn: async (id: string) => apiClient.delete(`/api/v1/message-templates/${id}`),
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: TEMPLATES_KEY }),
  });
  const [formOpen, setFormOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<MessageTemplate | null>(null);
  // A ordem que o dedo do operador acabou de desenhar, enquanto o servidor não
  // respondeu. `null` = a tela segue a lista do servidor (o caso normal). A
  // chave é a SEÇÃO: uma ordem vale para a lista onde o arrasto aconteceu.
  const [ordemOtimista, setOrdemOtimista] = React.useState<{
    chave: string;
    ids: string[];
  } | null>(null);
  // O diálogo de grupo — criar (id ausente) ou renomear (id presente).
  const [grupoEmEdicao, setGrupoEmEdicao] = React.useState<{ id: string | null; nome: string } | null>(
    null,
  );
  // Deep link: `/app/templates?modelo=<id>` abre aquele modelo. É o link que a
  // integração devolve ("use o modelo X") e que a tela não tinha — sem ele, quem
  // recebe a mensagem cai na lista e tem de caçar de qual texto se falava.
  // `?.` porque o hook devolve null fora de um contexto de navegação (o que
  // acontece em teste e em render estático), como no resto do repo.
  const idDoModelo = useSearchParams()?.get("modelo") ?? null;
  const [abertoPelaUrl, setAbertoPelaUrl] = React.useState(false);
  // Só quem pode editar/apagar pela RLS vê as ações: o dono do pessoal, ou
  // manager+ no compartilhado (owner null). Sem isto, um agent veria botões
  // que o backend rejeita (404/nada apagado).
  const canModify = React.useCallback(
    (template: MessageTemplate) =>
      template.owner_user_id === currentUserId || (template.owner_user_id === null && canShare),
    [canShare, currentUserId],
  );

  /**
   * A lista RENDERIZADA: a do servidor, com a ordem otimista por cima enquanto
   * ela existe. Ids que sumiram da lista (outra aba excluiu) são descartados e o
   * resto entra no fim — nunca some linha da tela por causa de uma ordem velha.
   */
  const lista = React.useMemo(() => {
    const base = templates ?? [];
    if (!ordemOtimista) return base;
    const secoes = secoesDeRespostas(base, grupos);
    if (!secoes) {
      const porId = new Map(base.map((template) => [template.id, template]));
      const ordenada = ordemOtimista.ids.flatMap((id) => {
        const achado = porId.get(id);
        return achado ? [achado] : [];
      });
      const fora = base.filter((template) => !ordemOtimista.ids.includes(template.id));
      return [...ordenada, ...fora];
    }
    // Agrupada: a ordem otimista vale para UMA seção. As demais ficam como
    // vieram do servidor, e a lista é remontada na ordem das seções.
    return secoes.flatMap((secao) => {
      if (chaveDaSecao(secao.grupo) !== ordemOtimista.chave) return secao.respostas;
      const porId = new Map(secao.respostas.map((template) => [template.id, template]));
      const ordenada = ordemOtimista.ids.flatMap((id) => {
        const achado = porId.get(id);
        return achado ? [achado] : [];
      });
      const fora = secao.respostas.filter((template) => !ordemOtimista.ids.includes(template.id));
      return [...ordenada, ...fora];
    });
  }, [templates, grupos, ordemOtimista]);

  React.useEffect(() => {
    if (abertoPelaUrl || !idDoModelo) return;
    // A lista chega depois: enquanto ela não tem o modelo pedido, NÃO marca como
    // aberto — marcar aqui faria o link depender de o dado já estar em cache.
    const alvo = templates?.find((template) => template.id === idDoModelo);
    if (!alvo) return;
    setAbertoPelaUrl(true);
    // O link só abre a EDIÇÃO para quem pode editar — a mesma régua da lista.
    // Um agent que recebe o link de um compartilhado fica na lista, onde o
    // modelo está visível: abrir o form ali seria um Salvar que a RLS recusa.
    if (!canModify(alvo)) return;
    setEditing(alvo);
    setFormOpen(true);
  }, [abertoPelaUrl, idDoModelo, templates, canModify]);

  const openNew = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (template: MessageTemplate) => {
    setEditing(template);
    setFormOpen(true);
  };

  const salvarGrupo = useMutation({
    mutationFn: async ({ id, nome }: { id: string | null; nome: string }) =>
      id === null
        ? apiClient.post<{ data: GrupoDeRespostas }>("/api/v1/message-template-groups", {
            name: nome,
          })
        : apiClient.patch<{ data: GrupoDeRespostas }>(`/api/v1/message-template-groups/${id}`, {
            name: nome,
          }),
    onError: showApiError,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: CHAVE_DOS_GRUPOS });
      void qc.invalidateQueries({ queryKey: TEMPLATES_KEY });
    },
  });

  const excluirGrupo = useMutation({
    mutationFn: async (id: string) =>
      apiClient.delete(`/api/v1/message-template-groups/${id}`),
    onError: showApiError,
    onSuccess: () => {
      // As respostas do grupo voltam a "sem grupo" pelo banco (`on delete set
      // null`): a lista de respostas muda junto, e o cache dela é invalidado.
      void qc.invalidateQueries({ queryKey: CHAVE_DOS_GRUPOS });
      void qc.invalidateQueries({ queryKey: TEMPLATES_KEY });
      toast.success(t("Grupo excluído. As respostas dele continuam na lista."));
    },
  });

  /**
   * O fim do arrasto: reordena LOCAL, manda o vizinho e limpa o otimista quando
   * o servidor responde — é ele quem decide a ordem final.
   *
   * `destination.index` é a posição NOVA, contada na lista já sem a linha
   * arrastada (é assim que o dnd entrega o `DropResult`): o vizinho da esquerda
   * é `nova[d - 1]`, e `null` quando a linha solta na primeira posição.
   */
  const aoSoltar = (resultado: DropResult) => {
    const { source, destination, draggableId } = resultado;
    if (!destination) return;
    const mesmaSecao = destination.droppableId === source.droppableId;
    if (mesmaSecao && destination.index === source.index) return;

    const secoes = secoesDeRespostas(templates ?? [], grupos);
    if (!secoes) {
      // Lista plana: o caminho de antes dos grupos, sem nenhuma seção.
      const ids = (templates ?? []).map((template) => template.id);
      const semArrastado = ids.filter((id) => id !== draggableId);
      semArrastado.splice(destination.index, 0, draggableId);
      setOrdemOtimista({ chave: "respostas-rapidas", ids: semArrastado });
      mover.mutate(
        { id: draggableId, depoisDe: semArrastado[destination.index - 1] ?? null },
        {
          onError: (erro) => {
            setOrdemOtimista(null);
            showApiError(erro);
          },
          onSuccess: async () => {
            await qc.invalidateQueries({ queryKey: TEMPLATES_KEY });
            setOrdemOtimista(null);
          },
        },
      );
      return;
    }

    const origem = secoes.find((secao) => chaveDaSecao(secao.grupo) === source.droppableId);
    const destino = secoes.find((secao) => chaveDaSecao(secao.grupo) === destination.droppableId);
    if (!origem || !destino) return;
    const ids = destino.respostas
      .map((template) => template.id)
      .filter((id) => id !== draggableId);
    ids.splice(Math.min(destination.index, ids.length), 0, draggableId);
    setOrdemOtimista({ chave: destination.droppableId, ids });
    const depoisDe = ids[destination.index - 1] ?? null;

    if (mesmaSecao) {
      mover.mutate(
        { id: draggableId, depoisDe },
        {
          onError: (erro) => {
            setOrdemOtimista(null);
            showApiError(erro);
          },
          onSuccess: async () => {
            await qc.invalidateQueries({ queryKey: TEMPLATES_KEY });
            setOrdemOtimista(null);
          },
        },
      );
      return;
    }

    // Mudança de grupo: o vínculo primeiro, a posição depois. Em série de
    // propósito — a posição é calculada DENTRO da lista de destino, e mandá-la
    // antes do vínculo a calcularia na lista de origem.
    void (async () => {
      try {
        await apiClient.patch(`/api/v1/message-templates/${draggableId}`, {
          grupo_id: destino.grupo?.id ?? null,
        });
        await mover.mutateAsync({ id: draggableId, depoisDe });
        await qc.invalidateQueries({ queryKey: TEMPLATES_KEY });
      } catch (erro) {
        showApiError(erro as Error);
      } finally {
        setOrdemOtimista(null);
      }
    })();
  };

  /** Sobe (-1) ou desce (+1) um grupo na ordem — a mesma rota do arrasto. */
  const moverGrupoNaLista = (grupo: GrupoDeRespostas, direcao: -1 | 1) => {
    const ordenados = [...(grupos ?? [])].sort(
      (a, b) => (a.ordem ?? 0) - (b.ordem ?? 0) || a.name.localeCompare(b.name),
    );
    const indice = ordenados.findIndex((atual) => atual.id === grupo.id);
    if (indice < 0) return;
    // Sobe: vai para depois do grupo que vinha antes do anterior. Desce: vai
    // para depois do que hoje é o próximo.
    const depoisDe =
      direcao === -1 ? (ordenados[indice - 2]?.id ?? null) : (ordenados[indice + 1]?.id ?? null);
    moverGrupo.mutate(
      { id: grupo.id, depoisDe },
      { onError: showApiError },
    );
  };

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        {/* A ação principal vem PRIMEIRO: o grupo é opcional, e quem chega à
            tela procurando "criar" acha a resposta rápida antes do grupo. */}
        <Button type="button" onClick={openNew} className="w-full sm:w-auto">
          <Plus /> {t("Nova resposta rápida")}
        </Button>
        {/* Só `manager+` cria grupo: é estrutura da organização, e a policy
            `message_template_groups_write` cobra o mesmo (migration 0808). */}
        {canShare && (
          <Button
            type="button"
            variant="outline"
            onClick={() => setGrupoEmEdicao({ id: null, nome: "" })}
            className="w-full sm:w-auto"
          >
            <Plus /> {t("Novo grupo")}
          </Button>
        )}
      </div>
      {!templates?.length ? (
        <p className="text-sm text-muted-foreground">{t("Nenhuma resposta rápida ainda.")}</p>
      ) : (
        <ListaDeRespostas
          templates={lista}
          grupos={grupos}
          podeMover={canModify}
          onEditar={openEdit}
          onExcluir={(template) =>
            del.mutate(template.id, {
              onSuccess: () => toast.success(t("Resposta rápida excluída.")),
            })
          }
          aoSoltar={aoSoltar}
          podeGerirGrupos={canShare}
          onRenomearGrupo={(grupo) => setGrupoEmEdicao({ id: grupo.id, nome: grupo.name })}
          onExcluirGrupo={(grupo) => excluirGrupo.mutate(grupo.id)}
          onMoverGrupo={moverGrupoNaLista}
        />
      )}
      <TemplateFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        canShare={canShare}
        template={editing}
        grupos={grupos ?? []}
      />
      {/* O grupo — criar e renomear no MESMO diálogo: é um campo só, e o
          formulário mudaria uma palavra entre os dois modos. */}
      <Dialog
        open={grupoEmEdicao !== null}
        onOpenChange={(aberto) => {
          if (!aberto) setGrupoEmEdicao(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {grupoEmEdicao?.id ? t("Renomear grupo") : t("Novo grupo")}
            </DialogTitle>
            <DialogDescription>
              {t("Grupos organizam as respostas por etapa da venda. Eles são opcionais.")}
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(evento) => {
              evento.preventDefault();
              const nome = grupoEmEdicao?.nome.trim() ?? "";
              if (!nome) return;
              salvarGrupo.mutate(
                { id: grupoEmEdicao?.id ?? null, nome },
                {
                  onSuccess: () => {
                    setGrupoEmEdicao(null);
                    toast.success(
                      grupoEmEdicao?.id ? t("Grupo renomeado.") : t("Grupo criado."),
                    );
                  },
                },
              );
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="grupo-nome">{t("Nome do grupo")}</Label>
              <Input
                id="grupo-nome"
                value={grupoEmEdicao?.nome ?? ""}
                onChange={(evento) =>
                  setGrupoEmEdicao((atual) => (atual ? { ...atual, nome: evento.target.value } : atual))
                }
                placeholder={t("Atendimento inicial")}
                minLength={1}
                maxLength={60}
                required
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setGrupoEmEdicao(null)}>
                {t("Cancelar")}
              </Button>
              <Button type="submit" disabled={salvarGrupo.isPending}>
                {t("Salvar")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
