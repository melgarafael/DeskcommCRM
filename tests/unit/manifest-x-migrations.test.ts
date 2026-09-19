/**
 * O MANIFEST E OS ARQUIVOS DE MIGRATION CONTAM A MESMA HISTÓRIA.
 *
 * A doutrina do repo diz que toda mudança de schema sai em TRÊS artefatos:
 * migration versionada, apêndice no `baseline.sql` e linha no MANIFEST. Os dois
 * primeiros são código e quebram alto quando divergem. O terceiro é texto — e
 * texto não tem catraca nenhuma.
 *
 * ## O defeito que fez este arquivo existir
 *
 * No merge do épico IA 360 (PR #145, `d8acbfa6`), migrations de quatro waves
 * paralelas colidiram em numeração e foram renumeradas. A minha
 * `0101_catalogo_de_modelos_atualizado` virou `0104_...` — e a linha ANTIGA
 * ficou no MANIFEST. Resultado: `main` afirmava, no mesmo timestamp, que a
 * migration era `0101` e `0104`, e o `0101` real era de outra wave
 * (`0101_autoria_da_configuracao`).
 *
 * Nada acusou. `typecheck`, `lint`, `test:unit` e `test:db` passaram todos —
 * porque o MANIFEST é markdown, e markdown errado compila. Quem fosse ler o
 * registro do schema para entender a ordem via um número que não existe.
 *
 * ## O que se guarda aqui
 *
 * Os dois sentidos, porque só um deles pegaria metade dos casos:
 *   - linha do MANIFEST sem arquivo ⇒ registro fantasma (o defeito acima);
 *   - arquivo sem linha no MANIFEST ⇒ mudança de schema que ninguém registrou.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const DIR = join(process.cwd(), "supabase", "migrations");
const MANIFEST = join(DIR, "MANIFEST.md");

/**
 * A chave é o `NNNN_slug`, não o timestamp.
 *
 * A primeira versão desta catraca casava `| \`<timestamp>\` | \`<nome>\` |` e
 * acusou duas migrations legítimas: o MANIFEST tem linhas históricas sem
 * timestamp (`| *(wave 5)* | \`0013_ai_faq_items\` |`), de quando a versão não
 * era registrada. Prender o formato do timestamp mediria a FORMATAÇÃO da tabela;
 * o que importa é se a migration está registrada.
 */
const LINHA = /^\| [^|]+ \| `(\d{4,5}_[a-z0-9_]+)`/;

/**
 * As duas divergências que já existiam antes desta catraca, cada uma com o
 * motivo apurado. Estão aqui DECLARADAS em vez de consertadas no escuro:
 * inventar um arquivo ou apagar um registro histórico seria reescrever o que
 * aconteceu para o teste ficar verde.
 *
 * O segundo caso de teste cobra que esta lista não envelheça — resolvido e
 * esquecido aqui, ele acusa.
 */
const DIVERGENCIAS_CONHECIDAS = {
  /** Registrada no MANIFEST, aplicada via MCP na época, e NUNCA existiu como
   *  arquivo. O efeito está no `baseline.sql` (que é o que o self-host aplica),
   *  então o clone recebe a mudança; quem replicasse só `migrations/` em ordem,
   *  não. */
  semArquivo: ["0016_lgpd_emergency_scope"],
  /** O arquivo de bootstrap, anterior à tabela "Applied". */
  semLinha: ["00001_initial_schema"],
} as const;

/**
 * Os quatro pares que já nasciam repetidos foram DESFEITOS (issue #143), então
 * esta lista está vazia — e é para continuar assim.
 *
 * A versão anterior desta catraca os declarava com a razão "renomear migration
 * aplicada é reescrever história". A razão estava errada por um fato que não
 * tinha sido medido: o Supabase CLI usa o timestamp como PK de
 * `supabase_migrations.schema_migrations`, então esses pares nunca chegaram a
 * ficar registrados nos dois — `db push` colide na PK no segundo arquivo e
 * `db reset` quebra. Não havia história a preservar; havia história que o CLI
 * nunca conseguiu escrever, e todo fork esbarrava nela a cada merge.
 *
 * O que se preservou de fato: o CONTEÚDO (renomeamos só o prefixo) e a ORDEM
 * (o CLI ordena alfabeticamente, e +1s mantém cada arquivo depois do irmão).
 */
