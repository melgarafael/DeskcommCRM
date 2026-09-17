import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * O TÍTULO DO EVENTO PESSOAL NÃO ATRAVESSA PARA A TELA DO CRM.
 *
 * ─── Por que isto é um gate e não um comentário ──────────────────────────────
 * A decisão de mostrar a ocupação do Google SEM o nome do evento é deliberada, e
 * um comentário sozinho não a protege: quem chega depois lê a ausência do título
 * como esquecimento e o acrescenta achando que está melhorando a tela. Nesta
 * base a regra é conhecida — mecanismo protege, prosa é intenção.
 *
 * ─── A decisão, e ela é medida ───────────────────────────────────────────────
 * `calendar_external_events.title` EXISTE, e guarda nome em linhas gravadas antes
 * da v1.17.0 (desde a migration 0225 o sincronizador grava o título nulo e zera
 * o que encontra). O que não pode é chegar à tela: a agenda conectada é PESSOAL de quem atende e a tela da Agenda
 * é multi-tenant, vista por gestor. "Consulta médica", "terapia", "entrevista de
 * emprego" apareceriam para o chefe.
 *
 * O cal.com decidiu o mesmo, e a prova de que é decisão e não limitação é que
 * eles gravam `summary`/`description`/`location` no cache e o `select` da
 * leitura devolve só `start`/`end`/`timeZone`. Guardar e não ler é intenção.
 *
 * E o nosso caso é pior que o deles: no cal.com a tela é do próprio dono da
 * agenda; aqui, não.
 *
 * ─── O que este gate NÃO proíbe ──────────────────────────────────────────────
 * Ler `title` no SERVIDOR para outra finalidade — um relatório do próprio dono
 * da agenda, um export de LGPD para o titular — não é o que está em jogo. O que
 * se guarda é a travessia para a TELA da Agenda, que é onde a exposição
 * acontece. Por isso o recorte não é o repo inteiro — mas ele também não é uma
 * pasta só.
 *
 * ⚠️ O RECORTE PRECISOU CRESCER, e o motivo foi MEDIDO — não é zelo.
 *
 * Ele era `app/app/agenda/**` e mais nada. Isso bastava enquanto a ocupação
 * chegava à tela por UM caminho: a semente que o servidor monta em `page.tsx`.
 * O PR #474 (@Clalber) acrescentou o segundo — a rota
 * `app/api/v1/agenda/agendamentos`, que substitui a semente no primeiro
 * refetch e serve TODA navegação depois dele.
 *
 * A guarda ficou cega para o caminho novo. Medido na triagem do #474, a mesma
 * sabotagem (`title` acrescentado ao `select`) nos dois lados:
 *
 *   em `app/app/agenda/page.tsx`                 → exit 1  (a guarda pega)
 *   em `app/api/v1/agenda/agendamentos/route.ts` → exit 0  (a guarda passa)
 *
 * O recorte de uma guarda de privacidade não é a PASTA onde a tela mora: é o
 * conjunto de caminhos por onde o dado chega até ela. Caminho novo entra aqui
 * — senão a guarda segue verde afirmando o que deixou de medir, que é o pior
 * desfecho para uma guarda de ausência.
 *
 * ⚠️ E O NOME DA RELAÇÃO É CAMINHO TAMBÉM — a mesma cegueira, uma segunda vez.
 *
 * O PR #613 (d69d708d8) trocou as duas leituras de `calendar_external_events`
 * pela view `calendar_selected_external_events`, e a regex seguia casando só o
 * nome da tabela. Medido na triagem do #897, com `title` acrescentado ao
 * `select` de `page.tsx` e de `agendamentos/route.ts`: **3 passed (3)**. O
 * controle de vacuidade também ficava verde, satisfeito pelo `.delete()` de
 * `google/desconectar/route.ts` — uma consulta que não seleciona nada. Por
 * isso a regex casa a tabela E a view, e o controle cobra uma leitura COM
 * `select` em cada caminho, não "alguma consulta em algum lugar".
 *
 * ⚠️ E O LUGAR DA LEITURA MUDOU — a mesma cegueira, uma TERCEIRA vez.
 *
 * O PR #915 (f8481845f, @webtecnica) tirou as duas consultas de dentro das
 * pastas de tela e as juntou num módulo só — `lib/agenda/ocupacao-externa.ts` —
 * para a semente e a rota pararem de divergir (issue #525). O recorte daqui
 * seguia sendo as duas PASTAS, então a varredura deixou de achar consulta
 * nenhuma, e o caso "nenhuma delas pede `title`" passou a ficar verde por
 * VACUIDADE — exatamente o desfecho que o controle existe para negar. Medido na
 * integração do lote 12 (778d1dcb2): `Tests 2 failed | 9 passed`, com o
 * controle acusando `["app/app/agenda", "app/api/v1/agenda"]` sem leitura.
 *
 * Antes de seguir a consulta, a pergunta na ordem certa — a privacidade
 * continua valendo no caminho novo? Continua, e por três medidas: o `select` do
 * módulo é `"id, starts_at, ends_at, calendar_connections!inner(user_id)"`;
 * `grep -c '\btitle\b' lib/agenda/ocupacao-externa.ts` devolve `0`; e o tipo
 * devolvido (`BlocoExternoDaTela`) não tem campo de título, com os dois
 * consumidores cravando `titulo: "Ocupado"`. A decisão não foi desfeita — ela
 * mudou de endereço, e o gate é que a seguiu.
 *
 * Se um dia a decisão mudar, o caminho é POR ORGANIZAÇÃO e com aviso de quem vê
 * — nunca por default. Quem for fazer isso troca este teste junto, de propósito:
 * é o passo que obriga a decisão a ser tomada por gente.
 */
const RAIZ = process.cwd();

/**
 * Onde a leitura da ocupação MORA hoje (PR #915). É o alvo principal do gate: o
 * controle de vacuidade cobra a consulta AQUI, para que mover a leitura de novo
 * reprove em vez de deixar a varredura medindo o vazio.
 */
const DONO_DA_LEITURA = path.join(RAIZ, "lib", "agenda", "ocupacao-externa.ts");

/**
 * Os caminhos por onde a ocupação do Google pode chegar à tela da Agenda.
 *
 * Os três são superfície de exposição por razões diferentes: o primeiro é o
 * módulo onde a consulta mora; o segundo é a semente que o servidor renderiza;
 * o terceiro é a rota que a substitui no primeiro refetch.
 *
 * As duas pastas de tela seguem varridas mesmo sem consulta própria desde o
 * #915: elas são onde uma consulta RE-INLINADA nasceria, e uma guarda de
 * privacidade não deve depender de outro gate estar verde para enxergar o que
 * aparecer ali. Que não exista uma terceira cópia em nenhum outro lugar de
 * `app/` ou `lib/agenda/` é o que `ocupacao-do-google-vem-de-um-lugar-so.test.ts`
 * mede, varrendo `git ls-files`.
 */
const CAMINHOS_ATE_A_TELA = [
  DONO_DA_LEITURA,
  path.join(RAIZ, "app", "app", "agenda"),
  path.join(RAIZ, "app", "api", "v1", "agenda"),
];

function arquivos(alvo: string): string[] {
  if (!fs.existsSync(alvo)) return [];
  // O alcance tem pasta E arquivo: desde o #915 a consulta mora num módulo só,
  // e apontar o recorte para o diretório inteiro de `lib/agenda/` traria uma
  // dúzia de arquivos que não têm nada com a travessia para a tela.
  if (fs.statSync(alvo).isFile()) return /\.tsx?$/.test(alvo) ? [alvo] : [];
  return fs.readdirSync(alvo, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(alvo, e.name);
    if (e.isDirectory()) return arquivos(p);
    return e.isFile() && /\.tsx?$/.test(p) ? [p] : [];
  });
}

