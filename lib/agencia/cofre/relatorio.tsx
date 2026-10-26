import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import React from "react";

/**
 * O relatório de acessos que a agência entrega ao cliente
 * (docs/agencia/SPEC-cofre-e-formulario.md, F7). Gerado na hora e devolvido na
 * resposta — nunca salvo em disco, no banco ou no Drive.
 */
const styles = StyleSheet.create({
  page: { padding: 36, fontSize: 10, color: "#111827" },
  marca: { fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1 },
  titulo: { fontSize: 18, fontWeight: 700, marginTop: 4 },
  subtitulo: { fontSize: 10, color: "#4b5563", marginTop: 2, marginBottom: 18 },
  item: { borderWidth: 0.75, borderColor: "#d1d5db", borderRadius: 4, padding: 10, marginBottom: 8 },
  rotulo: { fontSize: 12, fontWeight: 700, marginBottom: 4 },
  linha: { flexDirection: "row", marginTop: 2 },
  chave: { width: 70, color: "#6b7280" },
  valor: { flex: 1, fontFamily: "Courier" },
  aviso: { marginTop: 14, fontSize: 9, color: "#4b5563", lineHeight: 1.4 },
  rodape: { position: "absolute", bottom: 24, left: 36, right: 36, fontSize: 8, color: "#9ca3af" },
});

export interface AcessoDoRelatorio {
  rotulo: string;
  login: string | null;
  extra: string | null;
  senha: string | null;
}

function Relatorio({ cliente, agencia, geradoEm, acessos }: { cliente: string; agencia: string; geradoEm: string; acessos: AcessoDoRelatorio[] }) {
  return (
    <Document title={`Acessos — ${cliente}`} author={agencia}>
      <Page size="A4" style={styles.page}>
        <Text style={styles.marca}>{agencia}</Text>
        <Text style={styles.titulo}>Relatório de acessos</Text>
        <Text style={styles.subtitulo}>
          {cliente} · gerado em {geradoEm}
        </Text>
        {acessos.length === 0 && <Text>Nenhum acesso cadastrado.</Text>}
        {acessos.map((a, i) => (
          <View key={i} style={styles.item} wrap={false}>
            <Text style={styles.rotulo}>{a.rotulo}</Text>
            {a.extra && (
              <View style={styles.linha}>
                <Text style={styles.chave}>Página</Text>
                <Text style={styles.valor}>{a.extra}</Text>
              </View>
            )}
            <View style={styles.linha}>
              <Text style={styles.chave}>Login</Text>
              <Text style={styles.valor}>{a.login ?? "—"}</Text>
            </View>
            <View style={styles.linha}>
              <Text style={styles.chave}>Senha</Text>
              <Text style={styles.valor}>{a.senha ?? "—"}</Text>
            </View>
          </View>
        ))}
        <Text style={styles.aviso}>
          Guarde este documento em lugar seguro e não o envie por e-mail ou grupo. Ao trocar uma senha, avise a agência para
          atualizarmos o cofre.
        </Text>
        <Text style={styles.rodape} fixed>
          Documento confidencial · {cliente}
        </Text>
      </Page>
    </Document>
  );
}

export async function renderRelatorioDeAcessos(p: { cliente: string; agencia: string; geradoEm: string; acessos: AcessoDoRelatorio[] }): Promise<Buffer> {
  return (await renderToBuffer(<Relatorio {...p} />)) as Buffer;
}
