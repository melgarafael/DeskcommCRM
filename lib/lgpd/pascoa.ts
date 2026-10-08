/**
 * O Domingo de Páscoa no calendário gregoriano — Meeus/Jones/Butcher.
 *
 * Uma implementação SÓ para os dois países que têm feriado móvel: Portugal
 * (#2410) e Brasil (#2413) derivam daqui a Sexta-feira Santa, o Corpo de Deus e
 * o Carnaval. Duas cópias divergiriam no primeiro ajuste — e a divergência
 * apareceria como um prazo de LGPD contado num calendário e afirmado no outro.
 */

/** Mês (1–12) e dia do Domingo de Páscoa do ano. */
export function pascoaDoAno(ano: number): { mes: number; dia: number } {
  const a = ano % 19;
  const b = Math.floor(ano / 100);
  const c = ano % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return { mes, dia };
}

/** `YYYY-MM-DD` de `dias` depois da Páscoa (negativo = antes). */
export function diaEmTornoDaPascoa(ano: number, dias: number): string {
  const { mes, dia } = pascoaDoAno(ano);
  const alvo = new Date(Date.UTC(ano, mes - 1, dia) + dias * 86_400_000);
  const mm = String(alvo.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(alvo.getUTCDate()).padStart(2, "0");
  return `${alvo.getUTCFullYear()}-${mm}-${dd}`;
}
