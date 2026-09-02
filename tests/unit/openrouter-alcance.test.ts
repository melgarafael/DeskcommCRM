/**
 * Invariante de ALCANCE: o que a `OPENROUTER_API_KEY` roteia — e o que ela não
 * roteia.
 *
 * Por que este arquivo existe: o `.env.example` afirma ao self-hoster quais
 * caminhos passam a usar a OpenRouter quando ele preenche a chave. Afirmação em
 * comentário não se defende sozinha — a primeira pessoa que ligar o resolver a
 * um caminho novo não vai lembrar de reescrever o aviso, e o usuário decide a
 * configuração da instalação lendo justamente esse aviso.
 *
 * O alcance real hoje, medido: `resolveLanguageModel()` é chamado por
 * `ai-sentiment-worker` (classificação de sentimento) e `ai-response-worker`
 * (bot de resposta). NENHUM dos dois passa `tools` ao SDK. O agente do CRM, que
 * opera por ferramentas, roda por outro caminho — `lib/agent-engine/edge/llm/
 * providers.ts` (credencial BYOK por organização) e `buildModel()` em
 * `lib/ai/runtime/agent.ts`.
 *
 * ⚠️ Esta última frase dizia "e nenhum deles conhece a OpenRouter", e envelheceu
 * em duas etapas — exatamente o apodrecimento que o parágrafo acima previa:
 *   1. `providers.ts` passou a registrar `openrouter` (a virada que o penúltimo
 *      teste deste arquivo já reconhece e vigia);
 *   2. `buildModel()` ficou para trás mais um tempo, com três casos, e o ensaio
 *      da aba "Teste" morria em `unsupported_provider` para um agente que o
 *      worker atendia normalmente. Agora conhece os quatro, e quem vigia isso é
 *      `tests/unit/provedores-x-registry.test.ts`, que chama a função para cada
 *      id da lista canônica.
 * A chave também não chegava ao worker: `OPENROUTER_API_KEY` faltava no schema
 * de `lib/agent-engine/env.ts` e o Zod a removia no boot.
 *
 * Isso importa porque muda QUAL risco o usuário corre. Um modelo sem tool
 * calling sólido é catastrófico num turno com ferramentas (responde texto
 * plausível e nunca cria o lead nem move o card) e é inofensivo numa
 * classificação de sentimento. Enquanto a OpenRouter não alcançar o primeiro
 * grupo, o aviso não deve assustar com ele; no dia em que alcançar, o aviso
 * PRECISA assustar — e este teste é quem obriga a decidir isso conscientemente.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { validarBinding } from "@/lib/ai/pontos/validar-binding";

const RAIZ = resolve(__dirname, "../..");

/** Arquivos de produção que importam o resolver (exclui testes e o próprio módulo). */
function chamadoresDoResolver(): string[] {
  const saida = execFileSync(
    "git",
    // `--color=never` não é decoração: `git grep` não colore quando não há TTY,
    // MAS colore assim mesmo se o dev tiver `color.ui=always` no ~/.gitconfig — e
    // aí cada caminho volta embrulhado em ANSI, o `split("\n")` devolve
    // "\u001b[35mlib/ai/...\u001b[m", e nenhum `readFileSync` acha o arquivo.
    // Medido nas três combinações:
    //   sem config            -> ANSI: false
    //   -c color.ui=always    -> ANSI: true   <- o teste quebra aqui
    //   + --color=never       -> ANSI: false
    ["grep", "--color=never", "-l", "resolveLanguageModel", "--", "lib", "workers", "app", "scripts"],
    { cwd: RAIZ, encoding: "utf8" },
  );
  return saida
    .split("\n")
    .filter(Boolean)
    .filter((f) => !f.includes(".test.") && f !== "lib/ai/gateway.ts" && f !== "lib/env.ts");
}

