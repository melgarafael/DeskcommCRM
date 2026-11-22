/**
 * As famílias que a tela Aparência oferece — SÓ as que já estão versionadas em
 * `app/fonts/` (licença OFL, origem no README de lá). Nenhum arquivo novo, nenhuma
 * fonte baixada no build: a imagem é pré-buildada e não pode depender da rede.
 *
 * Cada pilha aponta para a custom property que `next/font/local` declara em
 * `app/fontes-da-aparencia.ts` (e, para a Atkinson e a Plex Mono, em
 * `app/layout.tsx`). As fontes são declaradas com `preload: false`: o navegador
 * só baixa o arquivo da família que alguma regra de fato usa.
 */

export const CHAVES_DE_FONTE = [
  "atkinson",
  "manrope",
  "jakarta",
  "plex",
  "bricolage",
  "source-serif",
  "fraunces",
  "jetbrains-mono",
] as const;

export type ChaveDeFonte = (typeof CHAVES_DE_FONTE)[number];

const SEM_SERIFA = "ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif";
const COM_SERIFA = "ui-serif, Georgia, \"Times New Roman\", serif";

export const FONTES: Readonly<Record<ChaveDeFonte, { readonly nome: string; readonly pilha: string }>> = {
  atkinson: { nome: "Atkinson Hyperlegible", pilha: `var(--font-atkinson), ${SEM_SERIFA}` },
  manrope: { nome: "Manrope", pilha: `var(--fonte-manrope), ${SEM_SERIFA}` },
  jakarta: { nome: "Plus Jakarta Sans", pilha: `var(--fonte-jakarta), ${SEM_SERIFA}` },
  plex: { nome: "IBM Plex Sans", pilha: `var(--fonte-plex), ${SEM_SERIFA}` },
  bricolage: { nome: "Bricolage Grotesque", pilha: `var(--fonte-bricolage), ${SEM_SERIFA}` },
  "source-serif": { nome: "Source Serif 4", pilha: `var(--fonte-source-serif), ${COM_SERIFA}` },
  fraunces: { nome: "Fraunces", pilha: `var(--fonte-fraunces), ${COM_SERIFA}` },
  "jetbrains-mono": {
    nome: "JetBrains Mono",
    pilha: "var(--fonte-jetbrains-mono), ui-monospace, SFMono-Regular, Menlo, monospace",
  },
};

export function ehChaveDeFonte(valor: unknown): valor is ChaveDeFonte {
  return typeof valor === "string" && (CHAVES_DE_FONTE as readonly string[]).includes(valor);
}
