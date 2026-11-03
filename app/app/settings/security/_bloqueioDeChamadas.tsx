"use client";

/**
 * "Bloquear chamadas recebidas" — desligada por padrão. A chave salva no clique;
 * a mensagem a quem ligou salva no botão, porque é texto livre.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { definirBloqueioDeChamadas } from "@/app/actions/settings/definirBloqueioDeChamadas";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import { MENSAGEM_DE_RECUSA_MAX } from "@/lib/organizacao/bloqueio-de-chamadas";

const ERRO: Record<string, string> = {
  unauthenticated: "Sua sessão expirou. Entre de novo.",
  forbidden_tenant: "Você não está em nenhuma organização ativa.",
  forbidden_role: "Só um administrador da organização pode mudar esta opção.",
  mfa_required: "Confirme o segundo fator para salvar esta mudança.",
};

export function BloqueioDeChamadas({ ligado, mensagem }: { ligado: boolean; mensagem: string }) {
  const t = useT();
  const router = useRouter();
  const [valor, setValor] = useState(ligado);
  const [texto, setTexto] = useState(mensagem);
  const [salva, setSalva] = useState(mensagem);
  const [isPending, startTransition] = useTransition();

  function gravar(novoLigado: boolean, novoTexto: string, desfazer: () => void) {
    startTransition(async () => {
      const r = await definirBloqueioDeChamadas(novoLigado, novoTexto);
      if (r.ok) {
        setSalva(novoTexto.trim());
        toast.success(t("Opção salva."));
        router.refresh();
        return;
      }
      desfazer();
      toast.error(t(ERRO[r.error] ?? "Não consegui salvar agora."));
    });
  }

  function mudar(novo: boolean) {
    setValor(novo);
    // Grava o texto JÁ SALVO, não o rascunho: ligar a chave não publica o que
    // ainda está sendo digitado.
    gravar(novo, salva, () => setValor(!novo));
  }

  return (
    <Card className="p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="block_incoming_calls">{t("Bloquear chamadas recebidas")}</Label>
          <p className="max-w-2xl text-xs text-muted-foreground">
            {t(
              "Quando alguém liga por voz para o WhatsApp dos seus números, a chamada é recusada sozinha. As mensagens continuam chegando normalmente. Vem desligado: a chamada toca como antes.",
            )}
          </p>
        </div>
        <Switch
          id="block_incoming_calls"
          checked={valor}
          disabled={isPending}
          onCheckedChange={mudar}
        />
      </div>

      <div className="mt-4 flex flex-col gap-2">
        <Label htmlFor="block_incoming_calls_message">
          {t("Mensagem para quem ligou (opcional)")}
        </Label>
        <Textarea
          id="block_incoming_calls_message"
          value={texto}
          maxLength={MENSAGEM_DE_RECUSA_MAX}
          rows={3}
          disabled={isPending}
          placeholder={t("Ex.: Oi! Não atendemos ligações por aqui, mas pode escrever que respondemos já.")}
          onChange={(e) => setTexto(e.target.value)}
        />
        <p className="max-w-2xl text-xs text-muted-foreground">
          {t(
            "Quando a chamada é recusada, esta mensagem vai para quem ligou. Vazio = não manda nada. Quem insiste em ligar recebe o aviso no máximo uma vez a cada 10 minutos.",
          )}
        </p>
        <div>
          <Button
            type="button"
            size="sm"
            disabled={isPending || texto.trim() === salva}
            onClick={() => gravar(valor, texto, () => undefined)}
          >
            {t("Salvar mensagem")}
          </Button>
        </div>
      </div>
    </Card>
  );
}
