import { z } from "zod";

const idDePlano = z.string().uuid();

/** O link sugere uma opção já oferecida; não concede preço nem autoridade. */
export function selecionarPlanoDoLink(
  pedido: string | string[] | undefined,
  oferecidos: readonly { id: string }[],
  inicialPadrao: string | undefined,
  temConvite: boolean,
): { planoInicial: string | undefined; linkInvalido: boolean; linkEscolheuPlano: boolean } {
  // Convite sempre conserva o caminho nativo, mesmo se a URL trouxer um plano.
  if (temConvite || pedido === undefined) {
    return { planoInicial: inicialPadrao, linkInvalido: false, linkEscolheuPlano: false };
  }
  const id = idDePlano.safeParse(pedido);
  const plano = id.success ? oferecidos.find((p) => p.id === id.data) : undefined;
  return {
    planoInicial: plano?.id ?? inicialPadrao,
    // Sem plano oferecido não há seletor: o aviso apontaria para uma tela que não existe.
    linkInvalido: !plano && oferecidos.length > 0,
    // Só o link que RESOLVEU tira o Google, que não carrega a escolha; um valor
    // qualquer na URL não muda a regra do doc 146.
    linkEscolheuPlano: Boolean(plano),
  };
}
