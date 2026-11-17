"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";

/**
 * O botão **Ver texto retido** da mensagem que o CONTATO apagou (#4500).
 *
 * ═══ O que este componente NÃO faz ═════════════════════════════════════════
 *
 * Não recebe o texto. O corpo da apagada não vem no payload da conversa
 * (`mascararTextoRetido`) — o clique é que pede, e quem responde é o servidor,
 * que confere organização, acesso à conversa e perfil autorizado. É essa
 * separação que faz o caso "sem permissão" ser de verdade: a resposta do 403 não
 * tem o texto para o navegador esconder.
 *
 * ═══ Os quatro estados ═════════════════════════════════════════════════════
 *
 *   verificando  → "Verificando permissão…" (o botão sai de cena enquanto isso)
 *   revelado     → o texto entra no lugar do botão; o aviso de exclusão
 *                  CONTINUA acima, porque ele é do balão, não deste componente
 *   negado       → "Você não tem permissão para ver este texto"
 *   indisponivel → "Texto não disponível"
 *
 * Falha de rede cai em "indisponivel", e não em "sem permissão": dizer que
 * falta permissão quando o que faltou foi conexão seria mentira sobre a pessoa.
 */
type Estado = "oculto" | "verificando" | "revelado" | "negado" | "indisponivel";

export function TextoRetidoDaMensagem({ mensagemId }: { mensagemId: string }) {
  const t = useT();
  const [estado, setEstado] = useState<Estado>("oculto");
  const [texto, setTexto] = useState<string | null>(null);

  const revelar = async () => {
    setEstado("verificando");
    try {
      const resposta = await fetch(`/api/v1/messages/${mensagemId}/texto-retido`, {
        method: "POST",
        headers: { accept: "application/json" },
      });
      const corpo = (await resposta.json().catch(() => null)) as
        | { data?: { texto?: unknown } }
        | null;
      const revelado = corpo?.data?.texto;
      if (resposta.ok && typeof revelado === "string" && revelado.trim()) {
        setTexto(revelado);
        setEstado("revelado");
        return;
      }
      // 403 é a única resposta que significa "perfil não autorizado"; qualquer
      // outra (409, 500, rede) é indisponibilidade, não recusa.
      setEstado(resposta.status === 403 ? "negado" : "indisponivel");
    } catch {
      setEstado("indisponivel");
    }
  };

  if (estado === "revelado" && texto) {
    return (
      <p
        data-testid="texto-retido"
        className="whitespace-pre-wrap wrap-anywhere border-t border-current/20 pt-1 leading-snug"
      >
        {texto}
      </p>
    );
  }

  if (estado === "verificando") {
    return (
      <p role="status" className="text-[11px] italic leading-snug opacity-80">
        {t("Verificando permissão…")}
      </p>
    );
  }

  if (estado === "negado") {
    return (
      <p role="status" className="text-[11px] italic leading-snug opacity-80">
        {t("Você não tem permissão para ver este texto")}
      </p>
    );
  }

  if (estado === "indisponivel") {
    return (
      <p role="status" className="text-[11px] italic leading-snug opacity-80">
        {t("Texto não disponível")}
      </p>
    );
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="h-6 px-2 text-[11px]"
      onClick={() => void revelar()}
    >
      {t("Ver texto retido")}
    </Button>
  );
}
