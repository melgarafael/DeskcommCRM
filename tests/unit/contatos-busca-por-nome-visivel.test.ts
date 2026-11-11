/**
 * A BUSCA DE CONTATO PROCURA PELO NOME QUE A TELA MOSTRA.
 *
 * ⚠️ ESTE TESTE NASCEU DE UM TURNO DE AGENTE REAL, não de uma revisão de código.
 * Pedido para marcar um retorno para "Cliente Retorno E2E", o modelo chamou
 * `crm_search_contacts`, recebeu zero resultados para um contato que EXISTE, e
 * desistiu — "pode ser necessário adicionar o cliente ao CRM". A demanda morreria
 * ali, e o motivo era uma coluna faltando no `OR` da busca.
 *
 * Contato que entra pelo WhatsApp nasce só com `display_name` (o pushName do
 * aparelho); `name` fica nulo até alguém editar à mão. A busca olhava só `name`,
 * `email` e `phone_number` — ou seja, ignorava justamente o nome que a pessoa lê
 * na tela e digita no campo de busca.
 *
 * ⚠️ O QUE ESTE ARQUIVO NÃO AFIRMA. Esta linha já dizia "a UI inteira prefere
 * `display_name` (ver `resolveContactName`)", e a afirmação envelheceu inteira
 * na issue #906, que inverteu a precedência: quem decide o nome exibido é
 * `nomeDoContato` (lib/contacts/rotulo-do-contato.ts), e a ordem em vigor se lê
 * ali, não aqui. O que justifica `display_name` no OR não é a ordem — é o DADO:
 * ela é a única coluna preenchida em 15 dos 33 contatos desta instalação, e essa
 * razão continua verdadeira com a ordem invertida.
 *
 * O teste é sobre o FILTRO montado, não sobre o resultado do banco: é a decisão
 * que estava errada, e é ela que precisa ficar vigiada.
 */
import { describe, expect, it } from "vitest";

import { listContactsHandler } from "@/app/api/v1/contacts/_handler";
import { termoSemAcento } from "@/lib/inbox/termo-de-busca";

const ORG = "11111111-1111-4111-8111-111111111111";

/** Client mínimo que só guarda o filtro `.or()` que o handler montou. */
function supabaseEspiao() {
  const filtros: string[] = [];
  const colunasIs: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => chain,
    contains: () => chain,
    // O dublê tem de conhecer TODOS os elos que o handler encadeia: um elo que
    // falta não vira "asserção que não passa", vira `TypeError` no meio da
    // consulta — e o vermelho aparece em cinco casos de busca que não têm nada
    // a ver com o que mudou.
    is: (col: string) => {
      colunasIs.push(col);
      return chain;
    },
    or: (expr: string) => {
      filtros.push(expr);
      return chain;
    },
    then: (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res),
  };
  return { client: { from: () => chain } as never, filtros, colunasIs };
}

async function filtroDaBusca(termo: string, soContato?: string): Promise<string> {
  const { client, filtros } = supabaseEspiao();
  await listContactsHandler(
    client,
    { organization_id: ORG, actor: { type: "user", id: "u-1" }, requestId: "req" },
    { search: termo, limit: 20 },
    soContato,
  );
  return filtros[0] ?? "";
}

/**
 * A condição de NOME casada como o Postgres casa: o valor da coluna gerada é
 * `lower(f_unaccent(...))`, então `termoSemAcento` normaliza o valor e o `like`
 * compara. O padrão do handler já sai com `*` (curinga do PostgREST).
 */
function casaNoNome(filtro: string, nome: string): boolean {
  const normalizado = termoSemAcento(nome);
  return [...filtro.matchAll(/(busca_sem_acento(?:_sem_agenda)?)\.like\.([^,]+)/g)].some((m) =>
    padraoCasa(m[2]!, normalizado),
  );
}

/** O `LIKE` do PostgREST: `*` é curinga, `\%`/`\_` são literais. */
function padraoCasa(padrao: string, valor: string): boolean {
  const literal = (ch: string) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let re = "";
  for (let i = 0; i < padrao.length; i++) {
    const ch = padrao[i]!;
    if (ch === "\\" && i + 1 < padrao.length) re += literal(padrao[++i]!);
    else if (ch === "*" || ch === "%") re += ".*";
    else if (ch === "_") re += ".";
    else re += literal(ch);
  }
  return new RegExp(`^${re}$`).test(valor);
}

/** As colunas que a listagem exige serem NULL. */
async function colunasComIsNull(): Promise<string[]> {
  const { client, colunasIs } = supabaseEspiao();
  await listContactsHandler(
    client,
    { organization_id: ORG, actor: { type: "user", id: "u-1" }, requestId: "req" },
    { limit: 20 },
  );
  return colunasIs;
}

