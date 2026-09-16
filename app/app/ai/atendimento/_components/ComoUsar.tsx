import { Info } from "@/lib/ui/icons";

/**
 * Guia rápido, em linguagem de quem NÃO programa. Fica na própria tela de
 * Fluxos de atendimento: a função é nova e a explicação precisa estar onde ela
 * é usada, não num manual à parte.
 */
export function ComoUsar() {
  return (
    <details className="group rounded-md border border-border bg-surface p-4" data-testid="como-usar">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium">
        <Info size={16} aria-hidden className="text-accent" />
        Como usar os fluxos de atendimento (guia rápido)
      </summary>
      <div className="mt-3 space-y-4 text-sm text-text-muted">
        <p>
          É um <strong>roteiro de perguntas</strong> que a IA segue durante a conversa. Ela pergunta,
          entende a resposta, guarda no cadastro do cliente e <strong>para de perguntar</strong> quando
          você não precisa mais daquele dado.
        </p>

        <div>
          <p className="font-medium text-text">Montando o fluxo</p>
          <ol className="mt-1 list-decimal space-y-1 pl-5">
            <li>Clique em <strong>Novo fluxo de atendimento</strong> e dê um nome.</li>
            <li>
              Adicione uma <strong>Pergunta</strong>: escreva o que a IA deve perguntar, uma{" "}
              <strong>chave</strong> curta para o dado (ex.: <code>cidade</code>), o tipo e se é
              obrigatória.
            </li>
            <li>
              Se quiser, adicione uma <strong>Skill</strong> — um procedimento da loja que a IA usa
              naquele momento.
            </li>
            <li>
              Ligue as caixas em ordem (do <strong>Início</strong> até o <strong>Fim</strong>). No
              Fim, em <strong>Ao concluir</strong>, escolha o que acontece: nada, devolver à IA ou
              chamar uma skill.
            </li>
            <li>Clique em <strong>Publicar</strong>.</li>
          </ol>
        </div>

        <div>
          <p className="font-medium text-text">Como a IA se comporta</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            <li>Só age quando o fluxo é <strong>disparado</strong> — ligue o fluxo a uma intenção em IA → Roteadores.</li>
            <li>Pergunta <strong>uma coisa por vez</strong> e guarda a resposta (no sentido, não só nas palavras dele).</li>
            <li>Se o cliente já disser um dado antes de ser perguntado, ela <strong>registra sem perguntar</strong>.</li>
            <li>Se o cliente mudar de ideia, a resposta é <strong>atualizada</strong> (quando “Permitir correção” está ligado).</li>
            <li>
              Pergunta sem resposta é repetida até o <strong>Máximo de tentativas</strong>; depois ela
              é encerrada e não trava o fluxo.
            </li>
          </ul>
        </div>

        <p>
          Cada resposta fica guardada por cliente e por fluxo. O que já foi respondido não é
          perguntado de novo.
        </p>
      </div>
    </details>
  );
}
