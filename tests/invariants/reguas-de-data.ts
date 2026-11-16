/**
 * AS RÉGUAS DE DATA DO REPOSITÓRIO — a LISTA ÚNICA (#3849).
 *
 * ─── Por que uma lista, e não um arquivo de teste ────────────────────────────
 *
 * A classe do `Date` × `string` não é um defeito: é uma FRONTEIRA. O driver `pg`
 * entrega `timestamptz` como `Date` (parser do OID 1184, que o repositório não
 * troca); o PostgREST, o `jsonb` escrito por `JSON.stringify` e o payload de uma
 * API externa entregam a mesma coluna como string. Toda régua que lê data de
 * armazenamento e decide algo — "a mídia está pendente?", "esse prazo é hoje?",
 * "esse atendente está presente?" — vive nessa fronteira, e a régua que só
 * aceita `string` fica INERTE em produção sem nenhum teste vermelho, porque o
 * dublê dos testes de unidade devolve string.
 *
 * A varredura do #3849 achou um caso real por transporte (`pg`) e um segundo por
 * escrita faltando (`falasDoSnapshot`). Nenhum outro: as outras réguas já
 * normalizam na borda. O que faltava não era conserto — era o mecanismo que
 * impede a próxima de nascer fora do teste. É esta lista.
 *
 * ─── O contrato ─────────────────────────────────────────────────────────────
 *
 * Cada entrada recebe o valor CRU que o banco entregou (`unknown`, de
 * propósito: é assim que a régua o recebe em produção, de uma linha tipada por
 * fé) e responde se a régua VIU aquele instante. `exercitar` compara o EPOCH, e
 * não o texto: é o que pega o deslocamento de fuso que `toISOString` sobre um
 * valor já convertido produz, e é o único jeito de comparar réguas que devolvem
 * formatos diferentes (ISO, `Date`, dia civil, booleano).
 *
 * Régua nova que decida data lida de armazenamento entra AQUI, no mesmo PR, e o
 * invariante `reguas-de-data-veem-o-date-do-driver.test.ts` passa a exercitá-la
 * contra Postgres real. A catraca da lista (`sitiosQueRamoamPorDate`, abaixo)
 * reprova o PR que esquecer: arquivo de produção que ramifica por
 * `x instanceof Date` — a marca de quem trata os dois transportes — tem de
 * estar aqui ou em {@link FORA_DA_LISTA} com o motivo medido.
 *
 * ⚠️ O que esta lista NÃO cobre, declarado para não parecer mais do que é:
 *
 *   · régua que recusa `Date` sem ramificar por tipo (`new Date(String(v))`,
 *     comparação de texto);
 *   · régua que recebe a data já normalizada na consulta (`x::text`,
 *     `to_char(x`) — nesse caminho o valor É string por construção, e exigir
 *     `Date` dela seria inventar defeito;
 *   · régua que lê da view/função que não exponha coluna de data no baseline.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

import ts from "typescript";
import type pg from "pg";

import { precisaRenovar } from "@/lib/agenda/google/oauth";
import { falasDoSnapshot } from "@/lib/agent-engine/agent/conversa-do-caso/leitura";
import { midiaDerivavelPendente } from "@/lib/agent-engine/edge/crm/midia-derivavel";
import { normalizarInstante } from "@/lib/ai/elegibilidade/gate";
import { estaPresente } from "@/lib/atendimento/presenca";
import { acaoDaAgenda } from "@/lib/channels/agenda-de-pausa";
import { serializarValor } from "@/lib/external-db/montagem";
import { diaDoValor } from "@/lib/followup/condicao-por-data";
import { camposAlterados } from "@/lib/leads/campos-alterados";
import { diaDoPrazo } from "@/lib/lgpd/sla";
import { instanteDoBanco } from "@/lib/tempo/agora";

/**
 * O instante de referência, com MILISSEGUNDO de propósito: é o pedaço que
 * `Date.parse` sobre um `Date` perde quando alguém converte com `String(v)` em
 * vez de normalizar (`"...123Z"` → `"...123Z (BRT)"` → `NaN`). Um valor redondo
 * esconderia metade da classe.
 */
export const CHEGADA = "2026-11-04T09:10:00.123Z";
export const CHEGADA_MS = Date.parse(CHEGADA);

/** O MESMO instante na forma do cliente REST (PostgREST/jsonb): string ISO. */
export const CHEGADA_TEXTO = new Date(CHEGADA_MS).toISOString();

