"use client";

import { useT } from "@/hooks/i18n/useT";
import type { Lead } from "@/lib/types/leads";
import { Paperclip } from "@/lib/ui/icons";

interface Props {
  lead: Pick<Lead, "anexos">;
}

/**
 * Os campos `file` do funil no card do quadro (#2829, fatia 1) — a contagem e o
 * documento, sem abrir o dossiê.
 *
 * Antes disto o card não desenhava NENHUM campo do funil, e o `file` era o único
 * que dependia disso para existir na tela: o operador criava o campo, subia o
 * PDF no dossiê e o quadro — a tela onde ele olha o funil inteiro — continuava
 * sem dizer que aquele negócio tem documento. O campo ficava "salvo e invisível".
 *
 * Cada arquivo é um `<a>` com `stopPropagation`: o card inteiro abre o dossiê ao
 * clique, e abrir um contrato não pode abrir o dossiê por cima (mesma regra dos
 * links de contato em `ContatoNoCard`). O `href` é o caminho de mídia da rota de
 * anexos — a MESMA porta que a listagem serve, com URL assinada de 60 s; um link
 * direto para o Storage expiraria antes de alguém clicar.
 *
 * Campo VAZIO aparece como tal (`0` + "Nenhum arquivo anexado"): sumir
 * transformaria "documento faltando" em "campo inexistente", que é o defeito de
 * origem. Um funil sem campo `file` não renderiza nada — o card de quem não usa
 * o recurso não muda em nada.
 */
export function ArquivosNoCard({ lead }: Props) {
  const t = useT();
  const blocos = lead.anexos ?? [];
  if (blocos.length === 0) return null;

  return (
    <div className="mt-1 space-y-1 text-xs text-text-muted" data-testid="arquivos-no-card">
      {blocos.map((bloco) => {
        const contagem = `${bloco.total} ${bloco.total === 1 ? t("arquivo") : t("arquivos")}`;
        const descricao = `${bloco.rotulo}: ${contagem}`;
        const restantes = bloco.total - bloco.arquivos.length;

        return (
          <div
            key={bloco.campo}
            data-testid={`arquivos-do-campo-${bloco.campo}`}
            className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1"
          >
            {/* role="img": um span nu não aceita aria-label (aria-prohibited-attr),
                e o ícone sozinho não diz nada a leitor de tela. */}
            <span
              role="img"
              aria-label={descricao}
              title={descricao}
              className="inline-flex shrink-0 items-center gap-1 tabular-nums text-text"
            >
              <Paperclip size={12} aria-hidden />
              {bloco.total}
            </span>
            <span className="shrink-0 truncate">{bloco.rotulo}</span>
            {bloco.total === 0 ? (
              <span className="truncate text-text-muted">{t("Nenhum arquivo anexado")}</span>
            ) : (
              <span className="flex min-w-0 flex-wrap gap-1">
                {bloco.arquivos.map((arquivo) => (
                  <a
                    key={arquivo.id}
                    href={arquivo.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={arquivo.nome}
                    aria-label={`${t("Abrir arquivo")}: ${arquivo.nome}`}
                    onClick={(e) => e.stopPropagation()}
                    className="max-w-[10rem] truncate rounded-md border border-border px-1.5 py-0.5 text-[11px] leading-4 text-text-muted hover:border-accent hover:text-accent"
                  >
                    {arquivo.nome}
                  </a>
                ))}
                {restantes > 0 && (
                  <span
                    className="text-[11px] leading-4"
                    title={`${bloco.total} ${t("arquivos")}`}
                  >
                    +{restantes}
                  </span>
                )}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
