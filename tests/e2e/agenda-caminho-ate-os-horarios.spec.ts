import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect } from "@playwright/test";

/**
 * DO AVISO ATÉ A JORNADA — o caminho que não existia.
 *
 * ═══ O defeito ═══════════════════════════════════════════════════════════════
 * A Agenda dizia, para quem nunca publicou horários:
 *
 *   "Você ainda não publicou seus horários de atendimento. Sem eles ninguém
 *    consegue marcar — nem você, nem o agente. Configure a sua disponibilidade
 *    e os horários aparecem aqui."
 *
 * E não havia link nenhum. O dono do produto procurou onde configurar, não
 * achou, e concluiu que a tela não existia.
 *
 * ⚠️ A TELA EXISTE. É a aba "Atendimento" de `/app/team`
 * (`AttendantsClient.tsx`), com editor de fuso e janelas semanais, gravando em
 * `attendant_availability.schedule` pela rota `/api/v1/attendants/availability`.
 * O que faltava era o CAMINHO — e, no destino, algo que se anunciasse como
 * "horários": a seção se chamava "Atendentes / status, carga e capacidade".
 *
 * O comentário de `lib/navigation/registry.ts` dizia "a disponibilidade ainda
 * não tem tela" — afirmação de estado VENCIDA, que fez a investigação começar
 * pelo lado errado. Prosa que mente custa mais que código faltando.
 *
 * ═══ Por que a asserção é sobre o DESTINO, e não sobre a palavra ═════════════
 * `tests/e2e/agenda-kit-visual.spec.ts` já cobrava que o aviso dissesse o
 * próximo passo, com `toContainText(/configure|disponibilidade/i)` — e o texto
 * morto passava por ela. Instrução sem caminho é acusação, e uma asserção sobre
 * PALAVRA não distingue as duas.
 */
const RAIZ = path.resolve(__dirname, "../..");

test.describe.configure({ timeout: 120_000 });

interface Creds {
  password: string;
  users: Record<string, { email: string } | undefined>;
}

function lerCreds(): Creds {
  const p = path.join(RAIZ, ".e2e-creds.json");
  if (!fs.existsSync(p)) throw new Error("`.e2e-creds.json` ausente — rode `scripts/seed-e2e-credentials.ts`");
  return JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
}

async function entrar(page: import("@playwright/test").Page, creds: Creds) {
  // `manager` é o piso que a aba de Atendimento exige (a tela mostra o aviso de
  // permissão abaixo disso), e o `admin` do seed tem TOTP, que não é o assunto.
  const usuario = creds.users.manager;
  if (!usuario) throw new Error(".e2e-creds.json sem o usuário `manager`");
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(usuario.email);
  await page.getByLabel(/senha/i).fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
}

test("o endereço da aba de Atendimento abre nela, e ela se anuncia como o lugar dos horários", async ({
  page,
}) => {
  const creds = lerCreds();
  await entrar(page, creds);

  // É o destino exato para onde o aviso da Agenda aponta. Sem o parâmetro, o
  // usuário cairia na aba de Membros — procurando de novo, que é o defeito.
  await page.goto("/app/team?aba=atendimento");

  const secao = page.getByTestId("atendentes-e-horarios");
  await expect(
    secao,
    "abri /app/team?aba=atendimento e a aba de Atendimento não estava aberta",
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    secao,
    "a seção não se nomeia como o lugar dos horários — foi por isso que ninguém a achou",
  ).toContainText(/horários/i);

  // O editor de verdade, e não só o título: o botão por atendente é o que abre a
  // jornada semanal. `first()` porque a organização de teste tem vários.
  await expect(
    page.getByRole("button", { name: /Editar horário de/ }).first(),
    "a seção existe mas não oferece o editor de jornada",
  ).toBeVisible({ timeout: 20_000 });

  await page.screenshot({ path: "evidence/calendario/d1-aba-atendimento.png", fullPage: true });
});

test("um endereço de aba desconhecido cai na aba padrão, não numa tela vazia", async ({ page }) => {
  // Link velho, colado errado ou digitado à mão não pode devolver uma página em
  // que nenhuma das duas abas está aberta.
  const creds = lerCreds();
  await entrar(page, creds);
  await page.goto("/app/team?aba=aba-que-nao-existe");
  await expect(page.getByRole("tab", { name: /Membros/i })).toHaveAttribute("data-state", "active", {
    timeout: 20_000,
  });
});


