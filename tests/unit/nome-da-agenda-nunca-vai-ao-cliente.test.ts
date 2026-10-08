import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { renderTemplate } from "@/lib/automation/template";
import { renderizar } from "@/lib/campanhas/renderizador";
import { patchDoNome } from "@/lib/contacts/nome-da-agenda";
import { nomeDoContato, rotuloDoContato, rotuloParaAEquipe } from "@/lib/contacts/rotulo-do-contato";
import { interpolateTemplate } from "@/lib/inbox/template-vars";

/**
 * O nome salvo na agenda do celular NUNCA chega ao cliente (PR #2439, decisão
 * do mantenedor: opção A).
 *
 * Esse nome é o rótulo que alguém da empresa escreveu no celular — "Maria
 * caloteira", "João obra". Ele mora em `contacts.address_book_name`, que só a
 * equipe vê (caixa de entrada, ficha, lista). Os quatro caminhos que põem nome
 * numa mensagem são provados aqui com um contato que SÓ tem o nome da agenda:
 *
 *   - `{{nome}}` da automação e do modelo de mensagem (`renderTemplate`, que lê
 *     a linha inteira do contato — inclusive pelo caminho explícito);
 *   - `{{nome}}` da campanha (`renderizar` com `nomeDoContato`, que é como a
 *     consulta de audiência o monta);
 *   - `{{nome}}` da resposta rápida da caixa de entrada (`interpolateTemplate`);
 *   - o rótulo de `rotuloDoContato`, que vai no PDF da proposta.
 *
 * E a varredura fecha a outra ponta: `patchDoNome` nunca grava a agenda em
 * `name` nem em `display_name`. O controle é `rotuloParaAEquipe`, que TEM de
 * mostrar o nome — senão o campo não serviria para nada e os vermelhos acima
 * seriam vazios por outro motivo.
 */

const APELIDO = "Maria caloteira";

/** A linha como o banco a devolve num `select("*")`: só a agenda tem nome. */
const CONTATO = {
  id: "c1",
  name: null,
  display_name: null,
  address_book_name: APELIDO,
  phone_number: "+5562984480025",
};

describe("o nome da agenda não entra em mensagem", () => {
  it("automação: {{nome}}, {{primeiro_nome}} e o caminho explícito ficam sem ele", () => {
    const texto = renderTemplate(
      "Oi {{nome}} / {{primeiro_nome}} / {{contact.address_book_name}} / {{ contact.address_book_name }}",
      { contact: CONTATO },
    );
    expect(texto).not.toContain("caloteira");
    expect(texto).not.toContain("Maria");
  });

  it("campanha: o nome do destinatário falta, e a variável é marcada como faltando", () => {
    const r = renderizar("Oi {{nome}}, {{primeiro_nome}}", { nome: nomeDoContato(CONTATO) });
    expect(r.texto).not.toContain("Maria");
    expect(r.faltando).toEqual(expect.arrayContaining(["nome", "primeiro_nome"]));
  });

  it("resposta rápida da caixa de entrada: {{nome}} fica literal", () => {
    expect(interpolateTemplate("Oi {{nome}}", CONTATO)).toBe("Oi {{nome}}");
  });

  it("rótulo que sai para o cliente (PDF da proposta) cai no telefone, não no apelido", () => {
    expect(nomeDoContato(CONTATO)).toBeNull();
    expect(rotuloDoContato(CONTATO)).not.toContain("Maria");
  });

  it("a varredura grava a agenda só no campo da equipe", () => {
    const patch = patchDoNome(CONTATO, { agenda: APELIDO, perfil: null });
    expect(patch).toEqual({ address_book_name: APELIDO });
    expect(patch).not.toHaveProperty("name");
    expect(patch).not.toHaveProperty("display_name");
  });
});

describe("controle: a equipe vê o nome", () => {
  it("rotuloParaAEquipe mostra a agenda quando não há nome escolhido no CRM", () => {
    expect(rotuloParaAEquipe(CONTATO)).toBe(APELIDO);
  });

  it("o nome escolhido no CRM vence a agenda; a agenda vence o apelido do perfil", () => {
    expect(rotuloParaAEquipe({ ...CONTATO, name: "Maria Souza" })).toBe("Maria Souza");
    expect(rotuloParaAEquipe({ ...CONTATO, display_name: "Mari" })).toBe(APELIDO);
    expect(rotuloParaAEquipe({ ...CONTATO, address_book_name: null, display_name: "Mari" })).toBe("Mari");
  });
});

/**
 * Quem LÊ a coluna. Uma lista que só encolhe: arquivo novo que cita
 * `address_book_name` reprova até alguém conferir que ele não põe o nome numa
 * mensagem, e escrever aqui o porquê.
 */
const QUEM_LE_A_AGENDA: Record<string, string> = {
  "app/api/v1/cron/contact-names/route.ts": "a varredura que ESCREVE o campo",
  "lib/channels/meta/ingest.ts": "o app WhatsApp Business (coexistência) que ESCREVE o campo",
  "lib/contacts/nome-da-agenda.ts": "decide o que a varredura grava",
  "lib/contacts/rotulo-do-contato.ts": "rotuloParaAEquipe, o rótulo das telas da equipe",
  "lib/automation/template.ts": "a guarda que recusa {{contact.address_book_name}}",
  "lib/database.types.ts": "tipos gerados do banco",
  "lib/audit/actions.ts": "só o NOME da ação de auditoria (contact.address_book_name_filled); não lê a coluna",
  "lib/types/contacts.ts": "tipo da ficha e da lista de contatos",
  "hooks/inbox/useConversationsRealtime.ts": "tipo do contato da caixa de entrada",
  "app/api/v1/conversations/_handler.ts": "select da caixa de entrada (tela da equipe)",
  "app/api/v1/contacts/_handler.ts": "select da ficha e da lista (tela da equipe)",
  "app/app/contacts/[id]/_client.tsx": "a ficha mostra o campo, marcado como só da equipe",
  "lib/lgpd/export-collector.ts":
    "o acesso do TITULAR (LGPD Art. 18 II, data.json): é dado pessoal dele, apagado na anonimização — não é mensagem, é o que ele pediu",
  "app/api/v1/lgpd/requests/[id]/preview/route.ts": "a prévia do export que a equipe confere antes de entregar",
};

function arquivos(dir: string): string[] {
  return readdirSync(dir).flatMap((nome) => {
    const caminho = join(dir, nome);
    if (nome === "node_modules" || nome.startsWith(".")) return [];
    if (statSync(caminho).isDirectory()) return arquivos(caminho);
    return /\.(ts|tsx)$/.test(nome) && !/\.test\.tsx?$/.test(nome) ? [caminho] : [];
  });
}

describe("quem lê a coluna", () => {
  it("só os arquivos listados citam address_book_name", () => {
    const citam = ["app", "lib", "components", "hooks", "workers"]
      .flatMap((d) => arquivos(d))
      .filter((f) => readFileSync(f, "utf8").includes("address_book_name"))
      .sort();
    expect(citam).toEqual(Object.keys(QUEM_LE_A_AGENDA).sort());
  });
});