/** Apaga o conteúdo de linhas que são só comentário, preservando as quebras. */
function semComentarios(fonte: string): string {
  return fonte
    .split("\n")
    .map((l) => (/^\s*(\/\/|\/\*|\*)/.test(l) ? "" : l))
    .join("\n");
}

/**
 * A tabela do espelho e a view de ocupação que a lê. As duas carregam — ou
 * carregaram — o `title`; a leitura da tela passa pela view.
 */
const RELACOES_DO_ESPELHO = /\.from\("calendar_(?:selected_)?external_events"\)([\s\S]*?);/g;

/**
 * As consultas à tabela do espelho e à view de ocupação feitas nos caminhos até
 * a tela da Agenda, com o caminho de origem e as colunas que cada uma pede
 * (vazio quando a cadeia não tem `.select`, como num `.delete()`).
 */
function consultasDeEventoExterno(): Array<{ caminho: string; onde: string; colunas: string | null }> {
  const out: Array<{ caminho: string; onde: string; colunas: string | null }> = [];
  for (const caminho of CAMINHOS_ATE_A_TELA) {
    for (const arquivo of arquivos(caminho)) {
      const fonte = semComentarios(fs.readFileSync(arquivo, "utf8"));
      const rel = path.relative(RAIZ, arquivo);
      for (const m of fonte.matchAll(RELACOES_DO_ESPELHO)) {
        const cadeia = m[1] ?? "";
        const sel = /\.select\(\s*"([^"]*)"/.exec(cadeia);
        out.push({
          caminho: path.relative(RAIZ, caminho),
          onde: `${rel}:${fonte.slice(0, m.index ?? 0).split("\n").length}`,
          colunas: sel?.[1] ?? null,
        });
      }
    }
  }
  return out;
}