/**
 * O SELO DE PLANTÃO DIZ A VERDADE — os três estados, pela tela.
 *
 * ═══ O defeito que este caso fecha ═══════════════════════════════════════════
 * A coluna Status lia `is_available && !isHeartbeatStale(last_heartbeat_at)`, e
 * as duas metades mentiam. O sinal de vida NUNCA era emitido por ninguém —
 * varredura do repositório inteiro, nenhum emissor —, então o selo virava
 * "Offline" ~15 min depois de qualquer clique e ficava assim para sempre. E a
 * jornada publicada, que é o que de fato decide quem atende, não entrava na
 * conta.
 *
 * Agora o selo é `estaDePlantao`: a MESMA conta do roteador, sem a capacidade.
 *
 * ═══ Por que a montagem é por API e a asserção é pela TELA ═══════════════════
 * O que mudou foi o SELO, e é ele que este caso cobra — pelo texto que a pessoa
 * lê. A jornada é montada pela rota que a própria tela usa (`PATCH
 * /api/v1/attendants/availability/<id>`, o mesmo corpo que o diálogo envia),
 * porque dirigir o editor de janelas é fricção que não prova nada a mais: o
 * diálogo não foi tocado por esta mudança.
 *
 * A chave "Disponível", sim, é clicada — ela é a entrada do estado que o selo lê.
 *
 * ═══ Sem relógio mockado ═════════════════════════════════════════════════════
 * A janela é calculada A PARTIR DE AGORA, no fuso da jornada: uma que CONTÉM
 * este instante e outra que não. Assim o caso é determinístico a qualquer hora
 * do dia, sem `clock.install()` — e exercita o mesmo `Intl` que o produto usa.
 */
test("o selo de plantão distingue de plantão, fora do horário e desligado", async ({ page }) => {
  const creds = lerCreds();
  await entrar(page, creds);
  await page.goto("/app/team?aba=atendimento");
  await expect(page.getByTestId("atendentes-e-horarios")).toBeVisible({ timeout: 20_000 });

  // A linha de quem está logado — a única cuja chave este papel pode mexer.
  const email = creds.users.manager!.email;
  const linha = page.getByRole("row").filter({ hasText: email });
  await expect(linha, "a pessoa logada não aparece na lista de atendentes").toBeVisible({
    timeout: 20_000,
  });

  const TZ = "America/Sao_Paulo";
  // Dia da semana e hora AGORA, no fuso da jornada — a mesma pergunta que
  // `localMoment` faz no produto.
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const DIAS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dow = DIAS.indexOf(partes.find((x) => x.type === "weekday")!.value);
  const hora = Number(partes.find((x) => x.type === "hour")!.value);

  /** Grava a jornada pela mesma rota que o diálogo usa. */
  async function publicaJornada(windows: Array<{ dow: number; start: string; end: string }>) {
    const alvo = await page.evaluate(async (mail: string) => {
      const r = await fetch("/api/v1/attendants/availability");
      const j = (await r.json()) as { data: Array<{ user_id: string; email?: string }> };
      return j.data.find((a) => a.email === mail)?.user_id ?? j.data[0]?.user_id ?? null;
    }, email);
    expect(alvo, "não achei o atendente para montar a jornada").not.toBeNull();
    const res = await page.request.patch(`/api/v1/attendants/availability/${alvo}`, {
      data: { schedule: { timezone: TZ, windows } },
    });
    expect(res.status(), await res.text()).toBe(200);
  }

  // ── 1. DESLIGADO ─────────────────────────────────────────────────────────
  // A decisão de gente vence tudo: com a chave desligada não importa jornada.
  const chave = linha.getByRole("switch");
  if (await chave.isChecked()) await chave.click();
  await expect(linha.getByText("Desligado", { exact: true })).toBeVisible({ timeout: 15_000 });

  // ── 2. DE PLANTÃO, com jornada que contém AGORA ──────────────────────────
  // A janela cobre o dia inteiro de hoje: contém este instante a qualquer hora.
  await publicaJornada([{ dow, start: "00:00", end: "23:59" }]);
  await chave.click();
  await expect(
    linha.getByText("De plantão", { exact: true }),
    "chave ligada e dentro da jornada, e o selo não diz que está de plantão",
  ).toBeVisible({ timeout: 15_000 });

  // ── 3. FORA DO HORÁRIO — a chave continua LIGADA ─────────────────────────
  // Uma janela de uma hora que não contém agora. É o estado que antes aparecia
  // como "Offline", igualzinho a quem tinha desligado — e fazia o operador
  // procurar defeito onde só havia jornada terminada.
  const outra = (hora + 3) % 24;
  const hh = (n: number) => String(n).padStart(2, "0");
  await publicaJornada([{ dow, start: `${hh(outra)}:00`, end: `${hh(outra)}:30` }]);
  await page.reload();
  await expect(page.getByTestId("atendentes-e-horarios")).toBeVisible({ timeout: 20_000 });
  await expect(
    linha.getByText("Fora do horário", { exact: true }),
    "fora da jornada o selo tem de dizer isso, e não se confundir com desligado",
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    linha.getByRole("switch"),
    "a chave foi DESLIGADA por estar fora do horário — ela é a decisão da pessoa, " +
      "e sair da janela não pode mexer nela",
  ).toBeChecked();

  // ── 4. 24/7 — jornada vazia, e o plantão volta sem ninguém tocar na chave ─
  await publicaJornada([]);
  await page.reload();
  await expect(page.getByTestId("atendentes-e-horarios")).toBeVisible({ timeout: 20_000 });
  await expect(
    linha.getByText("De plantão", { exact: true }),
    "sem jornada publicada o plantão é 24/7 — e ninguém tocou na chave entre um passo e outro",
  ).toBeVisible({ timeout: 15_000 });

  await page.screenshot({ path: ".superpowers/evidence/plantao-tres-estados.png" });
});
