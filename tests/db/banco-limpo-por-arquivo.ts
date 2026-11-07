/**
 * setupFile da suíte de invariantes: recria o banco `postgres` a partir do
 * MOLDE (`$TEST_DB_TEMPLATE`, criado uma vez por scripts/test-db.sh com o
 * baseline aplicado) antes de CADA arquivo de tests/invariants.
 *
 * ## Por que existe
 *
 * Os 100 arquivos falam com o MESMO Postgres efêmero e não limpam nada. Como as
 * fixtures são UUIDs fixos escritos à mão, arquivos diferentes acabam gravando
 * identidades diferentes no mesmo id — e todo insert é `on conflict do nothing`,
 * que transforma a colisão em silêncio, não em erro. Dois casos medidos na
 * issue #207, ambos reais no HEAD:
 *
 *   - `human-cases` cria a channel_session `cccccccc-0000-…-0003` como `waha`;
 *     `agent-send-template-turn` "cria" a MESMA id como `meta_cloud`. Quem
 *     chega depois não cria nada e não reclama. Se `human-cases` vier antes, o
 *     provider fica `waha`, a tool `send_template` some do run e 4 asserções
 *     caem — dizendo "o template não saiu" quando o produto está certo.
 *   - `gov-1b-team-manager-read` e `gov-6-assignee-kind` criam orgs com ids
 *     DIFERENTES e o MESMO slug `gov-inv-b`. A segunda colide no unique de slug,
 *     é engolida pelo `on conflict`, e o `user_organizations` seguinte estoura
 *     na FK. Qualquer um dos dois pode ser o perdedor — depende da ordem.
 *
 * Com a ordem default do sequencer o resultado é estável por acidente; sob
 * `--sequence.shuffle.files` era vermelho em 3 de 4 seeds. Um gate que sorteia
 * não prova o isolamento multi-tenant que ele carrega.
 *
 * ## Por que aqui e não dentro dos arquivos
 *
 * `tests/invariants/**` é suíte compartilhada: editar um invariante é manutenção
 * normal de teste (o congelamento do eval do épico foi aposentado), mas renomear
 * as fixtures dos dois pares acima resolveria ESTAS duas colisões e deixaria a
 * classe intacta — a próxima entra do mesmo jeito. Isolar o estado é o conserto
 * por classe, e não depende de nenhum arquivo de invariante mudar.
 *
 * ## Custo
 *
 * `create database … template` é cópia de arquivo: ~0,3s por arquivo de teste.
 * Medido na suíte inteira: 126s → 137s (+9%).
 *
 * DROP/CREATE DATABASE não rodam dentro de bloco de transação — daí o `-f -`
 * (psql manda statement a statement, autocommit) em vez de `-c "a; b"` (que o
 * psql embrulharia numa transação só). É seguro porque a config tem
 * `fileParallelism: false`: um arquivo por vez, dono único do ponteiro.
 */
import { execFileSync } from "node:child_process";

const container = process.env.TEST_DB_CONTAINER;
const template = process.env.TEST_DB_TEMPLATE;

if (!container || !template) {
  throw new Error(
    "TEST_DB_CONTAINER/TEST_DB_TEMPLATE ausentes — a suíte de invariantes roda por " +
      "`pnpm test:db` (scripts/test-db.sh), que sobe o Postgres efêmero e aplica o baseline no molde.",
  );
}

execFileSync(
  "docker",
  ["exec", "-i", container, "psql", "-U", "postgres", "-d", "template1", "-qtA", "-v", "ON_ERROR_STOP=1", "-f", "-"],
  {
    input: `drop database if exists postgres with (force);\ncreate database postgres template ${template};\n`,
    encoding: "utf8",
  },
);

// Marcador lido por tests/invariants/harness-isola-por-arquivo.test.ts. Sem ele
// aquele invariante não teria como distinguir "recebi um banco limpo porque o
// reset rodou" de "recebi um banco limpo porque calhei de ser o primeiro
// arquivo da rodada" — e passaria verde justamente na regressão que ele existe
// para pegar (o setupFile sumir da config).
process.env.DESKCOMM_INVARIANTS_DB_RESET = "1";
