"use client";
/**
 * "MOVER PARA FILA" (#3876) — o gesto humano que faltava para o
 * `PUT /api/v1/conversations/[id]/sector`.
 *
 * ─── O que existia, e o que não existia ────────────────────────────────────
 *
 * A rota está pronta desde a 9062: papel mínimo `agent`, módulo Setores
 * conferido antes de autorizar (desligado ⇒ 404), RLS de `conversations`
 * valendo na escrita, 409 para conversa encerrada e 422 para setor que não é
 * desta organização. E NINGUÉM a chamava: `git grep 'conversations/.*\\/sector'`
 * em `components/` voltava vazio. Este arquivo é o consumidor.
 *
 * ─── Por que o item SOME, e não fica desabilitado ──────────────────────────
 *
 * "Exportar conversa" fica desabilitado porque o recurso é da leitura: qualquer
 * pessoa de atendimento vê o histórico. Mover de fila é ação de ESCRITA e não
 * existe para `viewer` em lugar nenhum do produto — um item permanentemente
 * cinza só ensinaria que o produto tem uma coisa que essa pessoa nunca vai
 * poder usar. Quem pode mover é quem a rota aceita: `agent`+ (e plataforma),
 * com o módulo ligado e a conversa ainda aberta. As três condições são as
 * mesmas que a rota revalida — a tela espelha a régua, nunca a substitui.
 *
 * ─── O diálogo mora FORA do menu ⋯ ─────────────────────────────────────────
 *
 * Mesmo desenho do convite e da reserva (#3003): modal dentro de menu modal
 * deixa a página inteira `aria-hidden` enquanto o menu está aberto. O item do
 * menu só levanta a bandeira; o diálogo é irmão dele no cabeçalho.
 */
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { useDefinirFilaDaConversa } from "@/hooks/inbox/useDefinirFilaDaConversa";
import { useSectors, type Sector } from "@/hooks/team/useSectors";
import { ApiError } from "@/lib/api/types";
import { ROLE_RANK, type Role } from "@/lib/auth/types";
import { cn } from "@/lib/utils";

/**
 * Quem pode mover a conversa de fila — espelho das três recusas da rota.
 *
 * Exportada porque é a única parte desta tela que é REGRA, e regra se mede sem
 * montar dropdown: `viewer` ⇒ false (403 na rota), módulo desligado ⇒ false
 * (404), conversa encerrada ⇒ false (409). Nenhuma delas "esconde por estética":
 * as três são a resposta que o servidor daria.
 */
export function podeMoverParaFila(args: {
  papel: Role | undefined;
  modulos: readonly string[];
  encerrada: boolean;
  plataformaAdmin?: boolean;
}): boolean {
  if (args.encerrada) return false;
  if (!args.modulos.includes("setores")) return false;
  if (args.plataformaAdmin) return true;
  return args.papel != null && ROLE_RANK[args.papel] >= ROLE_RANK.agent;
}

/** O ponto de cor da fila (migration 9084); sem cor, não desenha nada. */
function PontoDaFila({ cor, id }: { cor: string | null; id: string }) {
  if (cor === null) return null;
  return (
    <span
      aria-hidden
      data-cor-da-fila={id}
      className="inline-block size-2 shrink-0 rounded-full"
      style={{ backgroundColor: cor }}
    />
  );
}

interface ItemProps {
  encerrada: boolean;
  /** Levanta a bandeira do diálogo; o menu fecha como qualquer outro item. */
  onAbrir: () => void;
}

/**
 * O item do menu ⋯. Devolve `null` quando a rota recusaria — ver
 * `podeMoverParaFila`. Os hooks rodam ANTES do retorno, como manda a ordem.
 */
