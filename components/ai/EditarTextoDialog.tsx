"use client";

import { useT } from "@/hooks/i18n/useT";
/**
 * EDITAR O TEXTO DE UM DOCUMENTO COLADO (#4596).
 *
 * Irmão do `EditarFaqDialog`, para o documento que alguém criou colando texto.
 * Antes, corrigir uma linha da política de troca exigia apagar o material e
 * criar de novo.
 *
 * O diálogo CARREGA o texto guardado antes de deixar editar — pela mesma
 * leitura da página do material (`/conteudo`). Se o que voltar não for o
 * próprio arquivo (o índice, porque o arquivo não pôde ser lido), o campo fica
 * travado: salvar os trechos do índice por cima do texto original perderia o
 * que o índice não guarda.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";

interface Props {
  sourceId: string;
  nome: string;
  aberto: boolean;
  onFechar: () => void;
  onSalvo: () => void;
}

interface Leitura {
  origem: string;
  conteudo: string | null;
}

export function EditarTextoDialog({ sourceId, nome, aberto, onFechar, onSalvo }: Props) {
  const t = useT();
  const [texto, setTexto] = useState("");
  // Nasce carregando: o cartão só monta o diálogo quando ele abre.
  const [carregando, setCarregando] = useState(true);
  const [legivel, setLegivel] = useState(false);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    if (!aberto) return;
    let vivo = true;
    apiClient
      .get<{ data: Leitura }>(`/api/v1/ai/knowledge/sources/${sourceId}/conteudo`)
      .then((res) => {
        if (!vivo) return;
        if (res.data.origem === "arquivo" && typeof res.data.conteudo === "string") {
          setTexto(res.data.conteudo);
          setLegivel(true);
        } else {
          toast.error(t("Não consegui ler este arquivo."));
        }
      })
      .catch((err) => {
        if (vivo) showApiError(err);
      })
      .finally(() => {
        if (vivo) setCarregando(false);
      });
    return () => {
      vivo = false;
    };
  }, [aberto, sourceId, t]);

  async function salvar(): Promise<void> {
    setSalvando(true);
    try {
      await apiClient.put(`/api/v1/ai/knowledge/sources/${sourceId}/texto`, { texto });
      toast.success(t("Conteúdo salvo. Estou preparando de novo — leva alguns instantes."));
      onSalvo();
      onFechar();
    } catch (err) {
      showApiError(err);
    } finally {
      setSalvando(false);
    }
  }

  const bloqueado = carregando || salvando || !legivel;

  return (
    <Dialog open={aberto} onOpenChange={(v) => !v && onFechar()}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t("Editar")} “{nome}”
          </DialogTitle>
          <DialogDescription>
            {t(
              "O que você salvar aqui substitui o conteúdo atual, e o agente é preparado de novo.",
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 space-y-2 overflow-y-auto pr-1">
          <Label htmlFor="texto-colado-editar">{t("Conteúdo")}</Label>
          <Textarea
            id="texto-colado-editar"
            data-testid="texto-editar-campo"
            rows={14}
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            disabled={bloqueado}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onFechar} disabled={salvando}>
            {t("Cancelar")}
          </Button>
          <Button
            onClick={salvar}
            // Vazio apagaria o material: quem quer tirá-lo do agente arquiva.
            disabled={bloqueado || texto.trim().length === 0}
            data-testid="texto-editar-salvar"
          >
            {salvando ? t("Salvando…") : t("Salvar conteúdo")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
