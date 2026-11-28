import { describe, expect, it } from "vitest";

import {
  type ArquivoDaAbordagemNoBucket,
  type ClienteDeStorageDaAbordagem,
  drenarArquivosOrfaosDaAbordagem,
  type FonteDaProspeccao,
  pastaDosArquivosDaAbordagem,
  TETO_DE_CAMINHOS_NA_TRILHA,
} from "@/lib/prospecting/arquivos-orfaos-da-abordagem";

/**
 * O TETO DA TRILHA DA VARREDURA — issue #5331, item 2.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * A limpeza dos arquivos órfãos da abordagem (#5139) devolve
 * `caminhos_removidos` com UM item por arquivo que o Storage confirmou ter
 * removido, e o cron de retenção copiava essa lista inteira para o metadata do
 * `retention.sweep_run`. Na primeira rodada de uma instalação que acumulou
 * arquivos — anos de trocas de vídeo de abordagem — isso virava MILHARES de
 * caminhos numa ÚNICA linha de `api_audit_log`: o metadata ia para TOAST, a
 * linha deixava de ser auditoria e virava inventário, e a tela de auditoria
 * (que abre o metadata inteiro) ficava impraticável.
 *
 * ─── O que este invariante prova ────────────────────────────────────────────
 *
 * Que a trilha é AMOSTRA DECLARADA, e não lista truncada em silêncio: o
 * tamanho nunca passa de `TETO_DE_CAMINHOS_NA_TRILHA`, o total real continua
 * em `removidos`, e o que ficou de fora está contado em `caminhos_omitidos`.
 * As três asserções juntas são a conta fechada — sem a terceira, uma trilha de
 * 50 itens poderia significar 50 remoções ou 50 mil.
 *
 * Sem teto (o código de antes), a primeira asserção reprova em toda rodada com
 * mais de `TETO_DE_CAMINHOS_NA_TRILHA` arquivos: é a sabotagem que dá sentido ao
 * arquivo.
 *
 * Módulo puro: Storage falso, nenhuma rede, nenhum banco. Por isso vive em
 * `tests/unit` e roda no `pnpm test:unit` de todo PR — `tests/invariants/**` é a
 * suíte de SQL contra o Postgres efêmero, e o que se prova aqui não é SQL.
 */

const AGORA = new Date("2026-11-28T12:00:00.000Z");

function orgNumero(n: number): string {
  return `${String(n).repeat(8)}-1111-1111-1111-111111111111`;
}

/** O caminho como o adaptador do Supabase o devolve: completo, com a pasta. */
function caminhoDaOrg(org: string, i: number): string {
  return `${org}/prospecting/${String(i).padStart(6, "0")}-0f3a-4b1c-9d2e-000000000000.mp4`;
}

/** Um objeto do bucket já velho o bastante para sair (fora dos 7 dias). */
function orfaoVelho(org: string, i: number): ArquivoDaAbordagemNoBucket {
  const criadoEm = new Date(AGORA.getTime() - 30 * 86_400_000);
  return { caminho: caminhoDaOrg(org, i), bytes: 1_000, criadoEm, atualizadoEm: criadoEm };
}

/**
 * Storage falso que lista o que tem e confirma a remoção de tudo o que foi
 * pedido — o comportamento do adaptador, sem rede.
 */
function storageComObjetos(objetos: ArquivoDaAbordagemNoBucket[]): ClienteDeStorageDaAbordagem {
  const vivos = new Map(objetos.map((o) => [o.caminho, o]));
  return {
    async list(prefixo) {
      // Só o que está na pasta desta organização, como o `list` de verdade.
      const daPasta = [...vivos.keys()].filter((c) => c.startsWith(`${prefixo}/`));
      return { arquivos: daPasta.map((c) => vivos.get(c)!), erro: null };
    },
    async remove(caminhos) {
      const confirmados: string[] = [];
      for (const caminho of caminhos) {
        if (vivos.delete(caminho)) confirmados.push(caminho);
      }
      return { removidos: confirmados, erro: null };
    },
  };
}

