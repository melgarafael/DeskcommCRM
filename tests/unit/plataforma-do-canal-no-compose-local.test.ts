import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A PLATAFORMA DA IMAGEM DO CANAL, no compose local — vigiada por máquina.
 *
 * ─── O defeito (#3032) ───────────────────────────────────────────────────────
 *
 * `docker-compose.local.yml` pedia a imagem do canal sem declarar `platform:`.
 * Sem a linha o Compose resolve o manifesto da arquitetura DO HOST, e num host
 * arm64 (Mac Apple Silicon, VM arm64) o pull morre em
 *
 *   no matching manifest for linux/arm64/v8 in the manifest list entries
 *
 * — `bash scripts/local-stack.sh up` não sobe a stack. Medido contra o registry
 * em 2026-10-23, com `docker manifest inspect` sobre a tag que o compose usa:
 *
 *   [{"architecture":"amd64","os":"linux"},{"architecture":"unknown","os":"unknown"}]
 *
 * Ou seja: `linux/amd64` e nada mais. A tag irmã, essa só para arm64, é o
 * espelho disso (`linux/arm64` e nada mais). NENHUMA das duas é multi-arch,
 * então "trocar por uma tag multi-arch" não existe para a versão em uso: o que
 * resta — e o que o compose passou a fazer — é DECLARAR a arquitetura que a tag
 * publica, para a resolução deixar de depender da máquina de quem desenvolve.
 *
 * ─── Por que o serviço é achado por FINGERPRINT, e não pelo nome ─────────────
 *
 * A doutrina de restrição de canal (`docs/doctrine/restricao-de-canal.md`)
 * proíbe nomear o provider de canal fora de `lib/channels/`, e este arquivo não
 * precisa da exceção: o serviço do canal é o que declara `WHATSAPP_HOOK_URL` —
 * o endereço de volta do canal, que é o que ele É. O nome do provider não
 * aparece em nenhuma linha daqui, e o teste continua achando o serviço certo se
 * um dia o nome do serviço mudar.
 *
 * ─── O par de PRODUÇÃO não fixa plataforma, e isso é medição ────────────────
 *
 * Lá a imagem vem de INTERPOLAÇÃO e o instalador grava a variante nativa da
 * arquitetura do host (`hostgator-setup-kit/_common.sh`,
 * `imagem_waha_padrao_para_host()`), então o pedido já casa o manifesto do host.
 * Fixar `linux/amd64` ali quebraria justamente o host arm64 — ele recebe a tag
 * que só publica `linux/arm64`, e o pedido de amd64 voltaria a não casar
 * manifesto, que é o defeito da issue ao contrário. A asserção abaixo guarda
 * essa assimetria para ninguém "simetrizar" os dois arquivos por hábito.
 */

const RAIZ = process.cwd();

/**
 * Blocos de serviço, no molde de `tests/unit/portas-do-compose.test.ts`. Não é
 * um parser de YAML, e não podia ser: o repositório NÃO tem dependência de YAML
 * — `node_modules/yaml` e `node_modules/js-yaml` não existem (medido), e o
 * `js-yaml` do lock é transitiva do eslint. Para responder "este serviço declara
 * X?" varrer o bloco é suficiente e não traz dependência nova para um gate.
 */
function lerServicos(yaml: string): Map<string, string> {
  const linhas = yaml.split("\n");
  const servicos = new Map<string, string>();
  let dentroDeServices = false;
  let atual: string | null = null;
  let buffer: string[] = [];

  const fechar = () => {
    if (atual) servicos.set(atual, buffer.join("\n"));
    atual = null;
    buffer = [];
  };

  for (const linha of linhas) {
    if (/^services:\s*$/.test(linha)) {
      dentroDeServices = true;
      continue;
    }
    if (!dentroDeServices) continue;
    if (/^\S/.test(linha) && linha.trim() !== "") {
      fechar();
      dentroDeServices = false;
      continue;
    }
    const cabecalho = linha.match(/^ {2}([a-z0-9_-]+):\s*$/i);
    if (cabecalho) {
      fechar();
      atual = cabecalho[1] ?? null;
      continue;
    }
    if (atual) buffer.push(linha);
  }
  fechar();
  return servicos;
}

const LOCAL = lerServicos(fs.readFileSync(path.join(RAIZ, "docker-compose.local.yml"), "utf8"));
const PROD = lerServicos(fs.readFileSync(path.join(RAIZ, "docker-compose.prod.yml"), "utf8"));

/**
 * O serviço do canal é o que declara o endereço de volta do WhatsApp. Se este
 * filtro casar zero ou dois serviços, o teste REPROVA em vez de medir o arquivo
 * errado — achador que devolve vazio faz os casos abaixo passarem por vacuidade.
 */
function doCanal(servicos: Map<string, string>): [string, string][] {
  return [...servicos].filter(([, bloco]) => /^\s+WHATSAPP_HOOK_URL:/m.test(bloco));
}

describe("a plataforma da imagem do canal no compose local", () => {
  it("a sonda enxerga os serviços e acha o serviço do canal", () => {
    expect([...LOCAL.keys()], "o parser parou de enxergar os serviços").toEqual(
      expect.arrayContaining(["app", "worker", "scheduler", "redis", "srh"]),
    );
    expect(doCanal(LOCAL).length, "o achador do serviço do canal casou zero ou mais de um").toBe(1);
  });

  it("o serviço do canal declara a arquitetura que a imagem dele publica", () => {
    const [, bloco] = doCanal(LOCAL)[0] ?? [];
    expect(
      bloco,
      "sem `platform:` o Compose pede o manifesto da arquitetura do host e o pull " +
        "falha em host arm64 (`no matching manifest for linux/arm64/v8`)",
    ).toMatch(/^\s+platform: linux\/amd64$/m);
  });

  it("o compose de produção NÃO fixa plataforma: a imagem dele é escolhida por arquitetura", () => {
    const [, bloco] = doCanal(PROD)[0] ?? [];
    expect(bloco, "não achei o serviço do canal no compose de produção").toBeTruthy();
    expect(
      bloco,
      "fixar plataforma no compose de produção quebra o host arm64, que recebe a " +
        "tag publicada só para arm64 (medido)",
    ).not.toMatch(/^\s+platform:/m);
    expect(
      bloco,
      "a imagem do compose de produção saiu de interpolação: sem ela o instalador " +
        "não consegue gravar a variante nativa da arquitetura do host",
    ).toMatch(/^\s+image: \$\{/m);
  });
});