export function ItemMoverParaFila({ onAbrir, encerrada }: ItemProps) {
  const t = useT();
  const { user, activeOrg } = useAuth();
  // Mesma fonte de `useModulosLigados` (`AuthProvider.tsx:129-131`), sem o
  // hook: os dublês de `AuthProvider` nos testes do cabeçalho não precisam
  // exportá-lo para montar a barra.
  const modulos = activeOrg?.modulos_ligados ?? [];
  const pode = podeMoverParaFila({
    papel: activeOrg?.role,
    modulos,
    encerrada,
    plataformaAdmin: user.is_platform_admin === true && !user.support,
  });
  if (!pode) return null;
  return (
    <DropdownMenuItem
      data-testid="acao-mover-para-fila"
      title={t("Classifica esta conversa em outra fila de atendimento.")}
      onSelect={() => onAbrir()}
    >
      <span className="inline-flex items-center gap-2">{t("Mover para fila")}</span>
    </DropdownMenuItem>
  );
}

interface DialogoProps {
  conversationId: string;
  /** A fila em que a conversa está hoje — marcada na lista, não pré-selecionada. */
  filaAtual: string | null;
  aberto: boolean;
  onAbertoChange: (aberto: boolean) => void;
}

/**
 * O diálogo: escolhe a fila e grava. A fila ATUAL aparece com o selo, e não
 * marcada: escolher a mesma fila é um no-op que a rota aceita em silêncio
 * (`sobrescreverSetorManual`), e um rádio já marcado faria o operador achar que
 * clicou em algo.
 */
export function DialogoMoverParaFila({
  conversationId,
  filaAtual,
  aberto,
  onAbertoChange,
}: DialogoProps) {
  const t = useT();
  const { activeOrg } = useAuth();
  const modulos = activeOrg?.modulos_ligados ?? [];
  const { data: respostaDasFilas } = useSectors(modulos.includes("setores") && aberto);
  const filas: Sector[] = respostaDasFilas?.data ?? [];
  const mover = useDefinirFilaDaConversa();
  const [escolhida, setEscolhida] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  // Fechar limpa a escolha: reabrir no mesmo item faria a próxima conversa
  // herdar a fila escolhida para a anterior — a tela mentindo sobre um gesto.
  useEffect(() => {
    if (!aberto) {
      setEscolhida(null);
      setErro(null);
    }
  }, [aberto]);

  async function confirmar() {
    if (escolhida === null || mover.isPending) return;
    setErro(null);
    try {
      await mover.mutateAsync({ conversationId, sectorId: escolhida });
      onAbertoChange(false);
    } catch (err) {
      // A mensagem da rota já vem traduzida no idioma de quem clicou; o
      // fallback cobre o que não é `ApiError` (rede, proxy).
      setErro(err instanceof ApiError ? err.message : t("Não foi possível mover a conversa de fila."));
    }
  }

  return (
    <Dialog open={aberto} onOpenChange={onAbertoChange}>
      <DialogContent data-testid="dialogo-mover-para-fila">
        <DialogHeader>
          <DialogTitle>{t("Mover para fila")}</DialogTitle>
          <DialogDescription>
            {t("Escolha a fila para onde esta conversa vai. Se ela estiver sem dono, volta para a distribuição.")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1">
          {filas.map((fila) => (
            <button
              key={fila.id}
              type="button"
              data-fila={fila.id}
              aria-pressed={escolhida === fila.id}
              onClick={() => setEscolhida(fila.id)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition-colors",
                "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
                escolhida === fila.id
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border bg-transparent hover:bg-surface-elevated",
              )}
            >
              <PontoDaFila cor={fila.color} id={fila.id} />
              <span className="min-w-0 flex-1 truncate">{fila.name}</span>
              {fila.id === filaAtual && (
                <span className="shrink-0 text-[10px] text-text-subtle">{t("Fila atual")}</span>
              )}
            </button>
          ))}
          {filas.length === 0 && (
            <p className="px-1 py-2 text-xs text-text-subtle">{t("Nenhuma fila cadastrada.")}</p>
          )}
        </div>

        {erro !== null && (
          <p role="alert" className="text-xs text-destructive" data-testid="erro-ao-mover-de-fila">
            {erro}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onAbertoChange(false)}>
            {t("Cancelar")}
          </Button>
          <Button disabled={escolhida === null || mover.isPending} onClick={() => void confirmar()}>
            {mover.isPending ? t("Movendo…") : t("Mover")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
