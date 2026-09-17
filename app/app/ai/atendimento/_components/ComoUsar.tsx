import { Info } from "@/lib/ui/icons";

type Traduzir = (texto: string) => string;

/**
 * Guia rápido, em linguagem de quem NÃO programa. Fica na própria tela de
 * Fluxos de atendimento: a função é nova e a explicação precisa estar onde ela
 * é usada, não num manual à parte.
 *
 * O texto entra por `t` (a mesma tradução da página) para que a explicação
 * acompanhe o idioma escolhido — cobrado por
 * `tests/unit/i18n-espanhol-cobre-a-tela.test.ts`.
 */
export function ComoUsar({ t }: { t: Traduzir }) {
  return (
    <details className="group rounded-md border border-border bg-surface p-4" data-testid="como-usar">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium">
        <Info size={16} aria-hidden className="text-accent" />
        {t("Como usar os fluxos de atendimento (guia rápido)")}
      </summary>
      <div className="mt-3 space-y-4 text-sm text-text-muted">
        <p>
          {t("É um")} <strong>{t("roteiro de perguntas")}</strong>{" "}
          {t(
            "que a IA segue durante a conversa. Ela pergunta, entende a resposta, guarda no cadastro do cliente e",
          )}{" "}
          <strong>{t("para de perguntar")}</strong>{" "}
          {t("quando você não precisa mais daquele dado.")}
        </p>

        <div>
          <p className="font-medium text-text">{t("Montando o fluxo")}</p>
          <ol className="mt-1 list-decimal space-y-1 pl-5">
            <li>
              {t("Clique em")} <strong>{t("Novo fluxo de atendimento")}</strong>{" "}
              {t("e dê um nome.")}
            </li>
            <li>
              {t("Adicione uma")} <strong>{t("Pergunta")}</strong>
              {t(": escreva o que a IA deve perguntar, uma")}{" "}
              <strong>{t("chave")}</strong>{" "}
              {t("curta para o dado (ex.:")} <code>cidade</code>
              {t("), o tipo e se é obrigatória.")}
            </li>
            <li>
              {t("Se quiser, adicione uma")} <strong>{t("Skill")}</strong>{" "}
              {t("— um procedimento da loja que a IA usa naquele momento.")}
            </li>
            <li>
              {t("Ligue as caixas em ordem (do")} <strong>{t("Início")}</strong>{" "}
              {t("até o")} <strong>{t("Fim")}</strong>
              {t("). No Fim, em")} <strong>{t("Ao concluir")}</strong>
              {t(", escolha o que acontece: nada, devolver à IA ou chamar uma skill.")}
            </li>
            <li>
              {t("Clique em")} <strong>{t("Publicar")}</strong>.
            </li>
          </ol>
        </div>

        <div>
          <p className="font-medium text-text">{t("Como a IA se comporta")}</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            <li>
              {t("Só age quando o fluxo é")} <strong>{t("disparado")}</strong>{" "}
              {t("— ligue o fluxo a uma intenção em IA → Roteadores.")}
            </li>
            <li>
              {t("Pergunta")} <strong>{t("uma coisa por vez")}</strong>{" "}
              {t("e guarda a resposta (no sentido, não só nas palavras dele).")}
            </li>
            <li>
              {t("Se o cliente já disser um dado antes de ser perguntado, ela")}{" "}
              <strong>{t("registra sem perguntar")}</strong>.
            </li>
            <li>
              {t("Se o cliente mudar de ideia, a resposta é")}{" "}
              <strong>{t("atualizada")}</strong>{" "}
              {t("(quando “Permitir correção” está ligado).")}
            </li>
            <li>
              {t("Pergunta sem resposta é repetida até o")}{" "}
              <strong>{t("Máximo de tentativas")}</strong>
              {t("; depois ela é encerrada e não trava o fluxo.")}
            </li>
          </ul>
        </div>

        <p>
          {t(
            "Cada resposta fica guardada por cliente e por fluxo. O que já foi respondido não é perguntado de novo.",
          )}
        </p>
      </div>
    </details>
  );
}
