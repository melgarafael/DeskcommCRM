/**
 * O catálogo de módulos instaláveis (ADR-0002, D3).
 *
 * Não há uma segunda lista para divergir da real: `fn_modulo_instalar` só aceita um slug cuja
 * `fn_<slug>_provisionar()` EXISTE no banco (`to_regprocedure`), e é essa checagem que decide
 * de verdade. Este array é só a vitrine — nome e descrição para a tela do administrador da
 * instalação escolher o que instalar. Um módulo aqui sem provisionadora no banco falharia com
 * `extension_module_unknown` ao tentar instalar, nunca silenciosamente.
 */
export interface ModuloCatalogo {
  slug: string;
  nome: string;
  descricao: string;
}

export const CATALOGO_DE_MODULOS: readonly ModuloCatalogo[] = [
  {
    slug: "honorarios",
    nome: "Honorários (advocacia)",
    descricao:
      "Contrato de honorários (fixo, êxito ou misto) e o calendário de parcelas, ligado ao caixa " +
      "do núcleo. Para escritórios de advocacia que cobram por caso.",
  },
];

export function moduloDoCatalogo(slug: string): ModuloCatalogo | undefined {
  return CATALOGO_DE_MODULOS.find((m) => m.slug === slug);
}
