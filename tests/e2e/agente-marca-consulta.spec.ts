import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect } from "@playwright/test";

import { irParaASemanaDoCompromisso } from "./helpers/agenda-semana-integra";

/**
 * O AGENTE MARCA CONSULTA, E O EFEITO APARECE NA AGENDA — a prova em tela da frente 4.
 *
 * ## Por que esta spec existe, e por que os testes de unidade não bastam
 *
 * As cinco ferramentas de agenda têm teste de comportamento — e **todos mockam a camada
 * de baixo**: os dois de leitura mockam `horariosLivresDaOrg` e `listaAgendamentos`, os
 * três de escrita mockam os handlers. Nenhum atravessa ponte, transporte, Bearer, escopo
 * de funil e banco.
 *
 * Então, sem esta spec, nada prova que a IA marca de verdade: prova que cada função faz o
 * que diz **quando a de baixo coopera**. E "ferramentas para o agente realizar ações
 * COMPLETAS" — a frase do pedido — inclui o caminho, não só a função.
 *
 * ## As duas metades, e por que ficam separadas
 *
 * 1. **A linha nasce** (`crm_find_free_slots` → `crm_book_appointment`). Não depende de
 *    tela nenhuma.
 * 2. **O efeito aparece na Agenda**, com autoria da IA.
 *
 * Elas falham por motivos diferentes: a primeira quebra se o MCP, o escopo ou a regra
 * quebrarem; a segunda, se a tela deixar de ler o dado real. Separadas, uma continua
 * provando quando a outra cai — e a segunda esteve bloqueada por horas enquanto a
 * primeira já podia rodar.
 *
 * ## ⚠️ PELO HTTP, NÃO PELO HANDLER — e isso não é preciosismo
 *
 * `agenteChama` fala com `/api/mcp` como um cliente MCP externo. É o transporte que
 * carrega o Bearer, e é o Bearer que carrega `actor:ai_agent`. Chamar o handler em
 * processo pularia justamente a etapa que decide a AUTORIA que a tela mostra — e uma spec
 * que provasse o efeito com a autoria errada provaria a coisa errada com aparência de
 * sucesso.
 *
 * ## ⚠️ O PAPEL DO TOKEN NÃO É ATALHO DE TESTE
 *
 * O seed emite `role:manager` (rank 4). As escritas de agenda pedem `ai_operator` (rank 3)
 * por PARIDADE com as rotas que elas espelham — `POST /api/v1/agenda/agendamentos` exige
 * `agent`, e um atendente humano não configura a régua da agenda. O token alcança porque
 * é maior, não porque afrouxamos nada: `capacidade-alcancavel-pelo-agente.test.ts` cobra
 * que essa restrição continue declarada.
 *
 * Self-contido: cancela o que marcou no final, para reruns ficarem verdes num banco
 * compartilhado com outras sessões.
 */
const APP_URL = `http://localhost:${process.env.E2E_PORT ?? "3001"}`;
const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const AGENTE_PATH = path.join(process.cwd(), ".e2e-agente-mcp.json");
const EVIDENCIA = path.join(process.cwd(), "evidence", "calendario");

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
  agenda?: {
    tipo_slug: string;
    tipo_nome: string;
    contato_id: string;
    contato_nome: string;
    dono_user_id: string;
  };
}
interface TokenDoAgente {
  organization_id: string;
  token_id: string;
  bearer: string;
}

function credenciais(): Required<Creds> {
  if (!fs.existsSync(CREDS_PATH)) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  let c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  if (!c.agenda) {
    // O seed de agenda é infra compartilhada (`scripts/seed-e2e-agenda.ts`): sem tipo,
    // jornada e contato, `crm_find_free_slots` responde `sem_responsavel` ou
    // `publicou_horarios:false` — os caminhos de RECUSA, não o caminho feliz.
    execFileSync("npx", ["tsx", "scripts/seed-e2e-agenda.ts"], { stdio: "inherit" });
    c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  }
  if (!c.agenda) throw new Error("seed-e2e-agenda não gravou o bloco `agenda`");
  return c as Required<Creds>;
}