/** Um instante diferente, para a régua que cai num padrão quando não vê nada. */
export const OUTRO_INSTANTE = "2026-11-04T12:00:00.000Z";

/**
 * Os ids do caso que as réguas de CONSULTA leem. Exportados daqui para o
 * fixture do invariante e a régua não divergirem — literal duplicado é a
 * divergência que este repositório já pagou caro.
 */
export const IDS_DO_CASO = {
  organizacao: "ee390000-0000-4000-8000-000000000101",
  contato: "ee390000-0000-4000-8000-000000000102",
  sessao: "ee390000-0000-4000-8000-000000000103",
  conversa: "ee390000-0000-4000-8000-000000000104",
} as const;

/** Como a régua recebe o instante. */
export type EntradaDaRegua =
  /** Recebe o valor já lido — a borda de leitura propriamente dita. */
  | "valor"
  /** Lê do banco por conta própria (o valor cru é o que a consulta devolve). */
  | "consulta";

export interface ReguaDeData {
  /** Nome da função exportada — é a chave que o invariante cita no RED. */
  nome: string;
  /** `arquivo:linha` da declaração. O invariante confere que ainda existe ali. */
  onde: string;
  entrada: EntradaDaRegua;
  /**
   * `true` quando a régua VIU o instante (comparação por epoch, nunca por
   * texto). `false` quando recusou, caiu no padrão ou devolveu instante ilegível.
   */
  exercitar: (valorCru: unknown) => boolean | Promise<boolean>;
}

const mesmoInstante = (texto: string | null): boolean =>
  texto !== null && Date.parse(texto) === CHEGADA_MS;

/**
 * A LISTA. Onze réguas, na ordem em que a varredura as encontrou.
 *
 * A lista é curta porque é um CONTRATO: cada linha custa a prova de que a régua
 * aceita as duas formas e de que não desloca o instante.
 */