/** Uma instalação de `organizacoes` organizações, cada uma com `porOrg` órfãos. */
function instalacao(organizacoes: number, porOrg: number): FonteDaProspeccao {
  const orgs = Array.from({ length: organizacoes }, (_, i) => orgNumero(i + 1));
  const storages = new Map(
    orgs.map((org) => [
      org,
      storageComObjetos(Array.from({ length: porOrg }, (_, i) => orfaoVelho(org, i))),
    ]),
  );
  return {
    async organizacoes() {
      return orgs;
    },
    async caminhosReferenciados() {
      // Nenhuma campanha referencia nada: todo arquivo é órfão.
      return [];
    },
    storageDaAbordagem(org) {
      return storages.get(org)!;
    },
  };
}

describe("a trilha do retention.sweep_run não passa do teto (#5331)", () => {
  it("uma rodada com milhares de órfãos leva no máximo o teto — e conta o que ficou de fora", async () => {
    const fonte = instalacao(3, 400); // 1.200 removidos numa rodada só

    const r = await drenarArquivosOrfaosDaAbordagem(fonte, { agora: AGORA });

    // O TOTAL continua sendo o real: o teto é da trilha, não da poda.
    expect(r.removidos).toBe(1_200);
    // A trilha é amostra declarada, do tamanho do teto.
    expect(r.caminhos).toHaveLength(TETO_DE_CAMINHOS_NA_TRILHA);
    expect(r.caminhos.length).toBeLessThanOrEqual(TETO_DE_CAMINHOS_NA_TRILHA);
    // Nada some em silêncio: removidos = trilha + omitidos.
    expect(r.caminhos_omitidos).toBe(1_200 - TETO_DE_CAMINHOS_NA_TRILHA);
    expect(r.caminhos.length + r.caminhos_omitidos).toBe(r.removidos);
    // E a amostra é a PRIMEIRA leva, na ordem das organizações — quem investiga
    // lê o começo da poda, não um pedaço arbitrário do meio.
    const primeiraOrg = orgNumero(1);
    expect(r.caminhos[0]!.caminho).toBe(caminhoDaOrg(primeiraOrg, 0));
  });

  it("uma organização sozinha já acima do teto não transborda a trilha", async () => {
    const fonte = instalacao(1, 900);
    const org = orgNumero(1);

    const r = await drenarArquivosOrfaosDaAbordagem(fonte, { agora: AGORA });

    expect(r.removidos).toBe(900);
    expect(r.caminhos).toHaveLength(TETO_DE_CAMINHOS_NA_TRILHA);
    expect(r.caminhos_omitidos).toBe(900 - TETO_DE_CAMINHOS_NA_TRILHA);
    expect(r.caminhos.every((c) => c.caminho.startsWith(`${pastaDosArquivosDaAbordagem(org)}/`))).toBe(true);
  });

  it("rodada após rodada a trilha continua no teto, sem acumular entre execuções", async () => {
    // O cron roda todo dia; cada execução escreve a SUA linha. Nenhuma rodada
    // pode herdar a trilha da anterior — e nenhuma pode passar do teto.
    const porRodada = TETO_DE_CAMINHOS_NA_TRILHA + 10; // 60 por execução
    let trilhaAcumulada = 0;

    for (let execucao = 1; execucao <= 5; execucao += 1) {
      const r = await drenarArquivosOrfaosDaAbordagem(instalacao(1, porRodada), { agora: AGORA });
      expect(r.removidos).toBe(porRodada);
      expect(r.caminhos).toHaveLength(TETO_DE_CAMINHOS_NA_TRILHA);
      expect(r.caminhos_omitidos).toBe(porRodada - TETO_DE_CAMINHOS_NA_TRILHA);
      trilhaAcumulada += r.caminhos.length;
    }

    expect(trilhaAcumulada).toBe(5 * TETO_DE_CAMINHOS_NA_TRILHA);
  });

  it("o metadata de uma rodada cabe numa linha: a trilha no teto fica abaixo de 8 KB", async () => {
    const r = await drenarArquivosOrfaosDaAbordagem(instalacao(2, 500), { agora: AGORA });

    // O que o cron põe na linha do audit é esta lista serializada. Com caminho
    // de UUID + extensão (~90 caracteres) e o teto de 50, a linha fica na casa
    // dos 4 KB — a mesma ordem do `metadata` das outras podas, e não os ~100 KB
    // (ou mais) de uma instalação que acumulou arquivos.
    const bytesDoMetadata = Buffer.byteLength(JSON.stringify(r.caminhos), "utf8");
    expect(bytesDoMetadata).toBeLessThan(8 * 1024);
  });
});
