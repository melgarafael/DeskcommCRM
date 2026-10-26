import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkCompatibility, parseCatalog, parseManifest } from "@/lib/extensions/manifest";
import { aceitePendente, motivoDeRecusaDoTurno } from "@/lib/extensions/consentimento";
import { decidirDoFluxo, type FluxoDoTurno } from "@/lib/extensions/fluxo-do-turno";

/**
 * O CONSUMIDOR REAL, PONTA A PONTA (#3076, exigência 5).
 *
 * Os testes de unidade provam as regras; este prova que elas cabem num PACOTE. O arquivo lido é o
 * mesmo que o gerador de catálogo publicou — `sha256` e `byte_length` conferidos contra
 * `extensoes/catalogo.json` —, e não um objeto montado no teste. Um manifesto que só existe no
 * teste não prova que o contrato é instalável; o #3456 já tinha testes verdes e um contrato que
 * aprovava a brecha.
 *
 * A jornada é a do atendimento de uma clínica: o cliente pede o laudo, o pacote pergunta exame,
 * paciente, data e médico, e a conversa vai para uma pessoa com os quatro campos. Percorrida nos
 * TRÊS idiomas do pacote — pt-BR, o inglês do consumidor e o híndi —, porque texto por idioma é
 * parte do contrato (`TextoDoFluxo`), e um fluxo que só fala português não é o consumidor real que
 * a nota do mantenedor descreveu.
 */
const RAIZ = process.cwd();
const PACOTE = join(RAIZ, "extensoes/pacotes/deskcomm/laudo-do-exame-1.0.0.json");

const bytes = new Uint8Array(readFileSync(PACOTE));
const catalogo = parseCatalog(new Uint8Array(readFileSync(join(RAIZ, "extensoes/catalogo.json"))));
const entrada = catalogo.entries.find(
  (item) => item.publisher === "deskcomm" && item.name === "laudo-do-exame",
);

const manifest = parseManifest(bytes);
const fluxo = manifest.contributions.turn_flow as FluxoDoTurno;

/**
 * A jornada como o HOST a percorre: o gatilho abre a coleta (`perguntar`/`comecou`), cada resposta
 * avança a etapa (`perguntar`/`avancou`) e a última encerra no desfecho declarado (`passar`).
 * Devolve as bolhas na ordem em que sairiam e o estado final, que é o que o gancho grava.
 */
function jornada(textoDoGatilho: string, respostas: string[]) {
  const primeiro = decidirDoFluxo(fluxo, "deskcomm/laudo-do-exame", null, {
    texto: textoDoGatilho,
    agora: "2026-10-26T12:00:00Z",
  });
  expect(primeiro.acao).toBe("perguntar");
  const enviadas = primeiro.acao === "perguntar" ? [primeiro.texto] : [];
  let estado = primeiro.acao === "perguntar" ? primeiro.estado : null;
  let ultimo = primeiro;
  for (const resposta of respostas) {
    ultimo = decidirDoFluxo(fluxo, "deskcomm/laudo-do-exame", estado, {
      texto: resposta,
      agora: "2026-10-26T12:00:00Z",
    });
    if (ultimo.acao === "perguntar") {
      enviadas.push(ultimo.texto);
      estado = ultimo.estado;
    } else {
      // O desfecho também é uma bolha do host: `concluir` manda a despedida, `passar` manda o
      // aviso antes de entregar a conversa. Sem ele, o cliente veria a última pergunta e o
      // silêncio.
      if (ultimo.acao === "concluir") enviadas.push(ultimo.texto);
      if (ultimo.acao === "passar") enviadas.push(ultimo.aviso);
      estado = null;
    }
  }
  return { enviadas, ultimo };
}

describe("o pacote consumidor é o artefato ADMITIDO, não uma cópia do teste", () => {
  it("o catálogo publicado aponta para estes bytes exatos", () => {
    expect(entrada).toBeDefined();
    const digest = createHash("sha256").update(bytes).digest("hex");
    expect(entrada!.sha256).toBe(digest);
    expect(entrada!.byte_length).toBe(bytes.byteLength);
    // E o catálogo declara as mesmas permissões do manifesto — o contrato do pacote é espelhado.
    expect(entrada!.permissions).toEqual(["turn.send", "turn.handoff"]);
  });

  it("o manifesto declara as DUAS permissões nomeadas, e o fluxo as exige", () => {
    expect(manifest.permissions).toEqual(["turn.send", "turn.handoff"]);
    expect(fluxo.id).toBe("laudo");
    expect(fluxo.idiomas).toEqual(["pt-BR", "en", "hi"]);
    expect(fluxo.desfecho.tipo).toBe("passar_para_humano");
    expect(checkCompatibility(manifest)).toEqual({ compatible: true, reason: null });
  });

  it("antes do aceite, o pacote instalado e ativo NÃO age", () => {
    expect(
      motivoDeRecusaDoTurno({ declaradas: manifest.permissions, aceitas: [], fluxo }),
    ).toBe("sem_aceite");
    expect(aceitePendente({ declaradas: manifest.permissions, aceitas: [], fluxo })).toEqual([
      "turn.send",
      "turn.handoff",
    ]);
    // Aceite só do envio (o caso da v1 que só encerrava a coleta) não cobre a passagem.
    expect(
      motivoDeRecusaDoTurno({
        declaradas: manifest.permissions,
        aceitas: ["turn.send"],
        fluxo,
      }),
    ).toBe("aceite_desatualizado");
    // Com o aceite explícito dos dois, age.
    expect(
      motivoDeRecusaDoTurno({
        declaradas: manifest.permissions,
        aceitas: ["turn.send", "turn.handoff"],
        fluxo,
      }),
    ).toBeNull();
  });
});

