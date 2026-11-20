"use client";

/**
 * O DIÁLOGO QUE ORGANIZA AS ABAS DA INBOX (#3313, item 2) — a ordem da faixa e
 * quais abas ficam no menu ao lado dela.
 *
 * Segue o diálogo da lateral (`DialogoDosModulos`, #3008) nas três decisões que
 * importam:
 *
 *   1. **A escolha é um RASCUNHO até o Salvar.** O rascunho nasce do gravado a
 *      cada abertura; "Cancelar" não deixa resíduo.
 *   2. **A ordem só muda por `moverAba`**, pura e medida em teste. Aqui são só
 *      os botões de subir e descer: sete itens não pedem arrasto, e os botões já
 *      são o caminho de quem usa teclado ou leitor de tela.
 *   3. **"Restaurar padrão" sai de `abasPadrao()`**, a mesma fonte da faixa.
 *
 * E uma regra própria: **a última aba visível não pode ser ocultada.** O
 * interruptor dela fica travado — uma Inbox sem aba nenhuma não mostra
 * conversa. (`normalizarAbas` repete a regra no servidor.)
 *
 * O diálogo mostra só as abas que o papel da pessoa alcança. As outras voltam
 * intactas na gravação (`juntarComAsForaDoPapel`).
 */

import { useCallback, useId, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import type { InboxTab } from "@/components/inbox/InboxFilters";
import { useT } from "@/hooks/i18n/useT";
import {
  abasPadrao,
  abasPermitidasNaOrdem,
  juntarComAsForaDoPapel,
  moverAba,
  type AbaDaPessoa,
} from "@/lib/inbox/abas-da-inbox";
import { ArrowsClockwise } from "@/lib/ui/icons";

import { salvarAbasDaInbox, type ErroDasAbasDaInbox } from "@/app/actions/inbox/abasDaInbox";

interface Props {
  aberto: boolean;
  onAbertoChange: (aberto: boolean) => void;
  /** A lista GRAVADA, completa e normalizada. */
  abas: AbaDaPessoa[];
  /** As abas que o papel da pessoa alcança (`visibleInboxTabs`). */
  permitidas: readonly InboxTab[];
  /** O rótulo JÁ traduzido de cada aba — o mesmo que a faixa escreve. */
  rotuloDe: (aba: InboxTab) => string;
  /** Chamado com o que o servidor gravou — o que a faixa deve desenhar. */
  onSalvas: (abas: AbaDaPessoa[]) => void;
}

const MENSAGEM_DO_ERRO: Record<ErroDasAbasDaInbox, string> = {
  sessao: "Sua sessão expirou. Entre novamente para salvar as abas.",
  somente_leitura: "Este acesso é somente leitura: as abas não podem ser salvas.",
  validacao: "A escolha enviada não é válida. Recarregue a página e tente de novo.",
  falha: "Não foi possível salvar as abas. Tente novamente.",
};

export function DialogoDasAbas({ aberto, onAbertoChange, abas, permitidas, rotuloDe, onSalvas }: Props) {
  const t = useT();
  const [rascunho, setRascunho] = useState<AbaDaPessoa[]>(() => abasPermitidasNaOrdem(permitidas, abas));
  const [salvando, setSalvando] = useState(false);

  /**
   * O rascunho nasce do GRAVADO a cada abertura. O diálogo é aberto por fora
   * (o item do menu), então a semente é plantada quando `aberto` vira `true`
   * — guardando a abertura anterior num estado, que é o padrão do React para
   * "ajustar estado quando uma prop muda" sem efeito.
   */
  const [abertoAntes, setAbertoAntes] = useState(aberto);
  if (aberto !== abertoAntes) {
    setAbertoAntes(aberto);
    if (aberto) setRascunho(abasPermitidasNaOrdem(permitidas, abas));
  }

  const alternar = useCallback((id: InboxTab, visivel: boolean) => {
    setRascunho((atual) => atual.map((a) => (a.id === id ? { ...a, visivel } : a)));
  }, []);

  const mover = useCallback((de: number, para: number) => {
    setRascunho((atual) => moverAba(atual, de, para));
  }, []);

  const salvar = useCallback(async () => {
    setSalvando(true);
    try {
      const resposta = await salvarAbasDaInbox(juntarComAsForaDoPapel(rascunho, abas));
      if (!resposta.ok) {
        toast.error(t(MENSAGEM_DO_ERRO[resposta.erro]));
        return;
      }
      onSalvas(resposta.abas);
      toast.success(t("Abas do Inbox atualizadas."));
      onAbertoChange(false);
    } catch {
      toast.error(t(MENSAGEM_DO_ERRO.falha));
    } finally {
      setSalvando(false);
    }
  }, [abas, onAbertoChange, onSalvas, rascunho, t]);

  const visiveis = rascunho.filter((a) => a.visivel).length;
  // A dica da última visível é o PORQUÊ da chave travada: sem o vínculo, o
  // leitor de tela anuncia só "indisponível".
  const idDaDica = useId();

  return (
    <Dialog open={aberto} onOpenChange={onAbertoChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Personalizar abas")}</DialogTitle>
          <DialogDescription>
            {t(
              "Escolha quais abas aparecem e em que ordem. As ocultas ficam no menu Mais, ao lado das abas. Vale para você — os colegas continuam com as deles.",
            )}
          </DialogDescription>
        </DialogHeader>

        <ul className="space-y-1.5">
          {rascunho.map((aba, indice) => {
            const rotulo = rotuloDe(aba.id);
            // A última visível não sai da faixa: travada, para o gesto não
            // parecer possível (e o servidor repete a regra).
            const ultimaVisivel = aba.visivel && visiveis === 1;
            return (
              <li
                key={aba.id}
                data-testid={`aba-${aba.id}`}
                className="flex items-center gap-2 rounded-md border border-border bg-background p-2"
              >
                <span className="flex-1 text-sm">{rotulo}</span>
                <button
                  type="button"
                  aria-label={`${t("Mover para cima")} · ${rotulo}`}
                  disabled={indice === 0}
                  onClick={() => mover(indice, indice - 1)}
                  className="h-6 w-6 rounded-md text-xs text-muted-foreground hover:bg-surface disabled:opacity-40"
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`${t("Mover para baixo")} · ${rotulo}`}
                  disabled={indice === rascunho.length - 1}
                  onClick={() => mover(indice, indice + 1)}
                  className="h-6 w-6 rounded-md text-xs text-muted-foreground hover:bg-surface disabled:opacity-40"
                >
                  ↓
                </button>
                <Switch
                  checked={aba.visivel}
                  disabled={ultimaVisivel}
                  onCheckedChange={(visivel) => alternar(aba.id, visivel)}
                  aria-label={`${t("Mostrar aba")} · ${rotulo}`}
                  aria-describedby={ultimaVisivel ? idDaDica : undefined}
                />
              </li>
            );
          })}
        </ul>

        {visiveis === 1 && (
          <p id={idDaDica} className="text-xs text-muted-foreground">
            {t("Pelo menos uma aba precisa ficar visível.")}
          </p>
        )}

        <DialogFooter className="flex-wrap gap-2 sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            onClick={() => setRascunho(abasPermitidasNaOrdem(permitidas, abasPadrao()))}
            disabled={salvando}
          >
            <ArrowsClockwise size={14} className="mr-1" aria-hidden />
            {t("Restaurar padrão")}
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => onAbertoChange(false)} disabled={salvando}>
              {t("Cancelar")}
            </Button>
            <Button type="button" onClick={() => void salvar()} disabled={salvando}>
              {salvando ? t("Salvando…") : t("Salvar")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