describe("alcance da OPENROUTER_API_KEY", () => {
  it("o resolver tem chamadores — senão o invariante estaria passando por vacuidade", () => {
    // Sem esta asserção, apagar o resolver deixaria o teste abaixo verde e o
    // aviso do .env.example desprotegido.
    expect(chamadoresDoResolver().length).toBeGreaterThan(0);
  });

  it("os caminhos do resolver por env seguem sem ferramentas", () => {
    const comFerramentas = chamadoresDoResolver().filter((arquivo) =>
      /\btools\s*:/.test(readFileSync(resolve(RAIZ, arquivo), "utf8")),
    );

    expect(
      comFerramentas,
      comFerramentas.length
        ? `${comFerramentas.join(", ")} passa(m) ferramentas ao modelo E resolve(m) pela OpenRouter. ` +
            "O aviso sobre tool calling em .env.example / .env.hostgator.example foi escrito quando " +
            "isso NÃO acontecia e agora está desatualizado: reescreva-o antes de liberar este caminho."
        : undefined,
    ).toEqual([]);
  });

  it("o agente com ferramentas AGORA está ao alcance da OpenRouter — e isso é deliberado", () => {
    // ─── A virada, e por que ela não afrouxa este arquivo ──────────────────
    //
    // Este teste dizia "continua fora do alcance" e o cabeçalho avisava: "no
    // dia em que alcançar, o aviso PRECISA assustar — e este teste é quem
    // obriga a decidir isso conscientemente". O dia chegou: a migration 0127
    // abriu `provider` como vocabulário aberto e `createDefaultRegistry`
    // registra `openrouter`, então uma chave da OpenRouter pode atender o ponto
    // que cria o lead.
    //
    // A guarda não foi removida — ela MUDOU DE ALVO. Antes protegia uma
    // ausência (o caminho não existe); agora protege a proteção (o caminho
    // existe e é vigiado). Apagar o teste teria devolvido verde e deixado o
    // risco solto, que é o pior desfecho possível para um invariante incômodo.
    expect(
      readFileSync(resolve(RAIZ, "lib/agent-engine/edge/llm/providers.ts"), "utf8").toLowerCase(),
    ).toContain("openrouter");
  });

  it("o risco novo tem catraca: modelo sem ferramentas é RECUSADO no ponto que cria o lead", () => {
    // É o desfecho que a abertura da OpenRouter torna possível e que ninguém
    // veria acontecer: o agente conversa bem, o cliente é atendido, e nada
    // chega ao funil — sem erro na tela.
    const semFerramentas = {
      model_id: "algum/modelo-sem-tools",
      supports_tools: false,
      supports_vision: false,
      conhecido: true,
    };
    for (const ponto of ["agent_turn", "operator_turn"]) {
      const r = validarBinding({ pontoId: ponto, modelo: semFerramentas });
      expect(r.ok, `${ponto} aceitou modelo sem ferramentas`).toBe(false);
      if (!r.ok) expect(r.codigo).toBe("modelo_sem_ferramentas");
    }
  });

  it("a catraca não é geral demais — classificador aceita modelo sem ferramentas", () => {
    // A recíproca. Recusar em todo ponto seria fechar o caso de uso mais
    // atraente da OpenRouter (modelo barato para classificar) e o teste acima
    // passaria igual.
    const r = validarBinding({
      pontoId: "stage_classifier",
      modelo: {
        model_id: "algum/modelo-barato",
        supports_tools: false,
        supports_vision: false,
        conhecido: true,
      },
    });
    expect(r.ok).toBe(true);
  });

  it("o aviso do .env.example acompanhou a virada", () => {
    // O cabeçalho deste arquivo existe por isto: o self-hoster decide a
    // configuração lendo o aviso, e um aviso escrito quando a OpenRouter não
    // alcançava o agente passou a mentir no instante em que ela alcançou.
    const aviso = readFileSync(resolve(RAIZ, ".env.example"), "utf8");
    const trecho = aviso.slice(aviso.toLowerCase().indexOf("openrouter"));
    expect(
      trecho.toLowerCase(),
      "o .env.example precisa avisar que a escolha do modelo agora afeta o agente com ferramentas",
    ).toMatch(/ferramenta|tool/);
  });
});