export function reguasDeData(pool: pg.Pool): ReguaDeData[] {
  return [
    {
      nome: "midiaDerivavelPendente",
      onde: "lib/agent-engine/edge/crm/midia-derivavel.ts:102",
      // O caso de origem (#3846): a régua consulta a conversa e devolve a mídia
      // pendente com a hora de chegada. Contra `pg` ela recebia `Date` e
      // respondia "nada pendente" — a espera nunca acontecia.
      entrada: "consulta",
      exercitar: async () => {
        const pendente = await midiaDerivavelPendente(pool, {
          organizationId: IDS_DO_CASO.organizacao,
          conversationId: IDS_DO_CASO.conversa,
        });
        return pendente !== null && mesmoInstante(pendente.quando);
      },
    },
    {
      nome: "instanteDoBanco",
      onde: "lib/tempo/agora.ts:171",
      // A borda canônica: `Date` (pg) e string (PostgREST/jsonb) viram o MESMO
      // ISO 8601. É o normalizador que a mensagem de erro do RED recomenda.
      entrada: "valor",
      exercitar: (valorCru) => mesmoInstante(instanteDoBanco(valorCru)),
    },
    {
      nome: "falasDoSnapshot",
      onde: "lib/agent-engine/agent/conversa-do-caso/leitura.ts:199",
      // O segundo caso real (#3849): as falas congeladas no `context_snapshot`
      // caíam TODAS na hora de abertura quando o carimbo não era legível.
      // `abertoEm` é um instante DIFERENTE do de chegada: ver a hora da abertura
      // não conta como ter visto a fala.
      entrada: "valor",
      exercitar: (valorCru) => {
        const falas = falasDoSnapshot(
          { last_messages: [{ direction: "inbound", body: "oi", sent_at: valorCru }] },
          OUTRO_INSTANTE,
        );
        return falas.length === 1 && mesmoInstante(falas[0]!.quando);
      },
    },
    {
      nome: "normalizarInstante",
      onde: "lib/ai/elegibilidade/gate.ts:238",
      // O normalizador compartilhado dos DOIS transportes do gate de
      // elegibilidade (`Date` | string | number | `'infinity'`).
      entrada: "valor",
      exercitar: (valorCru) => {
        const r = normalizarInstante(valorCru as Date | string | number | null | undefined);
        return r instanceof Date && r.getTime() === CHEGADA_MS;
      },
    },
    {
      nome: "diaDoValor",
      onde: "lib/followup/condicao-por-data.ts:62",
      // Condição por data relativa ("o período de teste terminou?"): a régua
      // compara DIA DE CALENDÁRIO. Recusar o `Date` do driver faria o fluxo
      // nunca disparar — ou disparar sempre, se a regra fosse negativa.
      entrada: "valor",
      exercitar: (valorCru) => {
        const dia = diaDoValor(valorCru);
        return dia !== null && dia.ano === 2026 && dia.mes === 11 && dia.dia === 4;
      },
    },
    {
      nome: "estaPresente",
      onde: "lib/atendimento/presenca.ts:84",
      // `users.last_heartbeat_at` (timestamptz). Recusar o `Date` marcaria todo
      // atendente como ausente — e a presença decide para quem o turno roteia.
      entrada: "valor",
      exercitar: (valorCru) =>
        estaPresente(valorCru as string | Date | null | undefined, new Date(CHEGADA_MS + 60_000)),
    },
    {
      nome: "acaoDaAgenda",
      onde: "lib/channels/agenda-de-pausa.ts:70",
      // A janela de manutenção do canal. ⚠️ O TIPO de `AgendaDePausa` declara
      // `starts_at: string` e o runtime aceita `Date` (`instanteDe`) — é o
      // inverso do defeito da classe: o tipo mente para baixo. O `as` abaixo é
      // a declaração dessa lacuna, não um contorno do teste.
      entrada: "valor",
      exercitar: (valorCru) =>
        acaoDaAgenda(
          {
            starts_at: valorCru as string,
            ends_at: "2026-11-04T10:10:00.123Z",
            status: "scheduled",
          },
          new Date(CHEGADA_MS - 3_600_000),
        ) === "aguardando",
    },
    {
      nome: "serializarValor",
      onde: "lib/external-db/montagem.ts:189",
      // A leitura de banco EXTERNO: `bytea`/`bigint`/`Date` de outro motor viram
      // JSON. É o caminho em que o `Date` do driver mais aparece — e o que
      // alimenta a grade que o operador lê.
      entrada: "valor",
      exercitar: (valorCru) => mesmoInstante(serializarValor(valorCru, "0x") as string | null),
    },
    {
      nome: "diaDoPrazo",
      onde: "lib/lgpd/sla.ts:117",
      // `due_at` (o dia civil do prazo de LGPD). O comentário da própria função
      // registra por que não se passa esse instante por formatador com fuso.
      entrada: "valor",
      exercitar: (valorCru) => diaDoPrazo(valorCru as string | Date | null | undefined) === "2026-11-04",
    },
    {
      nome: "camposAlterados",
      onde: "lib/leads/campos-alterados.ts:56",
      // Igualdade de campo de negócio entre o patch do formulário (string) e a
      // linha do banco (`Date` em pg): recusar o `Date` marcaria alteração em
      // TODO salvamento e a timeline acusaria quem não mexeu.
      entrada: "valor",
      exercitar: (valorCru) =>
        camposAlterados({ due_date: valorCru }, { due_date: new Date(CHEGADA_MS) }).length === 0,
    },
    {
      nome: "precisaRenovar",
      onde: "lib/agenda/google/oauth.ts:338",
      // Validade do token do Google (`expires_at`, timestamptz). Recusar o
      // `Date` devolveria "precisa renovar" sempre (a função responde `true`
      // para validade ilegível) — renovação a cada requisição.
      entrada: "valor",
      exercitar: (valorCru) =>
        precisaRenovar(
          valorCru as string | Date | null | undefined,
          new Date(CHEGADA_MS - 3_600_000),
          5 * 60_000,
        ) === false,
    },
  ];
}

/**
 * Os arquivos de produção que ramificam por `x instanceof Date` e NÃO estão na
 * lista, cada um com o motivo medido.
 *
 * A escolha do marcador não é estética: `instanceof Date` é a assinatura de quem
 * trata os DOIS transportes. Quem trata só string cai na catraca irmã
 * (`tests/unit/data-do-banco-nao-vira-texto.test.ts`, forma `typeof`/`Date.parse`),
 * e as duas juntas fecham a fronteira por dois lados.
 *
 * A lista cobra nos DOIS sentidos: arquivo novo que ramifique por `Date` sem
 * entrada aqui nem na lista principal REPROVA; entrada cujo arquivo deixou de
 * ramificar REPROVA com "dívida paga" — senão a isenção vira cemitério.
 */
