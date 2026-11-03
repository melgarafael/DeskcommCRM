/** Tenta a limpeza mesmo sem evidência; a primeira falha continua reprovando. */
export async function finalizarProvaComEvidencia(
  antesDaLimpeza: () => Promise<void>,
  limpar: () => Promise<void>,
  depoisDaLimpeza: () => Promise<void>,
): Promise<void> {
  let falhou = false;
  let primeiraFalha: unknown;
  const tentar = async (etapa: () => Promise<void>) => {
    try { await etapa(); }
    catch (erro) {
      if (!falhou) primeiraFalha = erro;
      falhou = true;
    }
  };
  try {
    await tentar(antesDaLimpeza);
  } finally {
    try { await tentar(limpar); }
    finally { await tentar(depoisDaLimpeza); }
  }
  if (falhou) throw primeiraFalha;
}
