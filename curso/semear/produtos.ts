/**
 * Semente do módulo "Produtos" (CRM › Ver tudo em CRM › Produtos).
 *
 * O catálogo da Clínica Bem Viver: serviços vendidos em pacote (sem controle de
 * estoque) e itens de prateleira (com estoque, um deles zerado), mais um produto
 * desativado — os três jeitos que a linha da lista aparece. O whey tem duas fotos
 * de verdade no bucket `catalog-photos`, no caminho que a rota de upload geraria
 * (`<org>/<produto>/<uuid>.png`): é o que o painel "Fotos" e a capa da linha mostram.
 *
 * Idempotente: apaga só as próprias linhas (ids fixos + o que as lições criam
 * pela tela, por código e por nome nos dois idiomas) e recria; as fotos sobem com
 * upsert. A mesma limpeza sai como `limpar`, que a base chama antes de qualquer
 * aula. A moeda vem da organização, como no cadastro pela tela (`moedaDaOrganizacao`).
 */
import { deflateSync } from "node:zlib";

import { type Contexto, semErro } from "../semear-demonstracao";
import { textoDaDemonstracao as demo, traducaoDaDemonstracao } from "../espanhol-demonstracao";

const produtoId = (n: number) => `d1070000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const fotoId = (n: number) => `d1070100-0000-4000-8000-${String(n).padStart(12, "0")}`;

/**
 * O que as lições criam pela tela (a faixa elástica de "Cadastrar um produto"):
 * limpo aqui para cada lição partir do mesmo estado. O código não se traduz; o
 * nome, sim — por isso a limpeza procura pelos dois.
 */
const CRIADAS_NAS_LICOES = [{ codigo: "FIS-FAIXA", nome: "Faixa elástica de exercício média" }];

/**
 * PT e ES sempre, qualquer que seja o idioma da captura: a bancada é a mesma, e
 * um produto deixado pela aula em espanhol sobraria na foto em português.
 * `traducaoDaDemonstracao` não lança (o `demo` lançaria em ES sem entrada).
 */
const nosDoisIdiomas = (textos: readonly string[]) => [
  ...new Set(textos.flatMap((t) => [t, traducaoDaDemonstracao(t) ?? t])),
];

// ---------- fotos: PNG RGB desenhado à mão, sem dependência ----------

function crc32(buf: Buffer) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function bloco(tipo: string, dados: Buffer) {
  const corpo = Buffer.concat([Buffer.from(tipo, "ascii"), dados]);
  const tam = Buffer.alloc(4), crc = Buffer.alloc(4);
  tam.writeUInt32BE(dados.length);
  crc.writeUInt32BE(crc32(corpo));
  return Buffer.concat([tam, corpo, crc]);
}
/** Letras 5x7 só das que o rótulo usa. */
const FONTE: Record<string, string[]> = {
  W: ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
};
type Cor = readonly [number, number, number];

/**
 * Pote de whey, 360x360. `frente`: rótulo baunilha com "WHEY"; senão o verso, com
 * a tabela nutricional em linhas cinza. Fundo claro, como foto de catálogo.
 */
function poteDeWheyPng(frente: boolean) {
  const L = 360, A = 360;
  const FUNDO: Cor = frente ? [244, 240, 232] : [236, 241, 238];
  const POTE: Cor = [252, 252, 250], CONTORNO: Cor = [196, 200, 198];
  const TAMPA: Cor = [47, 125, 109], ROTULO: Cor = [233, 199, 128], BRANCO: Cor = [255, 255, 255];
  const CINZA: Cor = [150, 156, 154], SOMBRA: Cor = frente ? [226, 221, 211] : [218, 225, 221];
  const px: Cor[][] = Array.from({ length: A }, () => Array.from({ length: L }, () => FUNDO));
  const retangulo = (x0: number, y0: number, x1: number, y1: number, cor: Cor, raio = 0) => {
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const dx = Math.max(x0 + raio - x, 0, x - (x1 - 1 - raio));
        const dy = Math.max(y0 + raio - y, 0, y - (y1 - 1 - raio));
        if (dx * dx + dy * dy <= raio * raio) px[y]![x] = cor;
      }
  };
  retangulo(96, 300, 264, 318, SOMBRA, 9); // sombra no chão
  retangulo(98, 112, 262, 306, CONTORNO, 18);
  retangulo(101, 115, 259, 303, POTE, 16);
  retangulo(108, 70, 252, 118, TAMPA, 8);
  retangulo(101, 160, 259, 262, ROTULO);
  if (frente) {
    const escala = 6, texto = "WHEY";
    let x0 = Math.round((L - (texto.length * 6 * escala - escala)) / 2);
    for (const letra of texto) {
      FONTE[letra]?.forEach((linha, gy) =>
        [...linha].forEach((b, gx) => {
          if (b === "1") retangulo(x0 + gx * escala, 190 + gy * escala, x0 + (gx + 1) * escala, 190 + (gy + 1) * escala, BRANCO);
        }),
      );
      x0 += 6 * escala;
    }
  } else {
    retangulo(120, 172, 240, 250, BRANCO, 4);
    for (let i = 0; i < 6; i++) retangulo(130, 182 + i * 11, i % 2 ? 200 : 228, 186 + i * 11, CINZA);
  }
  const linhas = px.map((linha) => {
    const b = Buffer.alloc(1 + L * 3);
    linha.forEach((cor, x) => b.set(cor, 1 + x * 3));
    return b;
  });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(L, 0);
  ihdr.writeUInt32BE(A, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    bloco("IHDR", ihdr),
    bloco("IDAT", deflateSync(Buffer.concat(linhas))),
    bloco("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- o catálogo ----------

type Item = {
  n: number;
  codigo: string;
  nome: string;
  descricao?: string;
  marca?: string;
  categoria: string;
  /** Reais, com centavos. */
  preco: number;
  custo?: number;
  /** `null` = sem controle de estoque (serviço, sob encomenda). */
  estoque: number | null;
  ativo?: boolean;
};

const CATALOGO: Item[] = [
  {
    n: 1, codigo: "FIS-AVAL", nome: "Avaliação fisioterapêutica", categoria: "Fisioterapia", preco: 180, estoque: null,
    descricao: "Primeira consulta com o fisioterapeuta, com testes de postura e de movimento. Dura cerca de 50 minutos.",
  },
  {
    n: 2, codigo: "NUT-CONS", nome: "Consulta nutricional", categoria: "Nutrição", preco: 280, estoque: null,
    descricao: "Consulta com a nutricionista, com avaliação do corpo e plano alimentar. O retorno em 30 dias está incluso.",
  },
  {
    n: 3, codigo: "ODO-ESC", nome: "Escova dental ortodôntica", marca: "OralMax", categoria: "Odontologia",
    preco: 24.9, custo: 11, estoque: 30,
    descricao: "Cerdas macias e ponta em V, para quem usa aparelho fixo. Vem com capa de viagem.",
  },
  {
    n: 4, codigo: "ODO-CLAR", nome: "Kit de clareamento dental caseiro", marca: "BrancoSorriso", categoria: "Odontologia",
    preco: 349, custo: 190, estoque: 6,
    descricao: "Moldeiras feitas sob medida e gel clareador para 3 semanas. A entrega é feita na consulta com o dentista.",
  },
  {
    n: 5, codigo: "PIL-10", nome: "Pacote 10 sessões de pilates", categoria: "Pilates", preco: 890, estoque: null,
    descricao: "Dez aulas de pilates em aparelhos, em turmas de até 3 pessoas. Vale por 60 dias.",
  },
  {
    n: 6, codigo: "FIS-PALM", nome: "Palmilha ortopédica sob medida", categoria: "Fisioterapia", preco: 420, custo: 210, estoque: null,
    descricao: "Feita sob encomenda depois da avaliação da pisada. Fica pronta em 15 dias.",
  },
  {
    n: 7, codigo: "NUT-WHEY", nome: "Whey protein baunilha 900 g", marca: "NutriVida", categoria: "Suplementos",
    preco: 189.9, custo: 120, estoque: 12,
    descricao: "Proteína do soro do leite, sabor baunilha. Pote com 30 doses de 30 g.",
  },
  {
    n: 8, codigo: "NUT-OMEGA3", nome: "Suplemento de ômega 3 com 120 cápsulas", marca: "NutriVida", categoria: "Suplementos",
    preco: 89.9, custo: 52, estoque: 0,
  },
  {
    n: 9, codigo: "FIS-BOLA", nome: "Bola suíça 65 cm", marca: "MoveFit", categoria: "Fisioterapia",
    preco: 129, custo: 70, estoque: 4, ativo: false,
  },
];

/** O whey: as duas fotos, a frente primeiro (é a capa). */
const FOTOS_DO_WHEY = [
  { arquivo: `${fotoId(1)}.png`, frente: true },
  { arquivo: `${fotoId(2)}.png`, frente: false },
];

const centavos = (reais: number) => Math.round(reais * 100);

const WHEY = produtoId(7);
const caminhoDaFoto = (org: string, arquivo: string) => `${org}/${WHEY}/${arquivo}`;

/**
 * Limpeza chamada antes de QUALQUER aula: o catálogo deste módulo não sobra em
 * outra tela (o seletor de produtos da proposta lê o mesmo catálogo, e a busca da
 * aula de outro módulo acharia estes itens). Apaga só as próprias linhas — os ids
 * fixos, o que a lição de cadastro cria pela tela (pelo código e pelo nome, nos
 * dois idiomas) e as fotos do whey no bucket. Nada referencia o produto com
 * `restrict`: o item de proposta fica com `product_id` nulo, então a ordem é livre.
 */
export async function limpar(c: Contexto) {
  const { db, org } = c;
  semErro(
    await db.from("catalog_products").delete().eq("organization_id", org).in("id", CATALOGO.map((p) => produtoId(p.n))),
    "limpar produtos do módulo",
  );
  semErro(
    await db
      .from("catalog_products")
      .delete()
      .eq("organization_id", org)
      .in("codigo", CRIADAS_NAS_LICOES.map((p) => p.codigo)),
    "limpar produtos criados nas lições (código)",
  );
  semErro(
    await db
      .from("catalog_products")
      .delete()
      .eq("organization_id", org)
      .in("nome", nosDoisIdiomas(CRIADAS_NAS_LICOES.map((p) => p.nome))),
    "limpar produtos criados nas lições (nome)",
  );
  semErro(
    await db.storage.from("catalog-photos").remove(FOTOS_DO_WHEY.map((f) => caminhoDaFoto(org, f.arquivo))),
    "limpar fotos do módulo",
  );
}

export async function semear(c: Contexto) {
  await limpar(c);
  const { db, org } = c;

  const { data: organizacao } = await db.from("organizations").select("currency").eq("id", org).maybeSingle();
  const moeda = (organizacao as { currency?: string | null } | null)?.currency || "BRL";

  for (const { arquivo, frente } of FOTOS_DO_WHEY) {
    semErro(
      await db.storage
        .from("catalog-photos")
        .upload(caminhoDaFoto(org, arquivo), poteDeWheyPng(frente), { contentType: "image/png", upsert: true }),
      `subir a foto ${arquivo}`,
    );
  }

  semErro(
    await db.from("catalog_products").insert(
      CATALOGO.map((p) => ({
        id: produtoId(p.n),
        organization_id: org,
        codigo: p.codigo,
        nome: demo(p.nome),
        descricao: p.descricao ? demo(p.descricao) : null,
        marca: p.marca ? demo(p.marca) : null,
        categoria: demo(p.categoria),
        preco_cents: centavos(p.preco),
        moeda,
        custo_cents: p.custo === undefined ? null : centavos(p.custo),
        controla_estoque: p.estoque !== null,
        quantidade: p.estoque ?? 0,
        ativo: p.ativo ?? true,
        origem: "manual",
        fotos: produtoId(p.n) === WHEY ? FOTOS_DO_WHEY.map((f) => caminhoDaFoto(org, f.arquivo)) : [],
      })),
    ),
    "produtos do módulo",
  );
}