export const FORA_DA_LISTA: readonly { arquivo: string; motivo: string }[] = [
  {
    arquivo: "lib/agent-engine/agent/inbound-turn.ts",
    motivo:
      "é a ESCRITA do snapshot do caso (`sent_at instanceof Date ? toISOString : String`), não uma régua de leitura; quem decide a hora na leitura é `falasDoSnapshot`, coberto",
  },
  {
    arquivo: "lib/agent-engine/edge/crm/session-watchdog.ts",
    motivo:
      "o `instanceof Date` ali é a régua do `'infinity'` do `run_after` (`Date | 'infinity'`), não teste de transporte: um número é recusado de propósito",
  },
  {
    arquivo: "lib/auth/politica-mfa.ts",
    motivo:
      "`dataValida` é helper PRIVADO sobre `organizations.settings` (jsonb escrito pelo app): o valor é string por construção e o `Date` é defensivo — a borda pública não recebe `unknown`",
  },
  {
    arquivo: "lib/escalacao/atendimento-manual.ts",
    motivo:
      "consome `normalizarInstante` (lib/ai/elegibilidade/gate.ts, na lista) e só desembrulha o `Date` que ele devolve; não lê data crua",
  },
  {
    arquivo: "lib/followup/retorno-pg.ts",
    motivo:
      "helper privado `iso` do adaptador `pg` do retorno: normaliza na leitura da linha para o contrato string de `RetornoAgendado`, exercitado pelos testes do motor de follow-up",
  },
  {
    arquivo: "lib/followup/turn-bridge.ts",
    motivo:
      "helper privado `toIso` do adaptador `pg` do turno: mesma normalização de borda do irmão acima, para o contrato string de `EnrollmentRow`",
  },
  {
    arquivo: "scripts/demandas-derivadas-de-arquivada.leitura.ts",
    motivo:
      "leitor de PLANILHA (CSV de importação), não de banco: o valor chega string e o `Date` é defensivo para quem chamar com uma célula já convertida",
  },
];

/** Onde mora código de produção. `tests/` fica de fora: lá a string é o dado. */
const DIRETORIOS = ["lib", "app", "workers", "scripts", "hooks", "components"];

export interface SitioComDate {
  arquivo: string;
  /** Linhas com `x instanceof Date`, na fonte — comentário não é nó de AST. */
  linhas: number[];
}

function arquivosDeCodigo(dir: string, raiz: string): string[] {
  const saida: string[] = [];
  for (const entrada of readdirSync(join(raiz, dir), { withFileTypes: true })) {
    const caminho = join(dir, entrada.name);
    if (entrada.isDirectory()) {
      if (entrada.name === "node_modules") continue;
      saida.push(...arquivosDeCodigo(caminho, raiz));
      continue;
    }
    if (!/\.tsx?$/.test(entrada.name)) continue;
    if (entrada.name.endsWith(".test.ts") || entrada.name.endsWith(".test.tsx")) continue;
    if (entrada.name.endsWith(".d.ts")) continue;
    saida.push(caminho);
  }
  return saida;
}

/**
 * As linhas em que `fonte` ramifica por `x instanceof Date`.
 *
 * Por AST, e não por texto: o #3959 mediu que uma varredura textual conta o
 * PRÓPRIO comentário ("a versão antiga fazia `quando instanceof Date`") e isenta
 * a decisão viva. Comentário não é nó — não há como contar.
 */
export function linhasQueRamoamPorDate(fonte: string): number[] {
  const sf = ts.createSourceFile("regua.ts", fonte, ts.ScriptTarget.ES2022, true);
  const linhas: number[] = [];
  const visitar = (no: ts.Node): void => {
    if (
      ts.isBinaryExpression(no) &&
      no.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
      ts.isIdentifier(no.right) &&
      no.right.text === "Date"
    ) {
      linhas.push(sf.getLineAndCharacterOfPosition(no.getStart(sf)).line + 1);
    }
    ts.forEachChild(no, visitar);
  };
  visitar(sf);
  return linhas;
}

/** Varre a árvore de produção atrás dos arquivos que tratam os dois transportes. */
export function sitiosQueRamoamPorDate(raiz: string = process.cwd()): SitioComDate[] {
  const achados: SitioComDate[] = [];
  for (const dir of DIRETORIOS) {
    let caminhos: string[];
    try {
      caminhos = arquivosDeCodigo(dir, raiz);
    } catch {
      // Diretório que não existe nesta árvore (ex.: `components` em repo
      // só-servidor) não é ausência de régua.
      continue;
    }
    for (const caminho of caminhos) {
      const linhas = linhasQueRamoamPorDate(readFileSync(join(raiz, caminho), "utf8"));
      if (linhas.length === 0) continue;
      achados.push({ arquivo: caminho.split(sep).join("/"), linhas });
    }
  }
  return achados;
}
