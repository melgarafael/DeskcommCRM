import { Info } from "@/lib/ui/icons";

type Traduzir = (texto: string) => string;

/**
 * Guia rápido, em linguagem de quem NÃO programa. Fica na própria tela dos
 * roteiros: a função é nova e a explicação precisa estar onde ela é usada.
 *
 * Reescrito no port (PR 3): o guia do autor dizia que o roteiro SÓ começava
 * pelo roteador e que o Fim oferecia "nada, devolver à IA ou skill" — não
 * falava das palavras-gatilho nem de encadear (prova prática do #1130, J1). E
 * frases inteiras, não pedaços: tradução de fragmento sai sem concordância.
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
          {t(
            "É um roteiro de perguntas que a IA segue durante a conversa: ela pergunta uma coisa por vez, entende a resposta e guarda o dado no cadastro do cliente.",
          )}
        </p>

        <div>
          <p className="font-medium text-text">{t("Montando o roteiro")}</p>
          <ol className="mt-1 list-decimal space-y-1 pl-5">
            <li>{t("Crie o roteiro e dê um nome.")}</li>
            <li>
              {t(
                "No Início, escreva as palavras-gatilho: quando a mensagem do cliente tiver uma delas, o roteiro começa sozinho. Ele também pode começar por uma intenção em IA › Roteadores.",
              )}
            </li>
            <li>
              {t(
                "Adicione uma Pergunta para cada dado, com uma chave curta (ex.: cidade), o tipo e se é obrigatória. O tipo CPF confere o dígito verificador.",
              )}
            </li>
            <li>{t("Se quiser, adicione uma Skill — um procedimento da loja que a IA usa naquele passo.")}</li>
            <li>
              {t(
                "Ligue as caixas em linha, do Início ao Fim. No Fim, escolha o que acontece ao concluir: nada, orientar a IA, chamar uma skill ou começar outro roteiro.",
              )}
            </li>
            <li>{t("Publique.")}</li>
          </ol>
        </div>

        <div>
          <p className="font-medium text-text">{t("Como a IA se comporta")}</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            <li>{t("Só grava uma resposta que esteja escrita na mensagem do cliente.")}</li>
            <li>{t("Se o cliente já disser um dado antes de ser perguntado, ela registra sem perguntar.")}</li>
            <li>{t("Se o cliente corrigir um dado, a resposta é atualizada (quando a pergunta permite correção).")}</li>
            <li>
              {t(
                "Pergunta sem resposta é repetida até o máximo de tentativas; depois é encerrada e não trava o roteiro.",
              )}
            </li>
            <li>
              {t(
                "O roteiro para quando uma pessoa assume a conversa, quando o cliente pede para parar, e depois do prazo sem resposta (72 horas, se você não mudar).",
              )}
            </li>
          </ul>
        </div>

        <p>
          {t(
            "As respostas ficam nos campos do cliente e aparecem na ficha dele e na conversa. O que o cliente já respondeu não é perguntado de novo, em nenhum roteiro.",
          )}
        </p>
      </div>
    </details>
  );
}