function tokenDoAgente(): TokenDoAgente {
  // Sempre reemite: o token tem validade curta e o seed é idempotente.
  execFileSync("npx", ["tsx", "scripts/seed-e2e-agente-mcp.ts"], { stdio: "inherit" });
  return JSON.parse(fs.readFileSync(AGENTE_PATH, "utf8")) as TokenDoAgente;
}

/** Chama uma capacidade pelo MCP como um cliente externo faria. Ver o cabeçalho. */
async function agenteChama(
  bearer: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${APP_URL}/api/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * 1e6),
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
  });
  const texto = await res.text();
  if (!res.ok) throw new Error(`MCP ${tool} → HTTP ${res.status}: ${texto.slice(0, 400)}`);
  // O transporte responde JSON puro OU SSE conforme o Accept negociado, e o SSE abre com
  // `event: message`. Procurar a LINHA `data:` funciona nos dois formatos.
  const linha = texto.split("\n").find((l) => l.startsWith("data:"));
  const json = JSON.parse(linha ? linha.slice(5).trim() : texto);
  if (json.error) throw new Error(`MCP ${tool} → ${JSON.stringify(json.error)}`);
  const conteudo = json.result?.content?.[0]?.text;
  return conteudo ? (JSON.parse(conteudo) as Record<string, unknown>) : {};
}

const creds = credenciais();

