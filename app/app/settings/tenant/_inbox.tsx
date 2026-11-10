"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { atualizarBloqueioAteAssumir } from "@/app/actions/settings/atualizarInterfaceDaEmpresa";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";
import { irAoDesafioDeMfa } from "@/lib/auth/ir-ao-desafio-de-mfa";
import { lerInterface } from "@/lib/navigation/interface";

interface Props {
  /** O que está gravado hoje em `organizations.interface_settings`. */
  initial: unknown;
}

/**
 * O bloqueio da caixa de mensagem até assumir (#3012), em
 * Configurações → Empresa — o mesmo cartão de preferências da ORGANIZAÇÃO que já
 * grava `interface_settings`.
 *
 * A regra viaja na preferência que já existe (nenhum schema novo). Este cartão
 * manda SÓ a chave (`atualizarBloqueioAteAssumir`), e o servidor a troca dentro
 * do que está gravado: mandar o objeto lido na montagem desfaria a escolha de
 * menu feita logo acima depois que a página abriu — as duas moram no mesmo campo.
 *
 * Ligada, vale para a EMPRESA toda: não é preferência de um vínculo, e não
 * concede nem tira acesso. Desligada é o padrão de quem nunca abriu esta tela.
 */
export function InboxDaEmpresaForm({ initial }: Props) {
  const t = useT();
  const [ligado, setLigado] = useState(() => lerInterface(initial).settings.bloquearAteAssumir === true);
  const [isPending, startTransition] = useTransition();

  function salvar() {
    startTransition(async () => {
      const resultado = await atualizarBloqueioAteAssumir(ligado);
      if (resultado.ok) {
        toast.success(t("Bloqueio da caixa de mensagem salvo."));
        return;
      }
      if (resultado.error === "mfa_required") return irAoDesafioDeMfa();
      toast.error(t("Não foi possível salvar o bloqueio da caixa de mensagem."));
    });
  }

  return (
    <Card className="space-y-3 p-4">
      <h2 className="text-sm font-medium">{t("Inbox")}</h2>
      <p className="text-xs text-muted-foreground">
        {t(
          "Regras de atendimento que valem para esta empresa inteira. Não mudam permissões: papel e acesso continuam decidindo o que cada pessoa alcança.",
        )}
      </p>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={ligado}
          onChange={(e) => setLigado(e.target.checked)}
          className="mt-1"
        />
        <span>
          {t("Bloquear a caixa de mensagem até o atendente assumir a conversa")}
          <span className="block text-xs text-muted-foreground">
            {t(
              "Com a opção ligada, quem abre uma conversa sem responsável não consegue digitar nem enviar até clicar em Assumir. O botão Assumir continua sempre visível, e quem já assumiu continua respondendo normalmente.",
            )}
          </span>
        </span>
      </label>
      <Button type="button" size="sm" disabled={isPending} onClick={salvar}>
        {t("Aplicar regras de atendimento")}
      </Button>
    </Card>
  );
}
