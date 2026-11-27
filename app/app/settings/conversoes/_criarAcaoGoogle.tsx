"use client";

/**
 * Botão "Criar no Google": cria a ação de conversão (tipo importação de
 * cliques) na conta da organização e devolve o ID para o campo ao lado.
 *
 * Sem developer token na instalação o botão aparece DESLIGADO com a razão —
 * o ID continua podendo ser colado à mão, que é o caminho de sempre.
 */
import { useTransition } from "react";
import { toast } from "sonner";

import { criarAcaoDeConversaoGoogle } from "@/app/actions/settings/acoesDeConversaoGoogle";
import { Button } from "@/components/ui/button";
import type { CategoriaDeConversao } from "@/lib/conversoes/regras-google";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

export function CriarAcaoNoGoogle({
  idioma,
  habilitado,
  nome,
  categoria,
  incluirEmConversoes,
  googleCustomerId,
  googleLoginCustomerId,
  motivoDesabilitado,
  onCriada,
}: {
  idioma: Idioma;
  habilitado: boolean;
  nome: string;
  categoria: CategoriaDeConversao;
  incluirEmConversoes: boolean;
  /** Omitido/null usa a conta padrão da conexão de envio. */
  googleCustomerId?: string | null;
  googleLoginCustomerId?: string | null;
  motivoDesabilitado?: string;
  onCriada: (id: string, nomeFinal: string) => void;
}) {
  const t = (texto: string) => traduzir(texto, idioma);
  const [isPending, startTransition] = useTransition();

  function criar() {
    if (!nome.trim()) {
      toast.error(t("Dê um nome à conversão antes de criar a ação no Google."));
      return;
    }
    startTransition(async () => {
      const r = await criarAcaoDeConversaoGoogle({
        nome,
        categoria,
        incluir_em_conversoes: incluirEmConversoes,
        ...(googleCustomerId
          ? {
              google_customer_id: googleCustomerId,
              google_login_customer_id: googleLoginCustomerId || null,
            }
          : {}),
      });
      if (r.ok) {
        onCriada(r.dados.id, r.dados.nome);
        toast.success(`${t("Ação criada no Google:")} ${r.dados.nome}. ${t("Salve as regras.")}`);
        return;
      }
      toast.error(r.detalhe ?? t("Não consegui criar a ação no Google agora."));
    });
  }

  return (
    <Button
      type="button"
      variant="outline"
      onClick={criar}
      disabled={!habilitado || isPending}
      title={
        habilitado
          ? t("Cria a ação de conversão na sua conta do Google Ads")
          : (motivoDesabilitado ??
            t(
              "Criar direto no Google exige o developer token do Google Ads nesta instalação e a conta reconectada. Enquanto isso, cole o ID da ação.",
            ))
      }
    >
      {isPending ? t("Criando...") : t("Criar no Google")}
    </Button>
  );
}
