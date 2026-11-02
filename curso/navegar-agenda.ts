/** Navegação pela grade real: ?data= não controla a âncora da agenda. */
import type { Page } from "@playwright/test";
import { esperarCarregar } from "./capturar";

export function diaNoFuso(instante: string, fuso: string): string {
  const partes = new Intl.DateTimeFormat("en-CA", { timeZone: fuso, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(instante));
  const campo = (tipo: string) => partes.find((p) => p.type === tipo)!.value;
  return `${campo("year")}-${campo("month")}-${campo("day")}`;
}

export function periodoParaDia(dias: string[], alvo: string): "anterior" | "seguinte" | null {
  if (!dias.length || [...dias, alvo].some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d))) throw new Error("grade sem datas válidas");
  if (dias.includes(alvo)) return null;
  const ordenados = [...dias].sort();
  if (alvo < ordenados[0]!) return "anterior";
  if (alvo > ordenados.at(-1)!) return "seguinte";
  throw new Error("o dia esperado não aparece no período desenhado");
}

export function abaDoCompromisso(inicio: string, status: string, agora: number) {
  return status === "cancelled" ? "cancelados" : status === "pending" ? "aguardando" : Date.parse(inicio) < agora ? "passados" : "proximos";
}

export async function navegarAgendaAte(page: Page, inicio: string, fuso: string, status: string) {
  const alvo = diaNoFuso(inicio, fuso);
  await page.getByTestId("visao-semana").click();
  await esperarCarregar(page);
  for (let tentativa = 0; tentativa < 1040; tentativa++) {
    const dias = await page.locator("[data-corpo-do-dia]").evaluateAll((els) => els.map((e) => e.getAttribute("data-corpo-do-dia")!).sort());
    const sentido = periodoParaDia(dias, alvo);
    if (!sentido) {
      const agora = await page.evaluate(() => Date.now());
      const aba = abaDoCompromisso(inicio, status, agora);
      await page.getByTestId(`aba-${aba}`).click();
      await esperarCarregar(page);
      return;
    }
    await page.getByTestId(`periodo-${sentido}`).click();
    await page.waitForFunction((antes) => JSON.stringify([...document.querySelectorAll("[data-corpo-do-dia]")].map((e) => e.getAttribute("data-corpo-do-dia")).sort()) !== antes,
      JSON.stringify(dias), { timeout: 8_000 });
    await esperarCarregar(page);
  }
  throw new Error("agenda não alcançou a data do compromisso após navegar pela interface");
}
