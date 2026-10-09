import * as React from "react";

import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          // `min-h-11 lg:min-h-0` — 44px de altura onde o dedo aciona.
          //
          // `h-10` são 40px, quatro abaixo do piso. Medido em 360px: 74 campos
          // em Configurações da organização, 4 na Auditoria, a busca de
          // Contatos e a de Agentes — todos curtos, e campo é o controle em que
          // errar o toque custa mais (põe o cursor na palavra errada).
          //
          // `min-h` em vez de trocar o `h-10`: o campo que o chamador
          // dimensionou à mão continua com a medida dele.
          "flex h-10 min-h-11 w-full rounded-sm border border-border bg-bg px-4 py-2 lg:min-h-0",
          // `text-base md:text-sm` — e isto é conserto de COMPORTAMENTO, não de
          // tipografia.
          //
          // O Safari do iPhone dá ZOOM na página inteira quando um campo recebe
          // foco com fonte computada MENOR que 16px. `text-sm` são 14px, então
          // TODO campo de texto do produto — busca, formulário, login, convite —
          // saltava a escala da tela ao ser tocado, e sair do campo não desfazia
          // o salto: a pessoa seguia navegando um app ampliado, com a barra
          // lateral e o cabeçalho fora da vista.
          //
          // O conserto é a fonte. O outro caminho seria `maximum-scale=1` no
          // viewport de `app/layout.tsx`, e ele é pior: impede QUALQUER zoom,
          // inclusive o de quem precisa ampliar para ler. Barreira de
          // acessibilidade para resolver um incômodo de layout.
          //
          // De `md` para cima volta aos 14px: ali não há zoom de foco, e a
          // densidade do formulário no laptop foi desenhada nesse tamanho.
          "text-base text-text placeholder:text-text-muted md:text-sm",
          "transition-[border-color,box-shadow] duration-fast ease-out",
          "hover:border-border-strong",
          "focus-visible:border-accent-500 focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:outline-hidden",
          "file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-text",
          "disabled:cursor-not-allowed disabled:opacity-55",
          "aria-[invalid=true]:border-error aria-[invalid=true]:focus-visible:ring-error-bg",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
