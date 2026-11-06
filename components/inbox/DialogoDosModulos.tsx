"use client";

/**
 * O DIÁLOGO QUE ESCOLHE A LATERAL (#3008) — quais módulos aparecem e em que
 * ordem.
 *
 * Três decisões que valem explicação:
 *
 *   1. **A escolha é um RASCUNHO até o Salvar.** Desligar um módulo mexe na
 *      lateral inteira (e no que a pessoa vê da conversa); gravar a cada
 *      interruptor faria um `updateUser` por clique e uma tela que muda de
 *      tamanho enquanto se configura. "Cancelar" volta ao que estava gravado
 *      porque o rascunho nasce do gravado toda vez que o diálogo abre.
 *
 *   2. **Arrastar E os botões.** O `@hello-pangea/dnd` é o mesmo do Kanban e
 *      das respostas rápidas — mas arrastar não é acessível a quem usa teclado
 *      (o pacote até tem suporte, e ele não é óbvio), então cada linha também
 *      tem "mover para cima/baixo". Dois gestos, uma lista, uma regra: a ordem
 *      só muda por `moverModulo`, que é pura e medida em teste.
 *
 *   3. **Nasce com a lista normalizada.** A ordem que o diálogo mostra é a
 *      mesma que a lateral desenha: `modulos` chega do servidor já passado por
 *      `normalizarModulos`, e "Restaurar padrão" chama `modulosPadrao()` — a
 *      MESMA fonte da lateral. Um diálogo com lista própria divergiria da tela
 *      no primeiro módulo novo.
 */

import { useCallback, useState } from "react";
import { DragDropContext, Draggable, Droppable, type DropResult } from "@hello-pangea/dnd";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";
import {
  ROTULO_DO_MODULO,
  moverModulo,
  modulosPadrao,
  type ModuloDaLateral,
} from "@/lib/inbox/modulos-da-lateral";
import { ArrowsClockwise, DragHandle, Gear } from "@/lib/ui/icons";

import { salvarModulosDaLateral, type ErroDosModulosDaLateral } from "@/app/actions/inbox/modulosDaLateral";

interface Props {
  /** A lista GRAVADA, já normalizada pelo servidor. */
  modulos: ModuloDaLateral[];
  /** Chamado com o que o servidor gravou — o que a lateral deve desenhar. */
  onSalvos: (modulos: ModuloDaLateral[]) => void;
}

const MENSAGEM_DO_ERRO: Record<ErroDosModulosDaLateral, string> = {
  sessao: "Sua sessão expirou. Entre novamente para salvar a lateral.",
  somente_leitura: "Este acesso é somente leitura: a lateral não pode ser salva.",
  validacao: "A escolha enviada não é válida. Recarregue a página e tente de novo.",
  falha: "Não foi possível salvar a lateral. Tente novamente.",
};

