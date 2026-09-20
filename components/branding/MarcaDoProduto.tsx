import { cn } from "@/lib/utils";

/** The supplied escreve.ai artwork is displayed unchanged, cropped by the SVG viewport. */

type Props = {
  readonly nome: string;
  readonly className?: string;
  /** `true` quando o texto ao lado já nomeia a marca — evita ler duas vezes. */
  readonly decorativo?: boolean;
};

const SIMBOLO_CLARO_ESCURO = "fill-[#506d48] dark:fill-[#82a077]";
const NOME_CLARO_ESCURO = "fill-[#1c1a16] dark:fill-[#f5f4ef]";
const SUFIXO_CLARO_ESCURO = "fill-[#5d594f] dark:fill-[#8e8b7f]";

// Legacy palette export retained for consumers of the original design system.
export const CLASSES_DE_COR = {
  simbolo: SIMBOLO_CLARO_ESCURO,
  nome: NOME_CLARO_ESCURO,
  sufixo: SUFIXO_CLARO_ESCURO,
} as const;

function acessibilidade(nome: string, decorativo: boolean) {
  return decorativo
    ? ({ "aria-hidden": true } as const)
    : ({ role: "img", "aria-label": nome } as const);
}

/** The square viewport selects the symbol from the original transparent artwork. */
export function SimboloDoProduto({ nome, className, decorativo = false }: Props) {
  return (
    <svg
      viewBox="140 155 410 410"
      className={cn("shrink-0", className)}
      {...acessibilidade(nome, decorativo)}
    >
      <image href="/brand/escreve-ai.png" width="2161" height="728" />
    </svg>
  );
}

export function LogotipoDoProduto({ nome, className, decorativo = false }: Props) {
  return (
    <svg
      viewBox="140 155 1870 410"
      className={cn("shrink-0 rounded-md dark:bg-white dark:p-1", className)}
      {...acessibilidade(nome, decorativo)}
    >
      <image href="/brand/escreve-ai.png" width="2161" height="728" />
    </svg>
  );
}
