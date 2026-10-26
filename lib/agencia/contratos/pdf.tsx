import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import React from "react";

/**
 * O PDF do contrato (docs/agencia/SPEC-contratos.md, K2): sempre do TEXTO
 * guardado no contrato, nunca do modelo — mudar o modelo não muda contrato gerado.
 * Linha toda em maiúsculas (título, "CLÁUSULA 1 — …") sai em negrito.
 */
const styles = StyleSheet.create({
  page: { paddingVertical: 48, paddingHorizontal: 56, fontSize: 10.5, lineHeight: 1.45, color: "#111827" },
  titulo: { fontSize: 13, fontWeight: 700, textAlign: "center", marginBottom: 14 },
  destaque: { fontWeight: 700, marginTop: 10, marginBottom: 2 },
  paragrafo: { marginBottom: 6, textAlign: "justify" },
  pendencia: { color: "#b91c1c" },
  assinaturas: { flexDirection: "row", justifyContent: "space-between", marginTop: 48 },
  assinatura: { width: "45%", borderTopWidth: 0.75, borderColor: "#111827", paddingTop: 4, fontSize: 9, textAlign: "center" },
  rodape: { position: "absolute", bottom: 24, left: 56, right: 56, fontSize: 8, color: "#9ca3af", textAlign: "center" },
});

function ehDestaque(linha: string): boolean {
  const letras = linha.replace(/[^A-Za-zÀ-ÿ]/g, "");
  return letras.length >= 4 && letras === letras.toUpperCase();
}

function Contrato({ texto, titulo, partes }: { texto: string; titulo: string; partes: { contratante: string; contratada: string } }) {
  const linhas = texto.split(/\r?\n/);
  return (
    <Document title={titulo}>
      <Page size="A4" style={styles.page}>
        {linhas.map((l, i) => {
          const t = l.trim();
          if (!t) return null;
          if (i === 0 || (i < 3 && ehDestaque(t))) return <Text key={i} style={styles.titulo}>{t}</Text>;
          const estilo = ehDestaque(t) ? styles.destaque : styles.paragrafo;
          return (
            <Text key={i} style={t.includes("[FALTA:") || t.includes("[CAMPO DESCONHECIDO:") ? [estilo, styles.pendencia] : estilo}>
              {t}
            </Text>
          );
        })}
        <View style={styles.assinaturas} wrap={false}>
          <Text style={styles.assinatura}>{partes.contratante}{"\n"}CONTRATANTE</Text>
          <Text style={styles.assinatura}>{partes.contratada}{"\n"}CONTRATADA</Text>
        </View>
        <Text style={styles.rodape} render={({ pageNumber, totalPages }) => `${titulo} · página ${pageNumber} de ${totalPages}`} fixed />
      </Page>
    </Document>
  );
}

export async function renderContratoPdf(p: { texto: string; titulo: string; contratante: string; contratada: string }): Promise<Buffer> {
  return (await renderToBuffer(<Contrato texto={p.texto} titulo={p.titulo} partes={{ contratante: p.contratante, contratada: p.contratada }} />)) as Buffer;
}