describe("busca de contatos", () => {
  it("procura no display_name — o nome que a tela mostra e o WhatsApp preenche", async () => {
    // O espaço do termo virou curinga na #1835 (a mesma régua da busca de
    // conversas); o que este caso vigia é a COLUNA estar no OR. Desde a #3918
    // (fatia 2) ela é a gerada `busca_sem_acento`, que carrega display_name,
    // name e o nome da agenda.
    const filtro = await filtroDaBusca("Cliente Retorno");
    expect(filtro).toContain("busca_sem_acento.like.");
    expect(casaNoNome(filtro, "Cliente Retorno E2E"), `filtro=${filtro}`).toBe(true);
  });

  it("procura no nome da agenda do celular — a tela o mostra quando não há nome no CRM (#2439)", async () => {
    // A coluna do banco carrega `display_name`, `name` E `address_book_name`;
    // por isso o nome da agenda continua alcançável sem uma condição própria.
    const filtro = await filtroDaBusca("João obra");
    expect(filtro).toContain("busca_sem_acento.like.");
    expect(casaNoNome(filtro, "João obra"), `filtro=${filtro}`).toBe(true);
  });

  it("a busca do agente durante a conversa NÃO olha o nome da agenda — ele é só da equipe (#2439)", async () => {
    // Com o contato do turno (`crm_search_contacts` em atendimento), casar na
    // agenda faria a ferramenta responder ao modelo se o rótulo interno contém
    // o termo — o mesmo vazamento que a guarda SO_DA_EQUIPE fecha no template.
    // A coluna sem agenda é a que entra.
    const filtro = await filtroDaBusca("caloteira", "22222222-2222-4222-8222-222222222222");
    expect(filtro).not.toContain("address_book_name");
    expect(filtro).toContain("busca_sem_acento_sem_agenda.like.");
    expect(filtro).not.toContain("busca_sem_acento.like.");
  });

  it("continua procurando nas colunas que já procurava", async () => {
    // A adição não pode custar as outras: quem cadastrou o contato à mão tem
    // `name`, e quem digita telefone espera achar por telefone.
    const filtro = await filtroDaBusca("Maria");
    for (const coluna of ["busca_sem_acento.like", "email.ilike", "phone_number.ilike"]) {
      expect(filtro).toContain(coluna);
    }
  });

  it("nome com vírgula não injeta condição extra no filtro", async () => {
    // `,` separa condições no `.or()`. Sem saneamento, "Silva, Maria" viraria
    // duas condições e a busca devolveria gente que ninguém pediu — e depois da
    // #1835 a vírgula não some: ela vira o MESMO curinga do espaço, que é o que
    // faz "Silva Maria" achar o cadastro "Silva, Maria" (a asserção de baixo é a
    // catraca da normalização; a de cima é a da gramática).
    const filtro = await filtroDaBusca("Silva, Maria");
    expect(filtro).not.toContain("Silva,");
    // Os dois sentidos: quem DIGITA a vírgula acha o cadastro que a tem, e quem
    // não digita também — é o curinga que a normalização põe no lugar dela.
    expect(casaNoNome(filtro, "Silva, Maria"), `filtro=${filtro}`).toBe(true);
    expect(casaNoNome(await filtroDaBusca("Silva Maria"), "Silva, Maria")).toBe(true);
  });

  it("curinga do LIKE digitado pelo usuário é literal, não coringa", async () => {
    // No `like` o `%` e o `_` SÃO curinga de natureza — quem os torna literais
    // é o escape do `termoSeguroParaOr`. Prova nos dois sentidos.
    const filtro = await filtroDaBusca("100%");
    expect(casaNoNome(filtro, "Plano 100%"), `filtro=${filtro}`).toBe(true);
    expect(casaNoNome(filtro, "Plano 1000"), `filtro=${filtro}`).toBe(false);
  });

  it("busca o celular também pela grafia com o nono — senão o cadastro some", async () => {
    // Quem cola +553284793302 tem que achar o contato gravado como +5532984793302.
    const filtro = await filtroDaBusca("3284793302");
    expect(filtro).toContain("phone_number.ilike.%5532984793302%");
  });

  it("a lápide de uma fusão não é um contato da lista", async () => {
    // `is_merged_into` marca o cadastro ABSORVIDO por outro. Ele não é apagado
    // (é o que libera telefone e e-mail para o vencedor herdar, e é o registro
    // da fusão), mas deixou de ser uma pessoa da base.
    //
    // Esta listagem era a ÚNICA leitura de `contacts` do repositório que não
    // filtrava — `contacts/duplicates`, o webhook de captação e as duas leituras
    // de `lib/channels/contato-por-telefone` já filtravam. Medido pela tela em
    // 2026-09-04: logo depois de juntar dois cadastros, a lista mostrava OS
    // DOIS, com o mesmo telefone e ambos com status "ativo", e o rodapé dizia
    // "2 contatos". Quem opera conclui que a fusão não funcionou.
    expect(await colunasComIsNull()).toContain("is_merged_into");
  });
});
