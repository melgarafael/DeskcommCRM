"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useActiveOrg, useUser } from "@/hooks/auth/AuthProvider";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { ROLE_RANK } from "@/lib/auth/types";
import { useBulkAction } from "@/hooks/kanban/useBulkAction";
import { resolveVocabulary } from "@/lib/kanban/vocabulary";
import type { PipelineVocabulary, Stage } from "@/lib/kanban/types";

interface BulkActionBarProps {
  selectedIds: string[];
  stages: Stage[];
  pipelineId: string;
  /**
   * Como ESTE funil chama o que está nos cards. Vem de `crm_pipelines.vocabulary`
   * — é o pilar que faz o mesmo código servir e-commerce, clínica e imobiliária
   * trocando só as palavras. Sem isto a barra dizia "lead" para todo mundo.
   */
  vocabulary?: PipelineVocabulary | null;
  /**
   * Tags dos leads do quadro — sem isto o menu só oferecia "nova tag" (#852).
   *
   * ⚠️ OBRIGATÓRIA, e sem default. Como opcional com `= []`, apagar a linha que
   * a liga em `app/app/pipelines/[id]/_client.tsx` — o ÚNICO ponto de uso do
   * repo — fazia o recurso inteiro sumir do produto em silêncio: sem erro, sem
   * typecheck vermelho, com a lista simplesmente vazia. O default silencioso é
   * a fiação esquecida que ninguém vê.
   */
  tagsExistentes: string[];
  onClear: () => void;
}

