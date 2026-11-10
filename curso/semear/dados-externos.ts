/**
 * Semente do módulo "Dados externos" (/app/integracao-dados).
 *
 * A tela só existe com o recurso opcional "Banco de dados externo" ligado NA
 * INSTALAÇÃO, e a base devolve a instalação ao estado de fábrica antes de cada
 * lição — então ligamos aqui, pela mesma linha que `gravarModulo`
 * (lib/instalacao/modulos.ts) grava.
 *
 * Duas conexões de exemplo, apontando para endereços da rede local que não
 * respondem: o "Testar" da lição é REAL (espera 5 s e grava a falha), sem fingir
 * um banco conectado. A senha é cifrada como `cifrarSenha`
 * (lib/external-db/credenciais.ts) cifra, com a mesma AI_CRED_AES_KEY do app —
 * sem isso o teste pararia em "chave indisponível" antes de tentar a rede.
 */
import { createCipheriv, randomBytes } from "node:crypto";

import { type Contexto, semErro } from "../semear-demonstracao";

const id = (n: number) => `de100000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ROTULOS = ["Sistema de agendamentos", "Cadastro de convênios"];

const bytea = (b: Buffer) => `\\x${b.toString("hex")}`;
function cifrar(senha: string) {
  const chave = Buffer.from(process.env.AI_CRED_AES_KEY ?? "", "base64");
  if (chave.length !== 32) throw new Error("dados-externos: AI_CRED_AES_KEY ausente ou sem 32 bytes (o .env.e2e tem)");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", chave, iv);
  const cifrado = Buffer.concat([c.update(senha, "utf8"), c.final()]);
  return { password_encrypted: bytea(cifrado), password_iv: bytea(iv), password_tag: bytea(c.getAuthTag()) };
}

export async function semear(c: Contexto) {
  const { db, org, pessoa } = c;
  semErro(
    await db.from("platform_config").upsert(
      { chave: "MODULO_BANCO_EXTERNO", valor: "ligado", eh_segredo: false, semeado_do_env: false, updated_by: pessoa.helena },
      { onConflict: "chave" },
    ),
    "ligar o módulo Banco de dados externo",
  );

  semErro(await db.from("external_db_connections").delete().eq("organization_id", org).in("id", [id(1), id(2)]), "limpar conexões");
  semErro(await db.from("external_db_connections").delete().eq("organization_id", org).in("label", ROTULOS), "limpar conexões por nome");

  semErro(
    await db.from("external_db_connections").insert([
      {
        // recém-cadastrada: nunca testada, nada liberado, sem coluna do cliente — os avisos que a lição ensina
        id: id(1), organization_id: org, db_type: "postgres", label: "Sistema de agendamentos",
        host: "192.168.0.50", port: 5432, database_name: "agenda", username: "crm_leitura", ...cifrar("Agenda#Leitura2026"),
        ssl_mode: "require", enabled: true, source_mode: "list", sources: [], created_by: pessoa.helena,
      },
      {
        // já configurada e depois desativada: duas tabelas liberadas, cliente pelo telefone
        id: id(2), organization_id: org, db_type: "mysql", label: "Cadastro de convênios",
        host: "192.168.0.60", port: 3306, database_name: "convenios", username: "crm_leitura", ...cifrar("Convenios#Leitura2026"),
        ssl_mode: "require", enabled: false, source_mode: "list", created_by: pessoa.helena,
        customer_key_kind: "phone", customer_key_column: "telefone",
        sources: [
          { schema: "convenios", tabela: "planos_pacientes", colunas: ["telefone", "convenio", "plano", "validade_carteirinha"], descricao: "Convênio e plano de cada paciente, com a validade da carteirinha" },
          { schema: "convenios", tabela: "guias_autorizadas", colunas: ["telefone", "convenio", "procedimento", "situacao"], descricao: "Guias pedidas ao convênio e se já foram autorizadas" },
        ],
      },
    ]),
    "conexões de exemplo",
  );
}
