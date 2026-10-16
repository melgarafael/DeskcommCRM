# Servidor MCP externo (#2147)

A organização pode registrar **um servidor MCP externo** (um ERP, um sistema de
estoque, qualquer coisa que fale o protocolo MCP por Streamable HTTP) e cada
agente de IA escolhe quais ferramentas dele pode usar. O código mora em
`lib/mcp/servidor-externo/`; a explicação de cada decisão está no cabeçalho de
cada arquivo.

## Como funciona

| Peça | Onde |
|---|---|
| **Registro** — endereço em `organizations.settings.mcp_externo`, chave cifrada nas colunas `mcp_externo_chave_*`. Só quem administra a instalação grava. | `app/actions/settings/definirServidorMcpExterno.ts` |
| **Escolha por agente** — ids `mcp_externo:<leitura\|escrita>:<nome>` no `tool_ids` da versão. Sem escolha, nada abre rede. | `lib/mcp/servidor-externo/ids.ts` |
| **Chamada** — cliente MCP do SDK, chave `Authorization: Bearer` em toda requisição, saída pelo guard anti-SSRF dos webhooks. | `lib/mcp/servidor-externo/chamada.ts` |
| **Carga no turno** — lê o registro, descobre as ferramentas, decide se o turno ganha servidor. | `lib/mcp/servidor-externo/carregar.ts` |

Toda chamada remota passa pelo mesmo `wrapMcpTool` das ferramentas do
produto e fica em `api_audit_log` com `action = 'mcp.tool_called'`.

## Uso durante o atendimento

Por padrão, um turno de **atendimento** (conversa com um cliente) **não**
carrega o servidor externo: o servidor não saberia de qual cliente é a
conversa, e o modelo poderia pedir dado de outra pessoa.

Quem é **admin** pode ligar, por agente, a opção **"Usar o servidor de
ferramentas externo durante o atendimento"** (tela do agente; grava
`ai_agents.config.mcp_externo_no_atendimento`, desligada de fábrica). Ligada,
toda requisição ao servidor naquele turno — listar e chamar ferramentas — leva
três cabeçalhos que o Deskcomm monta a partir do banco, nunca a partir do que
o modelo escreve:

| Cabeçalho | Valor |
|---|---|
| `X-Deskcomm-Contato-Id` | id (uuid) do contato da conversa |
| `X-Deskcomm-Contato-Telefone` | telefone do contato em dígitos E.164, sem `+` (ex.: `5511987654321`). Ausente se o contato não tem telefone. |
| `X-Deskcomm-Canal` | canal da conversa do turno (ex.: `whatsapp`, `instagram`); ausente quando o turno não a informa |

**O servidor externo DEVE filtrar os dados por esses cabeçalhos e ignorar
qualquer identificador que venha da conversa** (argumentos da ferramenta como
"meu número é ..."). Os argumentos da ferramenta viajam só no corpo da
chamada: eles não sobrescrevem, removem nem acrescentam cabeçalho, e os nomes
`X-Deskcomm-*` são reservados ao Deskcomm. A autenticação continua sendo a
chave do cadastro (`Authorization: Bearer`).

Se o contato não puder ser confirmado no banco naquele turno, o servidor fica
fora do turno. Cada chamada feita em atendimento fica auditada com o
`contact_id` da conversa (`metadata.contact_id`). Ferramentas marcadas como
**escrita** continuam recusadas durante a conversa, com ou sem a opção.