export function BulkActionBar({
  selectedIds,
  stages,
  pipelineId,
  vocabulary,
  tagsExistentes,
  onClear,
}: BulkActionBarProps) {
  const t = useT();
  const user = useUser();
  const activeOrg = useActiveOrg();
  const vocab = resolveVocabulary(vocabulary);
  const bulk = useBulkAction(pipelineId);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tagInput, setTagInput] = useState("");

  // Reatribuir dono em lote é ≥manager NA ROTA (spec 04 §6.5). Sem este gate a
  // barra oferecia "Atribuir a…" para um `agent`, que clicava e recebia 403 —
  // controle decorativo, o pior tipo: parece que o sistema falhou, quando ele
  // só nunca teve permissão de mostrar aquilo.
  const podeAtribuir = Boolean(
    user.is_platform_admin || (activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager),
  );
  const { data: members } = useAssignableMembers(podeAtribuir);

  // Esc to clear selection
  useEffect(() => {
    if (selectedIds.length === 0) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClear();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedIds.length, onClear]);

  if (selectedIds.length === 0) return null;

  // O substantivo do funil só entra no SINGULAR. Plural de palavra livre é
  // heurística que erra ("Negociação" → "Negociaçãos"), e a contagem já diz
  // tudo que o plural diria: "12 selecionados" não fica pior que "12 Pacientes
  // selecionados", e nunca fica errado.
  const rotuloDaContagem =
    selectedIds.length === 1
      ? `1 ${vocab.lead} ${t("selecionado")}`
      : `${selectedIds.length} ${t("selecionados")}`;

  const runMove = (stageId: string) => {
    bulk.mutate(
      {
        action: "move",
        lead_ids: selectedIds,
        // Sem `position_in_stage`: um escalar não posiciona N cards sem
        // empatá-los, e empate quebra o `midpoint()` do arrasto seguinte. Quem
        // dá a posição de cada um é `fn_mover_leads_em_lote` (migration 0209).
        params: { stage_id: stageId },
      },
      { onSuccess: () => onClear() },
    );
  };

  const runAssign = (ownerId: string | null) => {
    bulk.mutate(
      {
        action: "assign",
        lead_ids: selectedIds,
        params: { owner_user_id: ownerId },
      },
      {
        onSuccess: (res) => {
          const n = res.data.updated_count;
          toast.success(
            ownerId === null
              ? `${n} ${t(n > 1 ? "ficaram sem responsável." : "ficou sem responsável.")}`
              : `${n} ${t(n > 1 ? "atribuídos." : "atribuído.")}`,
          );
          onClear();
        },
      },
    );
  };

  const runTagAdd = (escolhida?: string) => {
    const tag = (escolhida ?? tagInput).trim();
    if (!tag) return;
    bulk.mutate(
      { action: "tag", lead_ids: selectedIds, params: { add: [tag] } },
      {
        onSuccess: () => {
          setTagInput("");
          onClear();
        },
      },
    );
  };

  const runDelete = () => {
    bulk.mutate(
      { action: "delete", lead_ids: selectedIds, params: {} },
      {
        onSuccess: () => {
          setConfirmDelete(false);
          onClear();
        },
      },
    );
  };

  return (
    <>
      {/* `w-fit` sozinho não tinha teto: seis itens (rótulo + 5 ações) numa
          linha só passavam da largura da tela em qualquer smartphone e essa
          barra `sticky` virava scroll horizontal da PÁGINA inteira — a barra
          é `mx-auto`, então o excesso ficava invisível dos dois lados, não só
          cortado. `max-w-[calc(100vw-2rem)]` + `flex-wrap` deixam a barra
          quebrar em linhas em vez de vazar. */}
      <div
        data-lote-selecionados={selectedIds.length}
        className="sticky bottom-4 z-30 mx-auto flex w-fit max-w-[calc(100vw-2rem)] flex-wrap items-center justify-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 shadow-md"
      >
        <span className="text-sm font-medium">{rotuloDaContagem}</span>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" disabled={bulk.isPending}>
              {t("Mover para…")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>{t("Etapa")}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {stages.map((s) => (
              <DropdownMenuItem key={s.id} onClick={() => runMove(s.id)}>
                {s.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Extraído do PR #418 (@clinicacentrodosorrisosc-code): a lista de
            atendentes. Antes só dava para atribuir a SI MESMO, e "redistribuir
            a carteira" — o caso que faz a ação em lote existir — era o único
            que a barra não atendia. */}
        {podeAtribuir && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" disabled={bulk.isPending}>
                {t("Responsável…")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => runAssign(user.id)}>{t("Eu")}</DropdownMenuItem>
              {(members ?? [])
                .filter((m) => m.user_id !== user.id)
                .map((m) => (
                  <DropdownMenuItem key={m.user_id} onClick={() => runAssign(m.user_id)}>
                    {m.full_name ?? t("Sem nome")}
                  </DropdownMenuItem>
                ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => runAssign(null)}>
                {t("Remover responsável")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" disabled={bulk.isPending}>
              Tag…
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <div className="flex items-center gap-2 p-2">
              <Input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                placeholder={t("nova tag")}
                className="h-8 w-40"
                onKeyDown={(e) => {
                  // ⚠️ O MENU DO RADIX FAZ TYPEAHEAD A CADA TECLA DE UM
                  // CARACTERE dentro do conteúdo — sem exceção para `<input>`
                  // (@radix-ui/react-menu 2.1.24, `onKeyDown` do Content:
                  // `if (!isModifierKey && isCharacterKey) handleTypeaheadSearch(key)`,
                  // que faz `newItem.focus()` no item que casa o prefixo).
                  //
                  // Enquanto o menu não tinha item nenhum, isso era inofensivo.
                  // Com a lista de tags existentes ao lado, digitar "verão" com
                  // "vip" na lista levava o foco para o item "vip" já na PRIMEIRA
                  // tecla: as teclas seguintes não chegavam ao campo e o Enter
                  // aplicava "vip" a TODOS os selecionados — que ainda emite
                  // `lead.tag_added` por lead, gatilho real de automação.
                  // Medido em jsdom: sem esta linha o campo recebia "g" ao
                  // digitar "goo".
                  //
                  // A condição é a MESMA do Radix, e não um `stopPropagation`
                  // seco: assim ArrowUp/ArrowDown continuam navegando os itens a
                  // partir do campo. O Escape não depende disto — o
                  // DismissableLayer escuta `keydown` no document com
                  // `{ capture: true }`, fase que roda antes de qualquer handler
                  // React, então o menu continua fechando.
                  if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
                    e.stopPropagation();
                  }
                  if (e.key === "Enter") {
                    e.preventDefault();
                    runTagAdd();
                  }
                }}
              />
              <Button size="sm" onClick={() => runTagAdd()} disabled={!tagInput.trim()}>
                {t("Adicionar")}
              </Button>
            </div>
            {tagsExistentes
              .filter((tag) => tag.toLowerCase().includes(tagInput.trim().toLowerCase()))
              .slice(0, 10)
              .map((tag) => (
                <DropdownMenuItem key={tag} onClick={() => runTagAdd(tag)}>
                  {tag}
                </DropdownMenuItem>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          size="sm"
          variant="destructive"
          onClick={() => setConfirmDelete(true)}
          disabled={bulk.isPending}
        >
          {t("Excluir")}
        </Button>

        <Button size="sm" variant="ghost" onClick={onClear}>
          {t("Cancelar")}
        </Button>
      </div>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {selectedIds.length === 1
                ? `${t("Excluir")} 1 ${vocab.lead}?`
                : `${t("Excluir")} ${selectedIds.length} ${t("selecionados")}?`}
            </DialogTitle>
            <DialogDescription>
              {t("Esta ação remove o que está selecionado. Não pode ser desfeita.")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              {t("Cancelar")}
            </Button>
            <Button variant="destructive" onClick={runDelete} disabled={bulk.isPending}>
              {t("Excluir")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
