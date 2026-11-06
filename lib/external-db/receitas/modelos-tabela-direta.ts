/**
 * MODELOS DE RECEITA — a configuração de um nicho, PRONTA.
 *
 * **O que é um modelo.** Um MODELO é só uma configuração que pré-preenche a
 * tela: ele não é código de nicho, não muda a receita e não vale mais do que
 * o que a pessoa preencheu. Quem quiser imóveis, veículos, cursos ou cardápio
 * mapeia o que o site guarda — e o modelo "JetEngine CCT" é o atalho para o
 * cadastro mais comum de tipos de conteúdo próprio do JetEngine.
 *
 * **Por que isto mora FORA da receita.** A receita `tabela-direta` é genérica
 * de propósito: ela sabe ler uma tabela plana com coluna de id, título e campos
 * mapeados, e não sabe o que é um CCT. Se as colunas do JetEngine morassem no
 * núcleo, a receita voltaria a ser de um nicho só — e uma receita de um nicho
 * só tende a ser EXTENSÃO, não núcleo (`docs/doctrine/extensoes.md`).
 *
 * **As colunas são SUGESTÃO.** O site de cada pessoa nomeia as coisas do jeito
 * dela, e o administrador ajusta na tela. O que o modelo acerta é a INTENÇÃO:
 * quais dados o nicho tem, de que tipo são e como se filtram.
 */
import type {
  CampoMapeadoTabelaDireta,
  EsconderQuandoTabelaDireta,
  FiltroDeCampoTabelaDireta,
  SoMostrarQuandoTabelaDireta,
  TipoDeCampoTabelaDireta,
} from "./tabela-direta";

/** Um campo do modelo: a chave, o rótulo e a coluna sugerida. */
export interface CampoModeladoTabelaDireta {
  chave: string;
  rotulo: string;
  coluna: string;
  tipo: TipoDeCampoTabelaDireta;
  filtro: FiltroDeCampoTabelaDireta;
}

/** Um modelo pronto para preencher a tela. */
export interface ModeloDeReceitaTabelaDireta {
  /** O id do modelo (o da tela, não o da receita). */
  id: string;
  /** O nome que a pessoa lê. */
  rotulo: string;
  /** A linha de apoio: o que o modelo traz. */
  descricao: string;
  /** A tabela sugerida. */
  tabela: string;
  /** A coluna do id sugerida. */
  coluna_id: string;
  /** A coluna do título sugerida. */
  coluna_titulo: string;
  /** Os campos do modelo. */
  campos: CampoModeladoTabelaDireta[];
  /** Só mostrar quando a coluna é igual a este valor. */
  so_mostrar_quando?: SoMostrarQuandoTabelaDireta;
  /** Esconder quando a coluna está entre estes valores. */
  esconder_quando?: EsconderQuandoTabelaDireta;
}

/**
 * O MODELO "JETENGINE CCT" — tipo de conteúdo próprio do JetEngine.
 *
 * Os dados vêm de uma imobiliária medida (WordPress 6.x + JetEngine 3.5.8,
 * MySQL 8.0.45, 21/10/2026): o CCT grava numa tabela plana
 * `wp_jet_cct_imovel`, com `_ID` como id, `titulo` como título, `cct_status`
 * para controlar o que está publicado, e colunas para cada dado do imóvel.
 */
export const MODELO_JETENGINE_CCT: ModeloDeReceitaTabelaDireta = {
  id: "jetengine-cct",
  rotulo: "JetEngine — tipo de conteúdo próprio (CCT)",
  descricao:
    "Tabela plana wp_jet_cct_<slug>: id (_ID), título (titulo), só publicados (cct_status = publish) e campos de imóveis.",
  tabela: "wp_jet_cct_imovel",
  coluna_id: "_ID",
  coluna_titulo: "titulo",
  campos: [
    { chave: "codigo", rotulo: "Código", coluna: "codigo", tipo: "texto", filtro: "nenhum" },
    { chave: "preco", rotulo: "Preço de venda", coluna: "preco", tipo: "preco", filtro: "maximo" },
    { chave: "aluguel", rotulo: "Aluguel", coluna: "aluguel", tipo: "preco", filtro: "maximo" },
    { chave: "condominio", rotulo: "Condomínio", coluna: "condominio", tipo: "preco", filtro: "nenhum" },
    { chave: "quartos", rotulo: "Quartos", coluna: "quartos", tipo: "numero", filtro: "minimo" },
    { chave: "suites", rotulo: "Suítes", coluna: "suites", tipo: "numero", filtro: "minimo" },
    { chave: "banheiros", rotulo: "Banheiros", coluna: "banheiros", tipo: "numero", filtro: "nenhum" },
    { chave: "vagas", rotulo: "Vagas", coluna: "vagas", tipo: "numero", filtro: "minimo" },
    { chave: "area", rotulo: "Área", coluna: "area", tipo: "numero", filtro: "minimo" },
    { chave: "bairro", rotulo: "Bairro", coluna: "bairro", tipo: "texto", filtro: "contem" },
    { chave: "cidade", rotulo: "Cidade", coluna: "cidade", tipo: "texto", filtro: "contem" },
  ],
  so_mostrar_quando: { coluna: "cct_status", valor: "publish" },
  esconder_quando: { coluna: "situacao", valores: ["vendido", "alugado"] },
};

/**
 * O MODELO "EM BRANCO" — a tela sem nada mapeado.
 *
 * A pessoa escreve a tabela, a coluna do id, a coluna do título e mapeia os
 * dados que o site guarda. Tudo vem vazio de propósito: chutar a tabela ou as
 * colunas aqui seria levar o nicho para dentro de uma receita que existe para
 * não ser de um nicho.
 */
export const MODELO_EM_BRANCO: ModeloDeReceitaTabelaDireta = {
  id: "em-branco",
  rotulo: "Em branco",
  descricao: "Comece do zero: escreva a tabela, as colunas e mapeie os dados que o site guarda.",
  tabela: "",
  coluna_id: "",
  coluna_titulo: "",
  campos: [],
};

/** Todos os modelos, na ordem em que a tela os oferece. */
export const MODELOS_TABELA_DIRETA: readonly ModeloDeReceitaTabelaDireta[] = [
  MODELO_JETENGINE_CCT,
  MODELO_EM_BRANCO,
];

/** O modelo da tabela direta pelo id, ou undefined. */
export function modeloTabelaDiretaDe(id: string): ModeloDeReceitaTabelaDireta | undefined {
  return MODELOS_TABELA_DIRETA.find((m) => m.id === id);
}

/** Converte o modelo nos campos que a tela edita (o mesmo formato do contrato). */
export function camposDoModelo(modelo: ModeloDeReceitaTabelaDireta): CampoMapeadoTabelaDireta[] {
  return modelo.campos.map((c) => ({
    chave: c.chave,
    rotulo: c.rotulo,
    coluna: c.coluna,
    tipo: c.tipo,
    filtro: c.filtro,
  }));
}