const TIMESTAMPS_REPETIDOS_CONHECIDOS: readonly string[] = [];

/** Só os arquivos que carregam timestamp no nome — as legadas não têm. */
function arquivosComTimestamp(): { timestamp: string; arquivo: string }[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((arquivo) => ({ timestamp: /^(\d{14})_/.exec(arquivo)?.[1] ?? "", arquivo }))
    .filter((m) => m.timestamp !== "");
}

function nomesDoManifest(): string[] {
  return readFileSync(MANIFEST, "utf8")
    .split("\n")
    .map((l) => LINHA.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1]!);
}

/** `20260805120000_0104_slug.sql` → `0104_slug`. */
function nomesDeMigration(): string[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.slice(0, -4))
    .map((f) => (/^\d{14}_/.test(f) ? f.slice(15) : f));
}


/** Só linhas do MANIFEST com timestamp de 14 dígitos — as históricas `*(wave N)*` ficam de fora. */
function timestampsDoManifest(): { timestamp: string; nome: string }[] {
  const LINHA_TS = /^\| `(\d{14})` \| `(\d{4,5}_[a-z0-9_]+)`/;
  return readFileSync(MANIFEST, "utf8")
    .split("\n")
    .map((l) => LINHA_TS.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ timestamp: m[1]!, nome: m[2]! }));
}

