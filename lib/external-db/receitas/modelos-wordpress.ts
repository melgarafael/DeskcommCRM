/**
 * MODELOS DE RECEITA — a configuração de um nicho, PRONTA.
 *
 * **O que é um modelo.** Um MODELO é só uma configuração que pré-preenche a
 * tela: ele não é código de nicho, não muda a receita e não vale mais do que
 * o que a pessoa preencheu. Quem quiser imóveis, veículos, cursos ou cardápio
 * mapeia o que o site guarda — e o modelo "Imóveis" é o atalho para o cadastro
 * mais comum.
 *
 * **Por que isto mora FORA da receita.** A receita `wordpress-conteudo` é
 * genérica de propósito: ela sabe ler um tipo de post com campos e categorias,
 * e não sabe o que é um imóvel. Se o "quartos" e a "vaga de garagem" morassem
 * no núcleo, a receita voltaria a ser de um nicho só — e uma receita de um
 * nicho só tende a ser EXTENSÃO, não núcleo (`docs/doctrine/extensoes.md`).
 *
 * **Os `meta_key` e as taxonomias são SUGESTÃO.** O site de cada pessoa
 * nomeia as coisas do jeito dela (`preco`, `_preco_venda`, `valor_venda`…), e o
 * administrador ajusta na tela. O que o modelo acerta é a INTENÇÃO: quais
 * dados o nicho tem, de que tipo são e como se filtram.
 */
import type {
  CategoriaMapeada,
  CampoMapeado,
  EsconderMapeado,
  FiltroDeCampo,
  FiltroDeCategoria,
  TipoDeCampo,
} from "./wordpress-conteudo";
// O NÍVEL do termo mora no módulo da taxonomia (é a hierarquia do WordPress,
// não do modelo): é de lá que vem, e é de lá que a receita o importa também.
import type { NivelDaTaxonomia } from "./taxonomia";

/** Um campo do modelo: a chave, o rótulo e a meta_key sugerida. */
export interface CampoModelado {
  chave: string;
  rotulo: string;
  meta_key: string;
  tipo: TipoDeCampo;
  filtro: FiltroDeCampo;
}

/** Uma categoria do modelo: a chave, o rótulo e a taxonomia sugerida. */
export interface CategoriaModelada {
  chave: string;
  rotulo: string;
  taxonomia: string;
  nivel: NivelDaTaxonomia;
  filtro: FiltroDeCategoria;
}

/** Um modelo pronto para preencher a tela. */
export interface ModeloDeReceita {
  /** O id do modelo (o da tela, não o da receita). */
  id: string;
  /** O nome que a pessoa lê. */
  rotulo: string;
  /** A linha de apoio: o que o modelo traz. */
  descricao: string;
  /** O tipo de post sugerido. */
  post_type: string;
  /** Os campos do modelo. */
  campos: CampoModelado[];
  /** As categorias do modelo. */
  categorias: CategoriaModelada[];
  /** O que o modelo esconde. */
  esconder?: EsconderMapeado;
}

/**
 * O MODELO "IMÓVEIS" — o cadastro mais comum de site WordPress.
 *
 * Os dados vêm de uma IMMOBILIÁRIA medida (WordPress 6.x + ACF 6.8.10 +
 * JetEngine 3.5.8, MySQL 8.0.45, 21/10/2026): bairro e cidade são
 * CATEGORIAS da taxonomia hierárquica "Cidade › Bairro", tipo e finalidade
 * também são categorias, e preço, aluguel, quartos e situação são CAMPOS.
 */
export const MODELO_IMOVEIS: ModeloDeReceita = {
  id: "imoveis",
  rotulo: "Imóveis",
  descricao:
    "Código, preço, aluguel, condomínio, quartos, suítes, banheiros, vagas e área; bairro, cidade, tipo e finalidade.",
  post_type: "imovel",
  campos: [
    { chave: "codigo", rotulo: "Código", meta_key: "codigo", tipo: "texto", filtro: "nenhum" },
    { chave: "preco", rotulo: "Preço de venda", meta_key: "preco", tipo: "preco", filtro: "maximo" },
    { chave: "aluguel", rotulo: "Aluguel", meta_key: "aluguel", tipo: "preco", filtro: "maximo" },
    { chave: "condominio", rotulo: "Condomínio", meta_key: "condominio", tipo: "preco", filtro: "nenhum" },
    { chave: "quartos", rotulo: "Quartos", meta_key: "quartos", tipo: "numero", filtro: "minimo" },
    { chave: "suites", rotulo: "Suítes", meta_key: "suites", tipo: "numero", filtro: "minimo" },
    { chave: "banheiros", rotulo: "Banheiros", meta_key: "banheiros", tipo: "numero", filtro: "nenhum" },
    { chave: "vagas", rotulo: "Vagas", meta_key: "vagas", tipo: "numero", filtro: "minimo" },
    { chave: "area", rotulo: "Área", meta_key: "area", tipo: "numero", filtro: "minimo" },
  ],
  categorias: [
    { chave: "bairro", rotulo: "Bairro", taxonomia: "localizacao", nivel: "filho", filtro: "contem" },
    { chave: "cidade", rotulo: "Cidade", taxonomia: "localizacao", nivel: "raiz", filtro: "contem" },
    { chave: "tipo", rotulo: "Tipo", taxonomia: "tipo_imovel", nivel: "qualquer", filtro: "contem" },
    { chave: "finalidade", rotulo: "Finalidade", taxonomia: "finalidade", nivel: "qualquer", filtro: "igual" },
  ],
  esconder: { meta_key: "status_imovel", valores: ["vendido", "alugado"] },
};

/**
 * O MODELO "EM BRANCO" — a tela sem nada mapeado.
 *
 * A pessoa escreve o tipo de post e mapeia o que o site guarda. O post_type
 * vem vazio de propósito: o nome do tipo de post é do site (e o site o chama
 * do jeito que ele chama), e chutar "imovel" aqui seria levar o nicho para
 * dentro de uma receita que existe para não ser de um nicho.
 */
export const MODELO_EM_BRANCO: ModeloDeReceita = {
  id: "em-branco",
  rotulo: "Em branco",
  descricao: "Comece do zero: escreva o tipo de post e mapeie os dados que o site guarda.",
  post_type: "",
  campos: [],
  categorias: [],
};

/** Todos os modelos, na ordem em que a tela os oferece. */
export const MODELOS_WORDPRESS: readonly ModeloDeReceita[] = [MODELO_IMOVEIS, MODELO_EM_BRANCO];

/** O modelo pelo id, ou undefined. */
export function modeloDe(id: string): ModeloDeReceita | undefined {
  return MODELOS_WORDPRESS.find((m) => m.id === id);
}

/** Converte o modelo nos campos que a tela edita (o mesmo formato do contrato). */
export function camposDoModelo(modelo: ModeloDeReceita): CampoMapeado[] {
  return modelo.campos.map((c) => ({
    chave: c.chave,
    rotulo: c.rotulo,
    meta_key: c.meta_key,
    tipo: c.tipo,
    filtro: c.filtro,
  }));
}

/** Converte o modelo nas categorias que a tela edita. */
export function categoriasDoModelo(modelo: ModeloDeReceita): CategoriaMapeada[] {
  return modelo.categorias.map((c) => ({
    chave: c.chave,
    rotulo: c.rotulo,
    taxonomia: c.taxonomia,
    nivel: c.nivel,
    filtro: c.filtro,
  }));
}
