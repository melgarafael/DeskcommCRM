/**
 * Teste unitário da receita `wordpress-conteudo` SEM MySQL de verdade.
 *
 * A receita é GENÉRICA (decisão do dono do produto, 21/10/2026): ela lê o
 * conteúdo de QUALQUER tipo de post de um site WordPress. O nicho entra pela
 * CONFIGURAÇÃO que o administrador preenche na tela — por isso o teste monta
 * o SQL de DOIS nichos (imóveis e veículos) e prova que o SQL não sabe a
 * diferença.
 *
 * O que o teste prova:
 *  - filtra `post_type = ?` e `post_status = 'publish'` (rascunho nunca entra);
 *  - NÃO tem junção obrigatória (todo campo é LEFT JOIN): o conteúdo sem o
 *    campo continua na lista — é o caso do imóvel só de aluguel;
 *  - coloca todo `meta_key`, todo slug de taxonomia e todo valor de filtro
 *    como VALOR (`?`), nunca como identificador no texto;
 *  - lê a CATEGORIA pelas três tabelas de termos (terms, term_taxonomy,
 *    term_relationships) — e só as libera quando há categoria mapeada;
 *  - sai com `group_concat` (um post com dois termos sai UMA vez);
 *  - filtra por categoria com `exists` (e pelo nível: filho/raiz);
 *  - a categoria casa por IGUALDADE (o termo É "venda") ou pelo PEDÇO do texto;
 *  - esconde o conteúdo cujo campo está na lista de valores a esconder;
 *  - a ORDEM dos `?` bate com a ordem dos valores;
 *  - um filtro que a instância NÃO tem é ERRO legível, nunca silêncio;
 *  - NÃO traz foto (a imagem_url é da R4).
 */
import { describe, expect, it } from "vitest";

import {
  RECEITA_WORDPRESS_CONTEUDO,
  chaveDoRotulo,
  chaveUnica,
  descreverFiltrosDaInstancia,
  validarFiltrosDaBusca,
} from "./wordpress-conteudo";
import { MODELO_EM_BRANCO, MODELO_IMOVEIS, categoriasDoModelo, camposDoModelo } from "./modelos-wordpress";
import { validarConsultaDeReceita } from "./validador";

/** A configuração de uma IMOBILIÁRIA (o que o modelo "Imóveis" preenche). */
const FIXOS_IMOVEIS = {
  prefixo: "wp_",
  post_type: "imovel",
  campos: [
    { chave: "codigo", rotulo: "Código", meta_key: "codigo", tipo: "texto", filtro: "nenhum" },
    { chave: "preco", rotulo: "Preço de venda", meta_key: "preco", tipo: "preco", filtro: "maximo" },
    { chave: "quartos", rotulo: "Quartos", meta_key: "quartos", tipo: "numero", filtro: "minimo" },
  ],
  categorias: [
    {
      chave: "bairro",
      rotulo: "Bairro",
      taxonomia: "localizacao",
      nivel: "filho",
      filtro: "contem",
    },
    {
      chave: "finalidade",
      rotulo: "Finalidade",
      taxonomia: "finalidade",
      nivel: "qualquer",
      filtro: "igual",
    },
  ],
  esconder: { meta_key: "status_imovel", valores: ["vendido", "alugado"] },
};

/** A configuração de uma LOJA DE VEÍCULOS — o mesmo código, outro nicho. */
const FIXOS_VEICULOS = {
  prefixo: "wp_",
  post_type: "veiculo",
  campos: [
    { chave: "ano", rotulo: "Ano", meta_key: "ano", tipo: "numero", filtro: "minimo" },
    { chave: "km", rotulo: "Quilometragem", meta_key: "km", tipo: "numero", filtro: "maximo" },
    { chave: "preco", rotulo: "Preço", meta_key: "preco", tipo: "preco", filtro: "maximo" },
    { chave: "cambio", rotulo: "Câmbio", meta_key: "cambio", tipo: "texto", filtro: "contem" },
  ],
  categorias: [
    {
      chave: "marca",
      rotulo: "Marca",
      taxonomia: "marca_veiculo",
      nivel: "qualquer",
      filtro: "contem",
    },
    {
      chave: "combustivel",
      rotulo: "Combustível",
      taxonomia: "combustivel",
      nivel: "qualquer",
      filtro: "igual",
    },
  ],
};