describe("MANIFEST × arquivos de migration", () => {
  it("o MANIFEST não vem vazio (guarda de vacuidade)", () => {
    // Sem isto, um MANIFEST ilegível (formato mudou, arquivo movido) faria as
    // asserções abaixo passarem por ausência de dado — o instrumento cego
    // devolvendo verde.
    expect(nomesDoManifest().length).toBeGreaterThan(50);
  });

  it("toda linha do MANIFEST aponta para um arquivo que existe", () => {
    const arquivos = new Set(nomesDeMigration());
    const orfas = nomesDoManifest()
      .filter((chave) => !arquivos.has(chave))
      .filter((chave) => !DIVERGENCIAS_CONHECIDAS.semArquivo.includes(chave as never));
    expect(
      orfas,
      "linha de MANIFEST sem arquivo — foi renumeração de merge que deixou a antiga para trás?",
    ).toEqual([]);
  });

  it("toda migration tem linha no MANIFEST", () => {
    const registrados = new Set(nomesDoManifest());
    const semRegistro = nomesDeMigration()
      .filter((f) => !registrados.has(f))
      .filter((f) => !DIVERGENCIAS_CONHECIDAS.semLinha.includes(f as never));
    expect(
      semRegistro,
      "mudança de schema sem linha no MANIFEST — a tripla da doutrina ficou incompleta",
    ).toEqual([]);
  });

  it("nenhum número de migration é usado duas vezes", () => {
    // Quatro waves em paralelo colidem em numeração; o merge renumera. Se duas
    // sobreviverem com o mesmo número, a ordem de aplicação vira loteria.
    const porNumero = new Map<string, string[]>();
    for (const f of nomesDeMigration()) {
      const num = /^(\d{4})_/.exec(f)?.[1];
      if (!num) continue;
      porNumero.set(num, [...(porNumero.get(num) ?? []), f]);
    }
    const duplicados = [...porNumero.entries()]
      .filter(([, fs]) => fs.length > 1)
      .map(([num, fs]) => `${num}: ${fs.join(", ")}`);
    // A exceção da 0068 saiu daqui em 2026-08-06: a colisão foi CONSERTADA
    // (`0068_ai_pricing_backfill` → `0110_...`), não perdoada. Sem exceção nenhuma
    // agora — número repetido reprova, ponto. Se voltar a aparecer dívida aqui, o
    // caminho é renumerar como se fez, não readicionar filtro: o timestamp é a
    // identidade que o Supabase usa, então renumerar o NNNN é barato e não
    // re-aplica nada em quem já rodou.
    expect(duplicados).toEqual([]);
  });

  // Regra SEPARADA da de número, e não um detalhe dela: número repetido quebra a
  // IDENTIDADE da migration; timestamp repetido quebra a ORDEM de aplicação, que é
  // quem decide qual DDL roda antes num banco novo. Sintomas diferentes ⇒ casos e
  // sabotagens diferentes, senão um passa de carona no vermelho do outro e não se
  // sabe qual dos dois está de fato vigiado.
  it("nenhum timestamp é usado duas vezes", () => {
    const porTimestamp = new Map<string, string[]>();
    for (const { timestamp, arquivo } of arquivosComTimestamp()) {
      porTimestamp.set(timestamp, [...(porTimestamp.get(timestamp) ?? []), arquivo]);
    }
    const duplicados = [...porTimestamp.entries()]
      .filter(([ts, fs]) => fs.length > 1 && !TIMESTAMPS_REPETIDOS_CONHECIDOS.includes(ts))
      .map(([ts, fs]) => `${ts}: ${fs.join(", ")}`);
    expect(
      duplicados,
      "duas migrations com o mesmo timestamp — a ordem de aplicação vira desempate do runner",
    ).toEqual([]);
  });


  // Timestamp na coluna 1 é a PK de schema_migrations no CLI. Casar só por
  // NNNN_slug (acima) deixa a coluna mentir em silêncio — issue #1264: MANIFEST
  // dizia 20260911160000 e o arquivo era 20260911170000_0238_…. Linhas
  // históricas sem timestamp (`*(wave N)*`) ficam de fora de propósito.
  it("quando a linha do MANIFEST tem timestamp, ele bate com o do arquivo", () => {
    const porNome = new Map(
      arquivosComTimestamp().map(({ timestamp, arquivo }) => {
        const nome = arquivo.replace(/\.sql$/, "").replace(/^\d{14}_/, "");
        return [nome, timestamp] as const;
      }),
    );
    const divergentes = timestampsDoManifest()
      .filter(({ nome, timestamp }) => {
        const noArquivo = porNome.get(nome);
        return noArquivo !== undefined && noArquivo !== timestamp;
      })
      .map(
        ({ nome, timestamp }) =>
          `${nome}: MANIFEST=${timestamp} arquivo=${porNome.get(nome)}`,
      );
    expect(
      divergentes,
      "timestamp do MANIFEST diverge do nome do arquivo — a coluna que o CLI usa como PK mentiu",
    ).toEqual([]);
  });

  it("as divergências declaradas continuam existindo (a lista não pode envelhecer)", () => {
    // Deixar um nome aqui depois de resolvido mentiria para a próxima pessoa —
    // ela leria "isto é conhecido e aceito" sobre algo que já foi consertado.
    const arquivos = new Set(nomesDeMigration());
    const registrados = new Set(nomesDoManifest());

    const jaTemArquivo = DIVERGENCIAS_CONHECIDAS.semArquivo.filter((c) => arquivos.has(c));
    expect(jaTemArquivo, "saiu da dívida: remova de DIVERGENCIAS_CONHECIDAS.semArquivo").toEqual([]);

    const jaTemLinha = DIVERGENCIAS_CONHECIDAS.semLinha.filter((c) => registrados.has(c));
    expect(jaTemLinha, "saiu da dívida: remova de DIVERGENCIAS_CONHECIDAS.semLinha").toEqual([]);

    const comTimestamp = arquivosComTimestamp();
    const jaResolvidos = TIMESTAMPS_REPETIDOS_CONHECIDOS.filter(
      (ts) => comTimestamp.filter((m) => m.timestamp === ts).length < 2,
    );
    expect(
      jaResolvidos,
      "saiu da dívida: remova de TIMESTAMPS_REPETIDOS_CONHECIDOS",
    ).toEqual([]);
  });
});
