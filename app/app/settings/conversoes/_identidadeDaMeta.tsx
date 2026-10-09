"use client";

/**
 * A identidade da Meta nas vendas de clique-para-WhatsApp (#2098): ID da Página
 * e ID da conta do WhatsApp Business, em `organizations.settings.conversions`.
 *
 * ─── Por que é um card separado, e não um campo do formulário da conexão ────
 *
 * O formulário ao lado grava em `ad_platform_connections`, que não tem coluna
 * para isto sem migration. Estes ids são configuração da ORGANIZAÇÃO (cada
 * cliente de uma agência tem a sua Página) e moram no jsonb de `settings`, no
 * mesmo bolso de "Enviar vendas pelo canal da conversa".
 *
 * ─── Por que vazio pode ────────────────────────────────────────────────────
 *
 * Nem toda instalação reporta venda clique-para-WhatsApp, e gravar em branco
 * seria só ruído. Com os dois vazios o envio continua exatamente como antes —
 * e a recusa da Meta aparece na lista de pendências com a frase dela, que é o
 * estado atual do sistema para quem ainda não configurou.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { definirIdentidadeDaConversao } from "@/app/actions/settings/definirIdentidadeDaConversao";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

const ERRO: Record<string, string> = {
  validation_failed: "Confira os campos: algum valor não está no formato esperado.",
  unauthenticated: "Sua sessão expirou. Entre de novo.",
  forbidden_tenant: "Você não está em nenhuma organização ativa.",
  forbidden_role: "Só um administrador da organização pode mudar esta conexão.",
  mfa_required: "Confirme o segundo fator para salvar esta mudança.",
  erro_ao_gravar: "Não consegui gravar agora. Tente de novo em instantes.",
};

export function IdentidadeDaConversao({
  pageId,
  whatsappBusinessAccountId,
  idioma,
}: {
  pageId: string | null;
  whatsappBusinessAccountId: string | null;
  idioma: Idioma;
}) {
  const t = (texto: string) => traduzir(texto, idioma);
  const router = useRouter();
  const [pagina, setPagina] = useState(pageId ?? "");
  const [waba, setWaba] = useState(whatsappBusinessAccountId ?? "");
  const [isPending, startTransition] = useTransition();

  function salvar(evento: React.FormEvent) {
    evento.preventDefault();
    startTransition(async () => {
      const r = await definirIdentidadeDaConversao({
        page_id: pagina.trim(),
        whatsapp_business_account_id: waba.trim(),
      });
      if (r.ok) {
        toast.success(t("Identidade salva."));
        router.refresh();
        return;
      }
      toast.error(t(ERRO[r.error] ?? "Não consegui salvar agora."));
    });
  }

  return (
    <Card className="p-6">
      <form onSubmit={salvar} className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold">
            {t("Página e conta do WhatsApp Business das vendas de clique-para-WhatsApp")}
          </h3>
          <p className="max-w-2xl text-xs text-muted-foreground">
            {t(
              "Quando a venda vem de anúncio clique-para-WhatsApp, a Meta exige o ID da Página ou o ID da conta do WhatsApp Business junto do evento. Sem nenhum dos dois, ela recusa a venda e o motivo aparece na lista de pendências. Preencha o que estiver vinculado ao seu conjunto de dados.",
            )}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="meta_page_id">{t("ID da Página")}</Label>
          <Input
            id="meta_page_id"
            inputMode="numeric"
            value={pagina}
            onChange={(e) => setPagina(e.target.value)}
            placeholder="123456789012345"
          />
          <p className="text-xs text-muted-foreground">
            {t("Só números. É o ID da página do Facebook que abre a conversa do anúncio.")}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="meta_waba_id">{t("ID da conta do WhatsApp Business")}</Label>
          <Input
            id="meta_waba_id"
            inputMode="numeric"
            value={waba}
            onChange={(e) => setWaba(e.target.value)}
            placeholder="104987654321098"
          />
          <p className="text-xs text-muted-foreground">
            {t(
              "Só números. Serve quando não há página a informar: a Meta aceita um ou outro, não os dois juntos.",
            )}
          </p>
        </div>

        <div>
          <Button type="submit" disabled={isPending}>
            {isPending ? t("Salvando…") : t("Salvar")}
          </Button>
        </div>
      </form>
    </Card>
  );
}
