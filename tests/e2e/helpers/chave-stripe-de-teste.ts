/** A chave que o teste contra a Stripe real aceita: só a de TESTE, nunca a de produção. */
export type LeituraDaChave = { tipo: "ausente" } | { tipo: "teste"; chave: string };

export function lerChaveStripeDeTeste(bruto: string | undefined): LeituraDaChave {
  const chave = (bruto ?? "").trim();
  if (chave === "") return { tipo: "ausente" };
  if (/^(sk|rk)_live_/.test(chave)) {
    throw new Error("Chave de PRODUÇÃO recusada: este teste só roda com chave de TESTE da Stripe (sk_test_… ou rk_test_…). Nada foi enviado à Stripe.");
  }
  if (!/^(sk|rk)_test_[A-Za-z0-9]{10,}$/.test(chave)) {
    throw new Error("STRIPE_TEST_SECRET_KEY não tem a forma de uma chave de teste da Stripe (sk_test_… ou rk_test_…).");
  }
  return { tipo: "teste", chave };
}
