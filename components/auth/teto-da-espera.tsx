"use client";

import { useCallback, useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";

/**
 * O TETO DE ESPERA das telas de autenticação.
 *
 * Os nove formulários de `components/auth/` chamam Server Actions que falam
 * com o serviço de autenticação e gravam auditoria antes de responder, e
 * nenhuma dessas chamadas tem timeout próprio. Sem teto, uma resposta que não
 * chega deixa o botão em "Entrando…"/"Verificando…" para sempre, com o campo
 * bloqueado: a única saída era recarregar a página, sem que a tela dissesse
 * isso. A causa da demora não está identificada; o teto é uma defesa, não o
 * conserto dela.
 *
 * 20s é folgado para duas idas ao serviço de autenticação numa VPS modesta e
 * curto o bastante para não parecer travamento.
 */
export const TETO_DA_ESPERA_MS = 20_000;

/**
 * `redirect()` numa Server Action sinaliza por EXCEÇÃO, com `digest` começando
 * em "NEXT_REDIRECT" — é assim que o sucesso navega para `/app`. Um `catch` que
 * a tratasse como falha deixaria quem acertou o código preso na tela, lendo
 * "não consegui verificar".
 */
export function ehRedirecionamentoDoServidor(erro: unknown): boolean {
  const digest = (erro as { digest?: unknown } | null)?.digest;
  return typeof digest === "string" && digest.startsWith("NEXT_REDIRECT");
}

/** A promessa com teto. O temporizador é limpo quando a ação responde antes. */
export function comTetoDeEspera<T>(promessa: Promise<T>): Promise<T> {
  let temporizador: ReturnType<typeof setTimeout> | undefined;
  const teto = new Promise<never>((_, rejeita) => {
    temporizador = setTimeout(() => rejeita(new Error("tempo_esgotado")), TETO_DA_ESPERA_MS);
  });
  return Promise.race([promessa, teto]).finally(() => clearTimeout(temporizador));
}

/**
 * O envio com teto — a forma que todo formulário de autenticação usa.
 *
 * ⚠️ A pendência é `useState`, e a ação é chamada FORA de `startTransition`.
 * O Next chama toda Server Action dentro de uma transição do próprio roteador,
 * e o estado do roteador fica suspenso enquanto a resposta não chega. Um
 * `isPending` de `useTransition` do formulário fica preso junto com essa
 * transição: mesmo com o teto rejeitando, o botão não voltava. A pendência
 * própria não depende da transição de ninguém (cerca em `LoginForm.test.tsx`,
 * com um roteador imitado).
 *
 * No redirecionamento do servidor a pendência continua ligada: o roteador do
 * Next 16 rejeita a chamada com o sinal E navega sozinho
 * (`server-action-reducer`), então não há o que relançar, e devolver o botão
 * no meio da navegação só abriria espaço para um segundo envio.
 */
export function useEnvioComTeto() {
  const [pendente, setPendente] = useState(false);
  const [semResposta, setSemResposta] = useState(false);

  const enviar = useCallback(
    async <T,>(
      acao: () => Promise<T>,
      aoResponder: (res: T) => void,
      aoFicarSemResposta?: () => void,
    ) => {
      setPendente(true);
      setSemResposta(false);
      let res: T;
      try {
        res = await comTetoDeEspera(acao());
      } catch (erro) {
        if (ehRedirecionamentoDoServidor(erro)) return;
        setPendente(false);
        setSemResposta(true);
        aoFicarSemResposta?.();
        return;
      }
      setPendente(false);
      aoResponder(res);
    },
    [],
  );

  return { pendente, semResposta, enviar };
}

/**
 * O que a tela diz quando a resposta não chegou no teto.
 *
 * Deliberadamente diferente de "código inválido" ou "senha incorreta":
 * estourar o tempo não prova que o que foi digitado estava errado, e a ação
 * pode ter acontecido do outro lado. O caminho oferecido é recarregar, e não
 * um segundo envio: o roteador do Next atende uma Server Action por vez, e um
 * segundo envio entraria na fila atrás do primeiro, que não respondeu.
 */
export function AvisoSemResposta() {
  const t = useT();
  return (
    <div
      role="alert"
      className="space-y-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      <p>{t("Não recebemos a resposta do servidor. Recarregue a página para tentar de novo.")}</p>
      <Button type="button" variant="link" onClick={() => window.location.reload()}>
        {t("Recarregar a página")}
      </Button>
    </div>
  );
}
