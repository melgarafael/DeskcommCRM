/** Triagem conservadora de valores/negociação, nunca valida preço ou condição. */
export function contemAssuntoComercialRestrito(texto: string): boolean {
  const normal = texto.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return /\b(?:precos?|prec[io]+s?|valor(?:es)?|custa\w*|custos?|quanto (?:fica|sai|e|seria)|descont\w*|negoci\w*|parcel\w*|pagamento\w*|pagar|pag[ao]s?|pix|boleto\w*|credito|debito|promoc\w*|oferta\w*|orcamento\w*|reais|gratis|gratuit\w*|barat\w*|caro|cobran\w*|cobr\w*|reembolso\w*|estorno\w*)\b/u.test(normal)
    || /(?:r\$|us\$|\$|€|£)\s*\d/u.test(normal)
    || /\b\d+(?:[.,]\d+)?\s*(?:%|x\b)/u.test(normal)
    || /\b\d+[.,]\d{2}\b/u.test(normal)
    || /\b(?:fica|sai|apenas|somente|a partir de)\s*(?:por|em)?\s*\d/u.test(normal);
}

export async function comercialExigeHumano(
  db: { query: (sql: string, values: unknown[]) => Promise<{ rows: Array<{ enabled: unknown }> }> },
  organizationId: string,
): Promise<boolean> {
  // Falha de leitura lança: não deve virar permissão para negociar.
  const { rows } = await db.query(
    "select settings->'routing'->'commercial_requires_human' as enabled from organizations where id = $1",
    [organizationId],
  );
  return rows[0]?.enabled === true;
}