test.describe("o agente marca consulta", () => {
  const marcados: string[] = [];
  let bearer = "";

  test.beforeAll(() => {
    bearer = tokenDoAgente().bearer;
    fs.mkdirSync(EVIDENCIA, { recursive: true });
  });

  test.afterAll(async () => {
    // Self-contido: o que esta spec marcou, ela desmarca. Num banco compartilhado, deixar
    // compromisso para trás ocuparia o horário e faria o rerun cair no caminho de recusa.
    for (const id of marcados) {
      await agenteChama(bearer, "crm_cancel_appointment", {
        appointment_id: id,
        reason: "limpeza do teste automatizado",
      }).catch(() => undefined);
    }
  });

  test("METADE 1: o agente consulta, marca, e a linha nasce", async () => {
    const livres = (await agenteChama(bearer, "crm_find_free_slots", {
      event_type_slug: creds.agenda.tipo_slug,
      dias_a_frente: 14,
    })) as {
      horarios: { inicio: string; fim: string }[];
      publicou_horarios: boolean;
      fuso_suposto: boolean;
    };

    // O seed publica jornada e fuso de propósito: se algum destes vier "errado", o
    // problema é o cenário, não a ferramenta — e o teste diria isso em vez de falhar
    // num expect obscuro lá embaixo.
    expect(livres.publicou_horarios, "o atendente do seed não tem jornada publicada").toBe(true);
    expect(livres.fuso_suposto, "o seed deveria ter semeado o fuso explícito").toBe(false);
    expect(livres.horarios.length, "nenhum horário livre nos próximos 14 dias").toBeGreaterThan(0);

    const escolhido = livres.horarios[0]!;
    const marcado = (await agenteChama(bearer, "crm_book_appointment", {
      event_type_slug: creds.agenda.tipo_slug,
      starts_at: escolhido.inicio,
      contact_id: creds.agenda.contato_id,
    })) as { marcado: boolean; motivo?: string; mensagem?: string; compromisso?: { id: string } };

    expect(
      marcado.marcado,
      `o agente não conseguiu marcar: ${marcado.motivo ?? "?"} — ${marcado.mensagem ?? ""}`,
    ).toBe(true);
    const id = marcado.compromisso!.id;
    marcados.push(id);

    // A linha NASCE — e quem confirma é a própria listagem, pelo mesmo caminho MCP.
    const lista = (await agenteChama(bearer, "crm_list_appointments", {
      contact_id: creds.agenda.contato_id,
    })) as { compromissos: { id: string; situacao: string }[] };
    const achado = lista.compromissos.find((c) => c.id === id);
    expect(achado, "o compromisso marcado não aparece na listagem do próprio contato").toBeDefined();
  });

  test("METADE 1b: o agente NÃO marca em horário ocupado — pelo caminho real", async () => {
    // ⚠️ É O CASO QUE IMPEDE ESTA WAVE DE ABRIR BURACO, e mock não responderia: a recusa
    // nasce da leitura da jornada e do que JÁ está marcado. Um mock do banco já teria
    // passado por ela.
    const livres = (await agenteChama(bearer, "crm_find_free_slots", {
      event_type_slug: creds.agenda.tipo_slug,
      dias_a_frente: 14,
    })) as { horarios: { inicio: string }[] };
    const alvo = livres.horarios[0]!.inicio;

    const primeiro = (await agenteChama(bearer, "crm_book_appointment", {
      event_type_slug: creds.agenda.tipo_slug,
      starts_at: alvo,
      contact_id: creds.agenda.contato_id,
    })) as { marcado: boolean; compromisso?: { id: string } };
    expect(primeiro.marcado).toBe(true);
    marcados.push(primeiro.compromisso!.id);

    // E agora o MESMO horário, de novo.
    const segundo = (await agenteChama(bearer, "crm_book_appointment", {
      event_type_slug: creds.agenda.tipo_slug,
      starts_at: alvo,
      contact_id: creds.agenda.contato_id,
    })) as { marcado: boolean; motivo?: string; mensagem?: string };

    expect(segundo.marcado, "o produto aceitou DOIS compromissos no mesmo horário").toBe(false);
    // E a recusa ENSINA, em vez de só negar: recusa que só nega faz o modelo tentar de
    // novo igual e queimar os passos do turno.
    expect(segundo.mensagem, "a recusa não diz o que fazer em seguida").toMatch(
      /crm_find_free_slots|outro horário|ofereça/i,
    );
  });

  test("METADE 2: o compromisso aparece na Agenda, na tela", async ({ page }) => {
    const livres = (await agenteChama(bearer, "crm_find_free_slots", {
      event_type_slug: creds.agenda.tipo_slug,
      dias_a_frente: 14,
    })) as { horarios: { inicio: string }[] };

    const marcado = (await agenteChama(bearer, "crm_book_appointment", {
      event_type_slug: creds.agenda.tipo_slug,
      starts_at: livres.horarios[0]!.inicio,
      contact_id: creds.agenda.contato_id,
    })) as { marcado: boolean; compromisso?: { id: string } };
    expect(marcado.marcado).toBe(true);
    marcados.push(marcado.compromisso!.id);

    // ⚠️ `manager`, NÃO o primeiro da lista. `seed-e2e-credentials` cria cinco usuários e
    // o `admin` tem MFA com challenge — entrar com ele exigiria passar o segundo fator, e
    // esta spec não é sobre login. O molde (`agente-organiza-operacao`) usa `manager` pela
    // mesma razão, e `manager` já enxerga a Agenda.
    const usuario = creds.users.manager;
    if (!usuario) throw new Error(".e2e-creds.json sem o usuário `manager`");
    await page.goto(`${APP_URL}/login`);
    await page.getByLabel(/e-?mail/i).fill(usuario.email);
    await page.getByLabel(/senha/i).fill(creds.password);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    // Timeout explícito: o padrão do Playwright é curto para um login que sobe sessão.
    await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });

    await page.goto(`${APP_URL}/app/agenda`);

    // ⚠️ A GRADE DESENHA UMA SEMANA SÓ, e quem marca por API não escolhe qual.
    //
    // O horário acima é o PRIMEIRO livre dos próximos 14 dias: antes das 17h ele
    // é hoje e a grade já o mostra; depois das 17h, quando o resto de hoje
    // acabou, ele é a segunda-feira — e a grade, parada na semana corrente,
    // nunca desenha o cartão. A asserção abaixo reprovava com `element(s) not
    // found`, acusando a Agenda de não mostrar o que a IA marcou.
    //
    // Ir até a semana DO COMPROMISSO mantém o que este caso prova (o que a IA
    // marcou aparece na tela do humano) e tira a hora do run da conta.
    await irParaASemanaDoCompromisso(page, livres.horarios[0]!.inicio);

    // O nome do CONTATO é o que prova que é o compromisso certo: o título do tipo
    // apareceria mesmo num card de outro cliente.
    await expect(page.getByText(creds.agenda.contato_nome).first()).toBeVisible({ timeout: 15_000 });

    await page.screenshot({ path: path.join(EVIDENCIA, "agente-marca-consulta.png"), fullPage: true });
  });
});
