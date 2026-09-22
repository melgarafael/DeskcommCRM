/**
 * A BIBLIOTECA DE CATEGORIAS COMERCIAIS (§5 do plano).
 *
 * Macro → subcategorias, em PT-BR (o termo vai à busca). O termo de busca de
 * cada subcategoria pode diferir do rótulo exibido (`busca`), porque o
 * provider entende "oficina mecânica" melhor que o rótulo interno.
 */

export interface Subcategoria {
  rotulo: string;
  busca: string;
}

export interface MacroCategoria {
  macro: string;
  subcategorias: Subcategoria[];
}

const sub = (rotulo: string, busca?: string): Subcategoria => ({ rotulo, busca: busca ?? rotulo });

export const CATEGORIAS_COMERCIAIS: MacroCategoria[] = [
  {
    macro: "Alimentação",
    subcategorias: [
      sub("Restaurante"), sub("Lanchonete"), sub("Pizzaria"), sub("Padaria", "padaria"),
      sub("Supermercado"), sub("Mercado"), sub("Açougue"), sub("Hortifruti"),
      sub("Cafeteria"), sub("Sorveteria"), sub("Bar"), sub("Marmitaria", "marmitaria"),
    ],
  },
  {
    macro: "Automotivo",
    subcategorias: [
      sub("Oficina mecânica"), sub("Auto elétrica", "auto elétrica"), sub("Autopeças", "autopeças"),
      sub("Borracharia"), sub("Centro automotivo"), sub("Funilaria"), sub("Lavação", "lavação de veículos"),
      sub("Revenda de veículos"), sub("Retífica", "retífica de motores"),
    ],
  },
  {
    macro: "Construção",
    subcategorias: [
      sub("Material de construção"), sub("Madeireira"), sub("Vidraçaria"),
      sub("Elétrica e hidráulica", "material elétrico e hidráulico"), sub("Tintas"),
      sub("Esquadrias", "esquadrias de alumínio"), sub("Construtora"), sub("Engenharia"),
    ],
  },
  {
    macro: "Saúde",
    subcategorias: [
      sub("Clínica odontológica"), sub("Farmácia"), sub("Clínica médica"),
      sub("Fisioterapia"), sub("Laboratório"), sub("Ótica"), sub("Veterinária", "clínica veterinária"),
    ],
  },
  {
    macro: "Agronegócio",
    subcategorias: [
      sub("Agropecuária"), sub("Loja agrícola"), sub("Cooperativa agrícola"),
      sub("Sementes e insumos", "insumos agrícolas"), sub("Máquinas agrícolas"),
    ],
  },
  { macro: "Comércio", subcategorias: [sub("Loja de roupas"), sub("Calçados"), sub("Papelaria"), sub("Presentes"), sub("Ótica")] },
  {
    macro: "Indústria",
    subcategorias: [
      sub("Metalúrgica", "metalúrgica"), sub("Marcenaria"), sub("Serralheria"),
      sub("Gráfica"), sub("Alimentos (indústria)", "indústria de alimentos"),
    ],
  },
  {
    macro: "Serviços",
    subcategorias: [
      sub("Contabilidade"), sub("Advocacia"), sub("Imobiliária"),
      sub("Seguros", "corretora de seguros"), sub("Informática", "assistência técnica informática"),
    ],
  },
  { macro: "Hotelaria", subcategorias: [sub("Hotel"), sub("Pousada"), sub("Motel")] },
  {
    macro: "Educação",
    subcategorias: [sub("Escola"), sub("Autoescola"), sub("Curso de idiomas"), sub("Academia", "academia de ginástica")],
  },
  {
    macro: "Transportes",
    subcategorias: [sub("Transportadora"), sub("Mudanças", "empresa de mudanças"), sub("Táxi"), sub("Oficina de caminhões")],
  },
  {
    macro: "Pet",
    subcategorias: [sub("Pet shop"), sub("Clínica veterinária"), sub("Banho e tosa", "banho e tosa pet")],
  },
  {
    macro: "Beleza",
    subcategorias: [sub("Salão de beleza"), sub("Barbearia"), sub("Estética", "clínica de estética")],
  },
  {
    macro: "Tecnologia",
    subcategorias: [sub("Assistência técnica"), sub("Loja de informática"), sub("Provedor de internet"), sub("Software", "empresa de software")],
  },
];

/** Todos os termos de busca, para o seletor múltiplo da tela. */
export function termosDeBusca(): { macro: string; rotulo: string; busca: string }[] {
  return CATEGORIAS_COMERCIAIS.flatMap((m) =>
    m.subcategorias.map((s) => ({ macro: m.macro, rotulo: s.rotulo, busca: s.busca })),
  );
}
