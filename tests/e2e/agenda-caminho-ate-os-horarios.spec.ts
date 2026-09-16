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