describe("a ocupação do Google não leva o nome do evento para a tela", () => {
  it("o DONO da leitura lê os eventos externos com um select (senão o gate mede o vazio)", () => {
    // Controle do instrumento. Sem isto, mover a consulta, renomear o
    // diretório ou trocar a relação lida deixaria o gate verde por não medir
    // nada — e ele afirmaria o que não mediu, que é o pior desfecho para uma
    // guarda de privacidade. Uma consulta sem `select` (o `.delete()` da
    // desconexão) não conta: ela não tem coluna para vigiar.
    //
    // A cobrança é sobre o DONO, e não sobre cada caminho: desde o #915 as duas
    // pastas de tela legitimamente não têm consulta própria — quem reprova
    // quem puser uma de volta lá é `ocupacao-do-google-vem-de-um-lugar-so`.
    // Exigir leitura em CADA caminho transformaria a doutrina de leitura única
    // num vermelho permanente aqui.
    const leituras = consultasDeEventoExterno().filter((c) => c.colunas !== null);
    const dono = path.relative(RAIZ, DONO_DA_LEITURA);
    expect(
      leituras.filter((l) => l.caminho === dono).length,
      `nenhuma leitura de \`calendar_external_events\` ou \`calendar_selected_external_events\` ` +
        `com \`select\` em ${dono} — ou a ocupação deixou de ser buscada, ou ela mudou de ` +
        `relação ou de lugar e este gate ficou cego. A varredura inteira achou: ` +
        JSON.stringify(leituras.map((l) => l.onde)),
    ).toBeGreaterThan(0);
  });

  it("nenhuma delas pede a coluna `title`", () => {
    const comTitulo = consultasDeEventoExterno()
      .filter((c) => c.colunas !== null && /\btitle\b/.test(c.colunas))
      .map((c) => `${c.onde} → select("${c.colunas}")`);

    expect(
      comTitulo,
      "A tela da Agenda passou a pedir o `title` do evento externo. A agenda conectada é " +
        "PESSOAL de quem atende e esta tela é multi-tenant, vista por gestor: o nome de um " +
        "compromisso particular — 'consulta médica', 'terapia', 'entrevista' — apareceria " +
        "para o chefe. A coluna existe e guarda nome de sincronizações antigas; o que não pode é ela atravessar " +
        "para cá. Se a decisão mudou, ela é POR ORGANIZAÇÃO e com aviso de quem vê, e este " +
        "teste muda junto — de propósito, para a decisão ser tomada por gente.",
    ).toEqual([]);
  });

  it("a sonda enxerga o `title` quando ele aparece — controle positivo", () => {
    // Sem este caso, um regex quebrado devolveria lista vazia para sempre e o
    // gate diria "nenhuma expõe" sem ter olhado. É o modo de falha que uma
    // guarda de ausência esconde melhor.
    const padrao = /\btitle\b/;
    expect(padrao.test("id, starts_at, ends_at, status")).toBe(false);
    expect(padrao.test("id, title, starts_at")).toBe(true);
    // E a relação: a leitura da tela passa pela VIEW. Uma regex que casasse só
    // a tabela devolveria vazio para as duas leituras reais.
    for (const relacao of ["calendar_external_events", "calendar_selected_external_events"]) {
      expect([...`.from("${relacao}").select("id");`.matchAll(RELACOES_DO_ESPELHO)]).toHaveLength(1);
    }
  });
});
