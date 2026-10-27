import { z } from "zod";

const idDePlano = z.string().uuid();

/** O link sugere uma opção já oferecida; não concede preço nem autoridade. */
export function selecionarPlanoDoLink(
  pedido: string | string[] | undefined,
  oferecidos: readonly { id: string }[],
  inicialPadrao: string | undefined,
  temConvite: boolean,
): { planoInicial: string | undefined; linkInvalido: boolean; linkSolicitado: boolean } {
  // Convite sempre conserva o caminho nativo, mesmo se a URL trouxer um plano.
  if (temConvite || pedido === undefined) {
    return { planoInicial: inicialPadrao, linkInvalido: false, linkSolicitado: false };
  }
  const id = idDePlano.safeParse(pedido);
  const plano = id.success ? oferecidos.find((p) => p.id === id.data) : undefined;
  return {
    planoInicial: plano?.id ?? inicialPadrao,
    linkInvalido: !plano,
    linkSolicitado: true,
  };
}