export function DialogoDosModulos({ modulos, onSalvos }: Props) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  const [rascunho, setRascunho] = useState<ModuloDaLateral[]>(modulos);
  const [salvando, setSalvando] = useState(false);

  /**
   * O rascunho nasce do GRAVADO a cada abertura: sair sem salvar não deixa
   * resíduo para a próxima vez. É no `onOpenChange` e não num `useEffect` que
   * observa `aberto` — o efeito que chama `setState` síncrono redesenha duas
   * vezes e é o que o `react-hooks/set-state-in-effect` cobra.
   */
  const aoMudarAbertura = useCallback((proximo: boolean) => {
    if (proximo) setRascunho(modulos);
    setAberto(proximo);
  }, [modulos]);

  const alternar = useCallback((id: string, visivel: boolean) => {
    setRascunho((atual) => atual.map((m) => (m.id === id ? { ...m, visivel } : m)));
  }, []);

  const mover = useCallback((de: number, para: number) => {
    setRascunho((atual) => moverModulo(atual, de, para));
  }, []);

  const aoSoltar = useCallback((resultado: DropResult) => {
    if (!resultado.destination) return;
    if (resultado.source.index === resultado.destination.index) return;
    mover(resultado.source.index, resultado.destination.index);
  }, [mover]);

  const salvar = useCallback(async () => {
    setSalvando(true);
    try {
      const resposta = await salvarModulosDaLateral(rascunho);
      if (!resposta.ok) {
        toast.error(t(MENSAGEM_DO_ERRO[resposta.erro]));
        return;
      }
      onSalvos(resposta.modulos);
      toast.success(t("Lateral do Inbox atualizada."));
      setAberto(false);
    } catch {
      toast.error(t(MENSAGEM_DO_ERRO.falha));
    } finally {
      setSalvando(false);
    }
  }, [onSalvos, rascunho, t]);

  const escondidos = rascunho.filter((m) => !m.visivel).length;

  return (
    <Dialog open={aberto} onOpenChange={aoMudarAbertura}>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={t("Personalizar lateral")}
          title={t("Personalizar lateral")}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-surface hover:text-text focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Gear size={14} aria-hidden />
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Personalizar lateral")}</DialogTitle>
          <DialogDescription>
            {t(
              "Escolha o que aparece nesta lateral e em que ordem. Vale para você — os colegas continuam com a deles.",
            )}
          </DialogDescription>
        </DialogHeader>

        <DragDropContext onDragEnd={aoSoltar}>
          <Droppable droppableId="modulos-da-lateral">
            {(provido) => (
              <ul ref={provido.innerRef} {...provido.droppableProps} className="space-y-1.5">
                {rascunho.map((modulo, indice) => (
                  <Draggable key={modulo.id} draggableId={modulo.id} index={indice}>
                    {(arrastavel) => (
                      <li
                        ref={arrastavel.innerRef}
                        {...arrastavel.draggableProps}
                        data-testid={`modulo-${modulo.id}`}
                        className="flex items-center gap-2 rounded-md border border-border bg-background p-2"
                      >
                        <span
                          {...arrastavel.dragHandleProps}
                          aria-label={t("Arrastar para reordenar")}
                          className="shrink-0 cursor-grab text-muted-foreground"
                        >
                          <DragHandle size={14} aria-hidden />
                        </span>
                        <span className="flex-1 text-sm">{t(ROTULO_DO_MODULO[modulo.id])}</span>
                        {/* Os botões existem para quem não arrasta: teclado,
                            leitor de tela e ponteiro impreciso. Desabilitados
                            nas pontas, para o gesto não parecer possível. */}
                        <button
                          type="button"
                          aria-label={`${t("Mover para cima")} · ${t(ROTULO_DO_MODULO[modulo.id])}`}
                          disabled={indice === 0}
                          onClick={() => mover(indice, indice - 1)}
                          className="h-6 w-6 rounded-md text-xs text-muted-foreground hover:bg-surface disabled:opacity-40"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          aria-label={`${t("Mover para baixo")} · ${t(ROTULO_DO_MODULO[modulo.id])}`}
                          disabled={indice === rascunho.length - 1}
                          onClick={() => mover(indice, indice + 1)}
                          className="h-6 w-6 rounded-md text-xs text-muted-foreground hover:bg-surface disabled:opacity-40"
                        >
                          ↓
                        </button>
                        <Switch
                          checked={modulo.visivel}
                          onCheckedChange={(visivel) => alternar(modulo.id, visivel)}
                          aria-label={`${t("Mostrar módulo")} · ${t(ROTULO_DO_MODULO[modulo.id])}`}
                        />
                      </li>
                    )}
                  </Draggable>
                ))}
                {provido.placeholder}
              </ul>
            )}
          </Droppable>
        </DragDropContext>

        {escondidos > 0 && (
          <p className="text-xs text-muted-foreground">
            {t("Módulos ocultos continuam existindo: nada é apagado nem desativado no CRM.")}
          </p>
        )}

        <DialogFooter className="flex-wrap gap-2 sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            onClick={() => setRascunho(modulosPadrao())}
            disabled={salvando}
          >
            <ArrowsClockwise size={14} className="mr-1" aria-hidden />
            {t("Restaurar padrão")}
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => setAberto(false)} disabled={salvando}>
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
