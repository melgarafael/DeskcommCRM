/**
 * Frases que dependem de uma contagem de organizações. Cada variante é um `t()` LITERAL: passado
 * por variável, o texto escapa do gate que exige a tradução para espanhol.
 */
type Traduzir = (texto: string) => string;
const comN = (texto: string, n: number) => texto.replace("{n}", String(n));

export function organizacoesAtivas(t: Traduzir, n: number): string {
  if (n === 0) return t("Nenhuma organização está com esta extensão ativa.");
  if (n === 1) return t("1 organização está com esta extensão ativa.");
  return comN(t("{n} organizações estão com esta extensão ativa."), n);
}

/** Linha curta da Atividade recente para atualizar e desfazer. */
export function organizacoesComElaAtiva(t: Traduzir, n: number): string {
  if (n === 0) return t("nenhuma organização com ela ativa");
  if (n === 1) return t("1 organização com ela ativa");
  return comN(t("{n} organizações com ela ativa"), n);
}

/** Linha curta da Atividade recente para a remoção. */
export function organizacoesDesativadas(t: Traduzir, n: number): string {
  if (n === 0) return t("nenhuma organização desativada");
  if (n === 1) return t("1 organização desativada");
  return comN(t("{n} organizações desativadas"), n);
}

/** Confirmação de atualizar ou trocar: quem está ativo continua ativo. */
export function continuamAtivas(t: Traduzir, n: number): string {
  if (n === 0) return t("Nenhuma organização está com ela ativa agora.");
  if (n === 1) {
    return t(
      "1 organização tem esta extensão ativa e continua com ela ativa, com a configuração de hoje.",
    );
  }
  return comN(
    t(
      "{n} organizações têm esta extensão ativa e continuam com ela ativa, com a configuração de hoje.",
    ),
    n,
  );
}

/** Confirmação de remover: o que some agora. */
export function deixamDeVer(t: Traduzir, n: number): string {
  if (n === 0) {
    return t(
      "Nenhuma organização está com ela ativa agora; a configuração de cada uma fica guardada.",
    );
  }
  if (n === 1) {
    return t(
      "1 organização com ela ativa deixa de ver os guias agora; a configuração dela fica guardada.",
    );
  }
  return comN(
    t(
      "{n} organizações com ela ativa deixam de ver os guias agora; a configuração de cada uma fica guardada.",
    ),
    n,
  );
}

/** Confirmação de reinstalar: ninguém volta a ver sozinho. */
export function usavamAntesDaRemocao(t: Traduzir, n: number): string {
  if (n === 0) return t("Nenhuma organização a usava quando foi removida.");
  if (n === 1) {
    return t(
      "1 organização a usava e não volta a vê-la sozinha: o administrador dela precisa ativar de novo.",
    );
  }
  return comN(
    t(
      "{n} organizações a usavam, e nenhuma volta a vê-la sozinha: o administrador de cada uma precisa ativar de novo.",
    ),
    n,
  );
}