/** Renderiza o SQL com os valores no lugar, para ler o texto como o banco lê. */
function renderizar(sql: string, valores: unknown[]): string {
  const partes = sql.split("?");
  if (partes.length - 1 !== valores.length) {
    throw new Error(`esperava ${valores.length} placeholders, achou ${partes.length - 1}`);
  }
  let texto = "";
  for (let i = 0; i < partes.length; i++) {
    texto += partes[i];
    if (i < valores.length) {
      const v = valores[i];
      texto += typeof v === "string" ? `'${v.replace(/'/g, "''")}'` : String(v);
    }
  }
  return texto;
}

describe("receita wordpress-conteudo (unit, sem MySQL)", () => {
  describe("as regras do Zod dos fixos", () => {
    it("aceita a configuração de imóveis e a de veículos (o mesmo código, dois nichos)", () => {
      expect(RECEITA_WORDPRESS_CONTEUDO.parametrosFixos.safeParse(FIXOS_IMOVEIS).success).toBe(true);
      expect(RECEITA_WORDPRESS_CONTEUDO.parametrosFixos.safeParse(FIXOS_VEICULOS).success).toBe(true);
    });

    it("o modelo Imóveis é uma configuração que o Zod aceita", () => {
      const fixosDoModelo = {
        prefixo: "wp_",
        post_type: MODELO_IMOVEIS.post_type,
        campos: camposDoModelo(MODELO_IMOVEIS),
        categorias: categoriasDoModelo(MODELO_IMOVEIS),
        ...(MODELO_IMOVEIS.esconder ? { esconder: MODELO_IMOVEIS.esconder } : {}),
      };
      const parseado = RECEITA_WORDPRESS_CONTEUDO.parametrosFixos.safeParse(fixosDoModelo);
      expect(parseado.success, JSON.stringify(parseado.success ? {} : parseado.error.issues)).toBe(
        true,
      );
    });

    it("recusa a mesma chave em dois dados (a saída não pode ter dois campos com o mesmo nome)", () => {
      const parseado = RECEITA_WORDPRESS_CONTEUDO.parametrosFixos.safeParse({
        ...FIXOS_IMOVEIS,
        campos: [
          ...FIXOS_IMOVEIS.campos,
          { chave: "bairro", rotulo: "Outro", meta_key: "bairro2", tipo: "texto", filtro: "nenhum" },
        ],
      });
      expect(parseado.success).toBe(false);
    });

    it("recusa a chave reservada (id, titulo e link já são colunas da saída)", () => {
      for (const reservada of ["id", "titulo", "link"]) {
        const parseado = RECEITA_WORDPRESS_CONTEUDO.parametrosFixos.safeParse({
          ...FIXOS_IMOVEIS,
          campos: [
            {
              chave: reservada,
              rotulo: "Conflito",
              meta_key: "conflito",
              tipo: "texto",
              filtro: "nenhum",
            },
          ],
        });
        expect(parseado.success, `aceitou a chave reservada ${reservada}`).toBe(false);
      }
    });

    it("recusa o filtro de conteúdo num campo que não é texto", () => {
      const parseado = RECEITA_WORDPRESS_CONTEUDO.parametrosFixos.safeParse({
        ...FIXOS_IMOVEIS,
        campos: [
          { chave: "ano", rotulo: "Ano", meta_key: "ano", tipo: "numero", filtro: "contem" },
        ],
      });
      expect(parseado.success).toBe(false);
    });

    it("recusa o filtro de mínimo ou máximo num campo de texto", () => {
      const parseado = RECEITA_WORDPRESS_CONTEUDO.parametrosFixos.safeParse({
        ...FIXOS_IMOVEIS,
        campos: [
          { chave: "cor", rotulo: "Cor", meta_key: "cor", tipo: "texto", filtro: "minimo" },
        ],
      });
      expect(parseado.success).toBe(false);
    });

    it("recusa prefixo, post_type, meta_key, taxonomia e chave fora do padrão", () => {
      const invalidos: Record<string, unknown>[] = [
        { prefixo: "wp; drop table" },
        { post_type: "Imóvel" },
        { post_type: "" },
      ];
      for (const invalido of invalidos) {
        const parseado = RECEITA_WORDPRESS_CONTEUDO.parametrosFixos.safeParse({
          ...FIXOS_IMOVEIS,
          ...invalido,
        });
        expect(parseado.success, `aceitou ${JSON.stringify(invalido)}`).toBe(false);
      }

      const metaKeyRuim = RECEITA_WORDPRESS_CONTEUDO.parametrosFixos.safeParse({
        ...FIXOS_IMOVEIS,
        campos: [
          { chave: "x", rotulo: "X", meta_key: "meta; drop", tipo: "texto", filtro: "nenhum" },
        ],
      });
      expect(metaKeyRuim.success).toBe(false);

      const taxonomiaRuim = RECEITA_WORDPRESS_CONTEUDO.parametrosFixos.safeParse({
        ...FIXOS_IMOVEIS,
        categorias: [
          {
            chave: "bairro",
            rotulo: "Bairro",
            taxonomia: "Localizacao",
            nivel: "filho",
            filtro: "contem",
          },
        ],
      });
      expect(taxonomiaRuim.success).toBe(false);

      const chaveRuim = RECEITA_WORDPRESS_CONTEUDO.parametrosFixos.safeParse({
        ...FIXOS_IMOVEIS,
        campos: [
          { chave: "Preço", rotulo: "Preço", meta_key: "preco", tipo: "texto", filtro: "nenhum" },
        ],
      });
      expect(chaveRuim.success).toBe(false);
    });

    it("recusa chave desconhecida (strict) e campos a mais do que o limite", () => {
      const estrito = RECEITA_WORDPRESS_CONTEUDO.parametrosFixos.safeParse({
        ...FIXOS_IMOVEIS,
        foto: "imagem",
      });
      expect(estrito.success).toBe(false);

      const muitos = Array.from({ length: 16 }, (_, i) => ({
        chave: `c${i}`,
        rotulo: `Campo ${i}`,
        meta_key: `c${i}`,
        tipo: "texto",
        filtro: "nenhum",
      }));
      expect(
        RECEITA_WORDPRESS_CONTEUDO.parametrosFixos.safeParse({ ...FIXOS_IMOVEIS, campos: muitos })
          .success,
      ).toBe(false);
    });

    it("recusa lista sem campos e mais de seis categorias", () => {
      expect(
        RECEITA_WORDPRESS_CONTEUDO.parametrosFixos.safeParse({ ...FIXOS_IMOVEIS, campos: [] })
          .success,
      ).toBe(false);

      const categorias = Array.from({ length: 7 }, (_, i) => ({
        chave: `c${i}`,
        rotulo: `Categoria ${i}`,
        taxonomia: `cat${i}`,
        nivel: "qualquer",
        filtro: "nenhum",
      }));
      expect(
        RECEITA_WORDPRESS_CONTEUDO.parametrosFixos.safeParse({
          ...FIXOS_IMOVEIS,
          categorias,
        }).success,
      ).toBe(false);
    });
  });

  describe("as regras do Zod da busca", () => {
    it("aceita filtros e limite", () => {
      const parseado = RECEITA_WORDPRESS_CONTEUDO.parametrosDaBusca.safeParse({
        filtros: { bairro: "centro", ano: 2020 },
        limite: 3,
      });
      expect(parseado.success).toBe(true);
    });

    it("recusa limite acima do teto e chave fora do registro", () => {
      expect(RECEITA_WORDPRESS_CONTEUDO.parametrosDaBusca.safeParse({ limite: 99 }).success).toBe(
        false,
      );
      expect(
        RECEITA_WORDPRESS_CONTEUDO.parametrosDaBusca.safeParse({ filtros: { bairro: "centro" }, x: 1 })
          .success,
      ).toBe(false);
    });
  });

  describe("a busca bate com o mapeamento da instância", () => {
    it("um filtro que a instância NÃO tem é erro legível (nunca silêncio)", () => {
      expect(() =>
        validarFiltrosDaBusca(FIXOS_VEICULOS, { filtros: { bairro: "centro" } }),
      ).toThrowError(/não existe nesta receita/);
    });

    it("a mensagem de recusa diz quais filtros a instância aceita", () => {
      let mensagem = "";
      try {
        validarFiltrosDaBusca(FIXOS_VEICULOS, { filtros: { bairro: "centro" } });
      } catch (err) {
        mensagem = (err as Error).message;
      }
      expect(mensagem).toContain("filtros disponíveis:");
      expect(mensagem).toContain("ano (Ano, mínimo)");
      expect(mensagem).toContain("marca (Marca, contém)");
    });

    it("um filtro que a instância tem mas NÃO filtra é erro (devolver tudo seria mentir)", () => {
      expect(() =>
        validarFiltrosDaBusca(FIXOS_IMOVEIS, { filtros: { codigo: "IM-001" } }),
      ).toThrowError(/não pode ser filtrado/);
    });

    it("o valor tem de ser do tipo que o filtro pede", () => {
      // "ano" é mínimo: espera número.
      expect(() => validarFiltrosDaBusca(FIXOS_VEICULOS, { filtros: { ano: "2020" } })).toThrowError(
        /espera um número/,
      );
      // "cambio" é contém: espera texto.
      expect(() =>
        validarFiltrosDaBusca(FIXOS_VEICULOS, { filtros: { cambio: 5 } }),
      ).toThrowError(/espera um texto/);
    });

    it("o filtro que a instância tem e aceita passa", () => {
      expect(() =>
        validarFiltrosDaBusca(FIXOS_VEICULOS, {
          filtros: { ano: 2020, marca: "fiat", combustivel: "flex" },
        }),
      ).not.toThrow();
    });

    it("a descrição dos filtros sai dos fixos, no formato que o agente lê", () => {
      expect(descreverFiltrosDaInstancia(FIXOS_VEICULOS)).toBe(
        "filtros disponíveis: ano (Ano, mínimo); km (Quilometragem, máximo); preco (Preço, máximo); cambio (Câmbio, contém); marca (Marca, contém); combustivel (Combustível, igual)",
      );
      // O dado sem filtro não entra na lista: ele não é filtrável.
      expect(descreverFiltrosDaInstancia(FIXOS_IMOVEIS)).not.toContain("codigo");
    });
  });

  describe("o SQL montado", () => {
    it("(a) imóveis: LEFT JOIN em tudo, sem junção obrigatória", () => {
      const { sql, valores } = RECEITA_WORDPRESS_CONTEUDO.montar(FIXOS_IMOVEIS, {}, 5);
      expect(sql).toContain("post_type = ?");
      expect(sql).toContain("post_status = ?");
      expect(valores).toContain("imovel");
      expect(valores).toContain("publish");
      // Nenhuma junção obrigatória: todo campo mapeado entra por LEFT JOIN.
      // As categorias saem por subconsulta (group_concat) com join interno;
      // essas subconsultas saem do texto antes de conferir que sobrou só
      // left join no nível de fora. O group_concat tem parênteses aninhados,
      // então a remoção conta a profundidade em vez de usar regex.
      const removeSubconsultas = (s: string): string => {
        const out: string[] = [];
        let i = 0;
        while (i < s.length) {
          if (/^\(select\b/i.test(s.slice(i))) {
            let prof = 0;
            let j = i;
            while (j < s.length) {
              if (s[j] === "(") prof += 1;
              else if (s[j] === ")") {
                prof -= 1;
                if (prof === 0) { j += 1; break; }
              }
              j += 1;
            }
            i = j;
            continue;
          }
          out.push(s[i]!);
          i += 1;
        }
        return out.join("");
      };
      const sqlSemSubconsultas = removeSubconsultas(sql);
      expect(sqlSemSubconsultas.replace(/left join/gi, "")).not.toMatch(/\bjoin\b/i);
      expect(sql.match(/left join/gi)?.length).toBe(FIXOS_IMOVEIS.campos.length);
      expect(sql.split("?").length - 1).toBe(valores.length);
    });

    it("(b) a CATEGORIA sai pela subconsulta do group_concat", () => {
      const { sql, valores } = RECEITA_WORDPRESS_CONTEUDO.montar(FIXOS_IMOVEIS, {}, 5);
      expect(sql).toContain("group_concat");
      expect(sql).toContain("separator ', '");
      expect(sql).toContain("tt.taxonomy = ?");
      // O nível entra no SQL: bairro = filho (parent <> 0).
      expect(sql).toContain("tt.parent <> 0");
      // Os slugs são VALORES, nunca identificadores no texto.
      expect(sql).not.toContain("localizacao");
      expect(valores).toContain("localizacao");
      expect(sql.split("?").length - 1).toBe(valores.length);
    });

    it("(c) veículos: o MESMO código monta o SQL de outro nicho", () => {
      const { sql, valores } = RECEITA_WORDPRESS_CONTEUDO.montar(FIXOS_VEICULOS, {}, 5);
      expect(valores).toContain("veiculo");
      expect(sql).toContain("`mpreco`.meta_value");
      expect(sql.split("?").length - 1).toBe(valores.length);
    });

    it("todo meta_key, slug e valor de filtro entra como valor (?) — nunca no texto", () => {
      const fixosRaros = {
        prefixo: "wp_",
        post_type: "imovel",
        campos: [
          { chave: "codigo", rotulo: "Código", meta_key: "cod_x9", tipo: "texto", filtro: "nenhum" },
          { chave: "preco", rotulo: "Preço", meta_key: "preco_x9", tipo: "preco", filtro: "maximo" },
        ],
        categorias: [
          {
            chave: "bairro",
            rotulo: "Bairro",
            taxonomia: "loc_x9",
            nivel: "filho",
            filtro: "contem",
          },
        ],
      };
      const { sql, valores } = RECEITA_WORDPRESS_CONTEUDO.montar(
        fixosRaros,
        { filtros: { bairro: "centro" } },
        5,
      );
      for (const cru of ["cod_x9", "preco_x9", "loc_x9"]) {
        expect(sql).not.toContain(cru);
      }
      expect(sql).not.toContain("meta_key = '");
      expect(sql).not.toContain("taxonomy = '");
      expect(sql.split("?").length - 1).toBe(valores.length);
      for (const valor of ["cod_x9", "preco_x9", "loc_x9", "%centro%"]) {
        expect(valores).toContain(valor);
      }
    });

    it("placeholders estão alinhados com os valores na ordem do texto", () => {
      const { sql, valores } = RECEITA_WORDPRESS_CONTEUDO.montar(
        FIXOS_IMOVEIS,
        { filtros: { bairro: "centro", quartos: 2, preco: 600000 }, limite: 3 },
        3,
      );
      const texto = renderizar(sql, valores);
      expect(texto).toContain("post_type = 'imovel'");
      expect(texto).toContain("post_status = 'publish'");
      expect(texto).toContain("meta_key = 'preco'");
      expect(texto).toContain("meta_key = 'quartos'");
      expect(texto).toContain("tt.taxonomy = 'localizacao'");
      expect(texto).toContain("limit 3");
    });

    it("o filtro de categoria é um exists (não multiplica a linha)", () => {
      const { sql } = RECEITA_WORDPRESS_CONTEUDO.montar(
        FIXOS_IMOVEIS,
        { filtros: { bairro: "centro" } },
        5,
      );
      expect(sql).toContain("exists (select 1 from");
      expect(sql).toContain("tr.object_id = p.ID");
      // "contém" casa pelo PEDÇO do texto.
      expect(sql).toContain("lower(t.name) like ? escape '!'");
    });

    it("a categoria com filtro 'igual' casa por IGUALDADE (nome ou slug)", () => {
      const { sql, valores } = RECEITA_WORDPRESS_CONTEUDO.montar(
        FIXOS_IMOVEIS,
        { filtros: { finalidade: "venda" } },
        5,
      );
      expect(sql).toContain("lower(t.name) = ? or lower(t.slug) = ?");
      // SEM o "%": um termo "Venda e Aluguel" não é "venda".
      expect(sql).not.toContain("%venda%");
      expect(valores).toContain("venda");
      expect(sql.split("?").length - 1).toBe(valores.length);
    });

    it("o filtro de número compara como CAST e o de preço com a conversão robusta", () => {
      const { sql, valores } = RECEITA_WORDPRESS_CONTEUDO.montar(
        FIXOS_VEICULOS,
        { filtros: { ano: 2020, km: 60000, preco: 90000 } },
        5,
      );
      expect(sql).toContain("(CAST(`mano`.meta_value AS DECIMAL(10,2))) >= ?");
      expect(sql).toContain("(CAST(`mkm`.meta_value AS DECIMAL(10,2))) <= ?");
      expect(sql).toContain("CASE");
      expect(sql).toContain("REGEXP");
      expect(valores).toContain(2020);
      expect(valores).toContain(60000);
      expect(valores).toContain(90000);
    });

    it("o filtro de texto casa pelo pedaço, com o escape do LIKE", () => {
      const { sql, valores } = RECEITA_WORDPRESS_CONTEUDO.montar(
        FIXOS_VEICULOS,
        { filtros: { cambio: "manual" } },
        5,
      );
      expect(sql).toContain("lower(`mcambio`.meta_value) like ? escape '!'");
      expect(valores).toContain("%manual%");
    });

    it("o que fica de fora some: not exists sobre o campo escondido", () => {
      const { sql, valores } = RECEITA_WORDPRESS_CONTEUDO.montar(FIXOS_IMOVEIS, {}, 5);
      expect(sql).toContain("not exists (select 1 from");
      expect(sql).toContain("lower(`mesconder`.meta_value) in (?, ?)");
      expect(valores).toContain("status_imovel");
      expect(valores).toContain("vendido");
      expect(valores).toContain("alugado");
      // A ordem dos `?`: o campo antes da lista de valores.
      const texto = renderizar(sql, valores);
      expect(texto).toContain("meta_key = 'status_imovel'");
      expect(texto).toContain("in ('vendido', 'alugado')");
    });

    it("sem o que esconder, nenhum post é escondido", () => {
      const semEsconder: Record<string, unknown> = { ...FIXOS_IMOVEIS };
      delete semEsconder.esconder;
      const { sql } = RECEITA_WORDPRESS_CONTEUDO.montar(semEsconder, {}, 5);
      expect(sql).not.toContain("not exists");
    });

    it("a saída traz as colunas do contrato: id, titulo, cada dado pela chave, link", () => {
      const { sql } = RECEITA_WORDPRESS_CONTEUDO.montar(FIXOS_IMOVEIS, {}, 5);
      expect(sql).toContain("p.ID as id");
      expect(sql).toContain("p.post_title as titulo");
      expect(sql).toContain("as `codigo`");
      expect(sql).toContain("as `preco`");
      expect(sql).toContain("as `quartos`");
      expect(sql).toContain("as `bairro`");
      expect(sql).toContain("as `finalidade`");
      expect(sql).toContain("p.guid as link");
    });

    it("o apelido da SAÍDA vai QUOTADO (chave reservada do MySQL não quebra a consulta)", () => {
      // `key`, `order` e `rank` são palavras RESERVADAS do MySQL: cruas no
      // texto, a consulta nem roda. A chave sai do rótulo que a pessoa
      // escreveu — então ela vai quotada, como todo identificador.
      const fixosComReservadas = {
        prefixo: "wp_",
        post_type: "imovel",
        campos: [
          { chave: "key", rotulo: "Chave do anúncio", meta_key: "chave_imovel", tipo: "texto", filtro: "nenhum" },
          { chave: "order", rotulo: "Ordem", meta_key: "ordem_imovel", tipo: "numero", filtro: "nenhum" },
        ],
        categorias: [
          {
            chave: "rank",
            rotulo: "Posição",
            taxonomia: "posicao",
            nivel: "qualquer",
            filtro: "contem",
          },
        ],
      };
      const { sql } = RECEITA_WORDPRESS_CONTEUDO.montar(fixosComReservadas, {}, 5);
      expect(sql).toContain("as `key`");
      expect(sql).toContain("as `order`");
      expect(sql).toContain("as `rank`");
      // Cru no texto, nenhuma delas aparece.
      expect(sql).not.toMatch(/as (key|order|rank)\b/);
      // E o SQL continua passando no validador.
      expect(() =>
        validarConsultaDeReceita(sql, RECEITA_WORDPRESS_CONTEUDO.tabelas(fixosComReservadas)),
      ).not.toThrow();
    });

    it("o SQL passa no validador com as tabelas permitidas (e falha sem as de categoria)", () => {
      const { sql } = RECEITA_WORDPRESS_CONTEUDO.montar(FIXOS_IMOVEIS, {}, 5);
      const comCategoria = RECEITA_WORDPRESS_CONTEUDO.tabelas(FIXOS_IMOVEIS);
      expect(() => validarConsultaDeReceita(sql, comCategoria)).not.toThrow();
      // Sem as três tabelas de termos liberadas, a consulta é recusada.
      const semCategoria = RECEITA_WORDPRESS_CONTEUDO.tabelas({
        ...FIXOS_IMOVEIS,
        categorias: [],
      });
      expect(() => validarConsultaDeReceita(sql, semCategoria)).toThrow();
    });
  });

  describe("as tabelas e colunas liberadas", () => {
    it("sem categoria mapeada, só posts e postmeta", () => {
      const fixos = { ...FIXOS_IMOVEIS, categorias: [] };
      expect(RECEITA_WORDPRESS_CONTEUDO.tabelas(fixos)).toEqual(["wp_posts", "wp_postmeta"]);
      expect(Object.keys(RECEITA_WORDPRESS_CONTEUDO.colunas(fixos))).toEqual([
        "wp_posts",
        "wp_postmeta",
      ]);
    });

    it("com categoria mapeada, as três tabelas de termos entram", () => {
      const tabelas = RECEITA_WORDPRESS_CONTEUDO.tabelas(FIXOS_IMOVEIS);
      expect(tabelas).toContain("wp_terms");
      expect(tabelas).toContain("wp_term_taxonomy");
      expect(tabelas).toContain("wp_term_relationships");
      const colunas = RECEITA_WORDPRESS_CONTEUDO.colunas(FIXOS_IMOVEIS);
      expect(colunas["wp_terms"]).toContain("name");
      expect(colunas["wp_terms"]).toContain("slug");
      expect(colunas["wp_term_taxonomy"]).toContain("parent");
      expect(colunas["wp_term_relationships"]).toContain("object_id");
    });

    it("o prefixo entra nas tabelas (o site pode ter outro prefixo)", () => {
      const fixos = { ...FIXOS_IMOVEIS, prefixo: "loja_" };
      expect(RECEITA_WORDPRESS_CONTEUDO.tabelas(fixos)).toEqual([
        "loja_posts",
        "loja_postmeta",
        "loja_terms",
        "loja_term_taxonomy",
        "loja_term_relationships",
      ]);
    });
  });

  describe("a guarda da foto", () => {
    it("nenhuma foto: sem _thumbnail_id, sem attachment e sem imagem_url", () => {
      const { sql, valores } = RECEITA_WORDPRESS_CONTEUDO.montar(
        FIXOS_IMOVEIS,
        { filtros: { bairro: "centro", preco: 600000 }, limite: 5 },
        5,
      );
      expect(sql).not.toContain("_thumbnail_id");
      expect(sql).not.toContain("imagem_url");
      expect(sql).not.toContain("attachment");
      expect(valores).not.toContain("_thumbnail_id");
      expect(valores).not.toContain("attachment");
    });
  });

  describe("a chave gerada do rótulo", () => {
    it("tira o acento, baixa e troca o espaço por underscore", () => {
      expect(chaveDoRotulo("Preço de venda")).toBe("preco_de_venda");
      expect(chaveDoRotulo("Área")).toBe("area");
      expect(chaveDoRotulo("Quilometragem")).toBe("quilometragem");
    });

    it("um rótulo que começa por número ganha um prefixo (a chave começa por letra)", () => {
      expect(chaveDoRotulo("2024")).toBe("c_2024");
    });

    it("rótulo repetido vira uma chave nova, e não o mesmo dado duas vezes", () => {
      expect(chaveUnica("preco", ["preco"])).toBe("preco_2");
      expect(chaveUnica("preco", ["preco", "preco_2"])).toBe("preco_3");
      expect(chaveUnica("preco", ["outro"])).toBe("preco");
    });

    it("a chave RESERVADA da saída conta como usada (o rótulo 'Título' vira 'titulo_2')", () => {
      // `id`, `titulo` e `link` já são colunas da saída: um dado com o mesmo
      // nome colidiria com elas, e o servidor recusaria com um erro que a
      // pessoa não entende. A tela tem de resolver antes.
      expect(chaveUnica("titulo", [])).toBe("titulo_2");
      expect(chaveUnica("titulo", ["titulo_2"])).toBe("titulo_3");
      expect(chaveUnica("id", [])).toBe("id_2");
      expect(chaveUnica("link", [])).toBe("link_2");
      // E uma chave normal continua como estava.
      expect(chaveUnica("preco", [])).toBe("preco");
    });

    it("um rótulo que não vira chave fica vazio (a tela recusa com frase legível)", () => {
      expect(chaveDoRotulo("!!!")).toBe("");
      expect(chaveDoRotulo("   ")).toBe("");
      expect(chaveUnica(chaveDoRotulo("!!!"), [])).toBe("");
    });
  });

  describe("os modelos", () => {
    it("o modelo Imóveis traz os campos e as categorias do cadastro de imobiliária", () => {
      expect(MODELO_IMOVEIS.campos.map((c) => c.chave)).toContain("preco");
      expect(MODELO_IMOVEIS.campos.map((c) => c.chave)).toContain("quartos");
      expect(MODELO_IMOVEIS.categorias.map((c) => c.chave)).toContain("bairro");
      expect(MODELO_IMOVEIS.categorias.find((c) => c.chave === "bairro")?.nivel).toBe("filho");
      expect(MODELO_IMOVEIS.categorias.find((c) => c.chave === "finalidade")?.filtro).toBe("igual");
      expect(MODELO_IMOVEIS.esconder?.meta_key).toBe("status_imovel");
      expect(MODELO_IMOVEIS.esconder?.valores).toEqual(["vendido", "alugado"]);
    });

    it("o modelo Em branco não sugere tipo de post (o site de cada pessoa o nomeia)", () => {
      expect(MODELO_EM_BRANCO.post_type).toBe("");
      expect(MODELO_EM_BRANCO.campos).toHaveLength(0);
    });
  });
});
