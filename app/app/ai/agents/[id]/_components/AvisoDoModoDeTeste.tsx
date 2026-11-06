"use client";
/**
 * O aviso que explica, na TELA DO AGENTE, por que a IA publicada não responde
 * (#3976).
 *
 * A frase e o link são só a apresentação: quem decide se há aviso, e qual, é
 * `decidirAvisoDoModoDeTeste` (`lib/ai/elegibilidade/aviso-do-modo-de-teste.ts`).
 * Os dois consumidores — o cartão "Número conectado" do editor e a aba Teste —
 * passam pela mesma regra, para a tela não contar uma história e o gate outra.
 *
 * O LINK É POR PERMISSÃO: o painel que cadastra os números de teste exige
 * administrador (`GET/PATCH /api/v1/channel-sessions/[id]/ai-access` devolvem
 * 403 abaixo disso). Quem só pode ver o canal recebe o motivo e o caminho por
 * escrito, sem um link que termine em 403.
 */
import Link from "next/link";

import { useT } from "@/hooks/i18n/useT";
import { Info } from "@/lib/ui/icons";
import type { AvisoDoModoDeTeste as Aviso } from "@/lib/ai/elegibilidade/aviso-do-modo-de-teste";

/** Onde os números de teste se cadastram — o mesmo cartão do canal em Conexões. */
export const DESTINO_DO_ACESSO_DA_IA = "/app/connections";

export function AvisoDoModoDeTeste({
  aviso,
  podeConfigurar,
  notaDoSandbox = false,
}: {
  aviso: Aviso;
  /** `false` = sem permissão de editar o canal: motivo sem link que dá 403. */
  podeConfigurar: boolean;
  /** Na aba Teste, lembra que o teste da tela não passa pelo canal. */
  notaDoSandbox?: boolean;
}) {
  const t = useT();
  if (aviso.tipo === "nenhum") return null;

  const motivo =
    aviso.tipo === "lista_vazia"
      ? t(
          "Nenhum número autorizado neste canal: a IA não responde ninguém. Cadastre o número de quem vai testar para receber as respostas automáticas.",
        )
      : t(
          "O número {numero} não está na lista de teste deste canal: a IA não responde a ele. Cadastre-o para receber as respostas automáticas.",
        ).replace("{numero}", () => aviso.numero);

  return (
    <div
      data-testid="aviso-modo-de-teste"
      role="status"
      className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs"
    >
      <Info className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
      <div className="space-y-1">
        <p className="font-medium text-amber-700 dark:text-amber-400">
          {t("Este número está em modo de teste")}
        </p>
        <p className="text-muted-foreground">{motivo}</p>
        {notaDoSandbox ? (
          <p className="text-muted-foreground">
            {t("O teste aqui não passa pelo canal: no WhatsApp real, a IA não responderia a este número.")}
          </p>
        ) : null}
        {podeConfigurar ? (
          <p>
            <Link
              href={DESTINO_DO_ACESSO_DA_IA}
              className="font-medium text-foreground underline underline-offset-4"
            >
              {t("Configurar acesso da IA")}
            </Link>
          </p>
        ) : (
          <p className="text-muted-foreground">
            {t("Peça a um administrador para cadastrar o número de teste no cartão deste canal em Conexões.")}
          </p>
        )}
      </div>
    </div>
  );
}
