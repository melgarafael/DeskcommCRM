"use client";

import { useT } from "@/hooks/i18n/useT";
/**
 * O QUE O AGENTE APRENDEU DESTE MATERIAL.
 *
 * A tela mostrava uma contagem ("4 trechos") e nada mais. Contagem não responde
 * à pergunta que a pessoa faz quando o agente erra — *"o que exatamente ele
 * leu?"* — e sem resposta a única auditoria possível era consultar o banco, num
 * produto vendido para quem não programa.
 *
 * Mostrar o trecho, e não o vetor: os 1536 números não têm leitor humano.
 */
import { useQuery } from "@tanstack/react-query";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiClient } from "@/lib/api/client";

interface Trecho {
  id: string;
  position: number;
  content: string;
  token_count: number;
  metadata: Record<string, unknown> | null;
}

interface Resposta {
  nome: string;
  trechos: Trecho[];
  total: number;
  truncado?: boolean;
}

interface Props {
  sourceId: string;
  nome: string;
  aberto: boolean;
  onFechar: () => void;
}

export function TrechosDoMaterialDialog({ sourceId, nome, aberto, onFechar }: Props) {
  const t = useT();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["ai", "knowledge", "trechos", sourceId],
    queryFn: async () => {
      const res = await apiClient.get<{ data: Resposta }>(
        `/api/v1/ai/knowledge/sources/${sourceId}/trechos`,
      );
      return res.data;
    },
    enabled: aberto,
  });

  return (
    <Dialog open={aberto} onOpenChange={(v) => !v && onFechar()}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {t("O que o agente aprendeu de")} “{nome}”
          </DialogTitle>
          <DialogDescription>
            {t(
              "São estes os trechos que ele procura antes de responder. Quando ele erra sobre este assunto, é aqui que se vê o porquê.",
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-3 overflow-y-auto" data-testid="material-trechos-lista">
          {isLoading ? <p className="text-sm text-text-muted">{t("Carregando…")}</p> : null}
          {isError ? (
            <p className="text-sm text-error-fg">{t("Não consegui ler os trechos agora.")}</p>
          ) : null}
          {data && data.trechos.length === 0 ? (
            <p className="text-sm text-text-muted">
              {t(
                "Este material ainda não foi preparado — não há trecho nenhum para o agente encontrar.",
              )}
            </p>
          ) : null}
          {/* `trecho`, e não `t`: o `t` do `useT()` já ocupa o nome neste escopo. */}
          {data?.trechos.map((trecho) => (
            <div key={trecho.id} className="rounded-2xl border border-border bg-surface p-3">
              <div className="mb-1 flex items-center justify-between text-xs text-text-muted">
                <span>
                  {t("Trecho")} {trecho.position + 1}
                </span>
                <span>
                  {trecho.token_count} {t("tokens")}
                </span>
              </div>
              <p className="whitespace-pre-wrap break-words text-sm">{trecho.content}</p>
            </div>
          ))}
          {data?.truncado ? (
            <p className="text-xs text-text-muted">
              {t("Mostrando os primeiros trechos de")} {data.total}.{" "}
              {t(
                "Uma tela não folheia mil pedaços — o restante está no acervo e o agente alcança todos.",
              )}
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