describe("a jornada completa, nos três idiomas do pacote", () => {
  it("português: quatro perguntas e a passagem com os quatro campos", () => {
    const { enviadas, ultimo } = jornada("Preciso do meu laudo", [
      "Hemograma completo",
      "Maria Silva",
      "12/10/2026",
      "Dra. Helena",
    ]);
    expect(enviadas).toEqual([
      "Qual é o tipo de exame?",
      "Qual é o nome do paciente?",
      "Qual é a data do exame?",
      "Quem é o médico solicitante?",
      "Obrigado! Vou passar seu pedido para a nossa equipe conferir.",
    ]);
    expect(ultimo.acao).toBe("passar");
    if (ultimo.acao !== "passar") return;
    expect(ultimo.campos).toEqual({
      exame: "Hemograma completo",
      paciente: "Maria Silva",
      data: "12/10/2026",
      medico: "Dra. Helena",
    });
    expect(ultimo.porque).toBe("coletou");
  });

  it("inglês: o gatilho e as perguntas saem no idioma do cliente", () => {
    const { enviadas, ultimo } = jornada("Where is my report?", [
      "Blood test",
      "John Carter",
      "2026-10-12",
      "Dr. Hayes",
    ]);
    expect(enviadas).toEqual([
      "Which exam is it?",
      "What is the patient's name?",
      "What is the exam date?",
      "Who is the requesting doctor?",
      "Thank you! I will pass this to our team to check.",
    ]);
    expect(ultimo.acao).toBe("passar");
  });

  it("híndi: o mesmo fluxo, com o texto Devanagari do consumidor", () => {
    const { enviadas } = jornada("मेरा रिपोर्ट कहाँ है", [
      "रक्त परीक्षण",
      "अनीता शर्मा",
      "12/10/2026",
      "डॉ. वर्मा",
    ]);
    expect(enviadas).toEqual([
      "कौन सा परीक्षण है?",
      "मरीज़ का नाम क्या है?",
      "परीक्षण की तारीख क्या है?",
      "डॉक्टर का नाम क्या है?",
      "धन्यवाद! मैं इसे हमारी टीम को भेज रहा हूँ।",
    ]);
  });
});

describe("a jornada tem saída: a conversa volta para a IA", () => {
  it("mensagem fora do fluxo devolve o turno em vez de prender a coleta", () => {
    const abertura = decidirDoFluxo(fluxo, "deskcomm/laudo-do-exame", null, {
      texto: "Preciso do meu laudo",
      agora: "2026-10-26T12:00:00Z",
    });
    expect(abertura.acao).toBe("perguntar");
    if (abertura.acao !== "perguntar") return;
    const fora = decidirDoFluxo(fluxo, "deskcomm/laudo-do-exame", abertura.estado, {
      texto: "quanto custa o exame?",
      agora: "2026-10-26T12:05:00Z",
    });
    expect(fora).toMatchObject({ acao: "devolver", porque: "fora_do_fluxo" });
  });

  it("o teto de turnos sem progresso também devolve, em vez de insistir para sempre", () => {
    const abertura = decidirDoFluxo(fluxo, "deskcomm/laudo-do-exame", null, {
      texto: "Preciso do meu laudo",
      agora: "2026-10-26T12:00:00Z",
    });
    if (abertura.acao !== "perguntar") throw new Error("o gatilho deveria abrir a coleta");
    let estado = abertura.estado;
    let desfecho: ReturnType<typeof decidirDoFluxo> | null = null;
    // `sem_progresso > teto` encerra: com teto 3, a QUARTA mídia sem texto encerra. O desfecho do
    // pacote é `passar_para_humano`, então o teto entrega a conversa a uma pessoa (com os campos
    // que houver) em vez de insistir — a saída do fluxo é uma pessoa, não o silêncio.
    for (let i = 0; i <= (fluxo.teto_de_turnos_sem_progresso ?? 3); i += 1) {
      desfecho = decidirDoFluxo(fluxo, "deskcomm/laudo-do-exame", estado, {
        texto: "",
        agora: "2026-10-26T12:10:00Z",
      });
      if (desfecho.acao === "perguntar") estado = desfecho.estado;
    }
    expect(desfecho).toMatchObject({ acao: "passar", porque: "teto" });
  });
});
