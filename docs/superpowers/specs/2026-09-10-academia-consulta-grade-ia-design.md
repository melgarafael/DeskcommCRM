# Academia · consulta da grade pela IA — design

> Data: 2026-09-10 · Branch: `feature/academia-grade` (base atualizada com
> `origin/main` no merge `82c17cef`)
> Origem: teste real no piloto local. O cliente pediu CrossFit na segunda-feira
> pela manhã; a grade tinha a resposta, mas o agente repetiu que iria consultar.

---

## 1. Resultado contratado

O agente passa a consultar a grade semanal da organização por uma ferramenta
estruturada e responde imediatamente os fatos cadastrados: modalidade, público,
dia, início, duração, professor e ambiente.

Para a grade atual da Konnen, a sequência “Quero saber os horários do Cross fit”
→ “Pela manhã” → “Segunda feira” deve produzir uma resposta equivalente a:

> Na grade regular, o CrossFit de segunda-feira pela manhã é às 08:00, dura 60
> minutos e acontece no Box. O professor está como “A definir”.

“Equivalente” preserva os fatos, não a redação literal. A resposta não pergunta
idade, outros dias, vaga ou aula experimental quando modalidade, dia e período
já bastam para encontrar a aula.

Quando um campo solicitado estiver pendente, o agente responde primeiro tudo que
está confirmado e encaminha somente a parte pendente. Exemplo: se a pessoa só
perguntou o horário, “A definir” no professor não impede responder 08:00; se ela
perguntar quem ministra, a IA informa que o professor ainda não foi definido e
transfere para a equipe.

## 2. Estado confirmado e causa raiz

A migration 0235 e `app/api/v1/academia/schedule` entregaram uma grade semanal
editável, tenant-aware e sem ocorrências datadas. A instalação local contém 110
aulas ativas. O CrossFit de segunda pela manhã existe às 08:00, com 60 minutos,
público Adulto, professor “A definir” e ambiente Box.

Hoje somente a tela lê `academia_weekly_classes`. O catálogo MCP não contém uma
ferramenta de Academia, o agente publicado não tem essa capacidade em `tool_ids`
e não há fonte RAG configurada no piloto. O prompt manda consultar a grade, mas o
runtime não oferece uma operação que execute a consulta. Portanto a falha não é
cadastro nem latência do modelo: é uma capacidade ausente.

## 3. Alternativas consideradas

### A. Ferramenta estruturada sobre o banco — escolhida

Consulta os registros vigentes em cada pergunta. É a fonte mais rápida e precisa,
preserva filtros por organização e não precisa reindexar conteúdo após editar a
grade.

### B. Copiar a grade para o RAG — adiada como apoio

Ajuda em perguntas narrativas, mas um índice pode ficar defasado e similaridade
semântica não é uma boa autoridade para dia, hora ou professor. Entra futuramente
como resumo derivado, nunca como fonte de confirmação.

### C. Injetar a grade inteira no prompt — recusada

Repetiria 110 aulas em todos os turnos, aumentando tokens, latência e ruído. Também
criaria outra projeção sem mecanismo próprio de atualização.

## 4. Fronteira da Etapa 5A

### Dentro do escopo

- Uma tool read-only chamada `crm_find_academia_classes`.
- Consulta da grade semanal regular por modalidade, alias, público, dia e período.
- Resultado com horário, duração, professor, ambiente e pendências reconhecidas.
- Gate do módulo Academia no handler da tool.
- Filtro explícito de `organization_id` em toda leitura feita com service role.
- Catálogo da capacidade e habilitação no agente publicado do piloto.
- Instrução residente e gate determinístico contra “vou consultar/verificar a
  grade” sem execução da ferramenta.
- Teste do diálogo real e prova pela interface/conversa do piloto.

### Fora do escopo

- Reserva, vaga, matrícula, cobrança, presença ou aula experimental.
- Planos e preços.
- Funcionamento geral da academia.
- Cancelamento, aula extra, alteração de ocorrência ou série futura.
- Confirmar uma aula em data civil específica.
- Calendário de feriados.
- Sincronização da grade com o RAG.

Esses itens continuam nas etapas já aprovadas do roadmap. A IA não oferece
capacidade fora do MVP só porque a conversa menciona “disponibilidade”.

## 5. Contrato da ferramenta

### 5.1 Identidade e autorização

```ts
name: "crm_find_academia_classes"
category: "read"
requiresRole: "agent"
requiresScope: "mcp:read"
```

A tool só aparece para um agente cuja versão publicada contenha esse nome em
`tool_ids`. O handler recebe a organização de `McpContext`; nenhum campo de input
aceita tenant. Antes das tabelas da grade, ele lê `organizations.settings` pela
mesma `organization_id` e recusa quando `modules.academia !== true`.

No catálogo humano, a capacidade entra no pacote `vender`, junto das ferramentas
de agenda. A pessoa ainda pode ligá-la individualmente no modo avançado. Não nasce
habilitada em agentes de empresas sem o módulo.

### 5.2 Entrada

```ts
const inputShape = {
  modalidade: z.string().trim().min(1).max(120),
  dia_semana: z.number().int().min(1).max(7).optional(),
  periodo: z.enum(["manha", "tarde", "noite"]).optional(),
  publico: z.string().trim().min(1).max(120).optional(),
  limite: z.number().int().min(1).max(20).optional().default(10),
};
```

`dia_semana` usa ISO: 1 segunda-feira, 7 domingo. O modelo passa o texto que a
pessoa usou em `modalidade` e `publico`; não inventa UUID.

Uma data civil, “amanhã”, “próxima segunda” ou outro pedido sobre uma ocorrência
real não é convertido silenciosamente em grade semanal. Enquanto exceções e
feriados não existirem, o agente informa que só possui a grade regular e transfere
a confirmação daquela data para a equipe. Nesse caso, não usa o resultado semanal
como confirmação da ocorrência; chama a ferramenta de handoff disponível no turno.

### 5.3 Períodos

O período é decidido pelo início da aula, na hora local cadastrada:

| Período | Intervalo |
|---|---|
| `manha` | `00:00 <= início < 12:00` |
| `tarde` | `12:00 <= início < 18:00` |
| `noite` | `18:00 <= início <= 23:59` |

Uma aula que começa às 17:30 e termina às 18:30 pertence à tarde. Não se usa o
horário de funcionamento como substituto da grade.

### 5.4 Resolução de modalidade e público

A normalização é determinística: Unicode NFD sem marcas, minúsculas, pontuação
convertida em espaço e espaços repetidos colapsados. Primeiro compara o nome
canônico; depois compara cada alias cadastrado.

Assim, `Cross fit` encontra o alias de `CrossFit`, e `Spinning` encontra a
modalidade canônica `Ciclismo` desta organização. Não há fuzzy match nesta etapa:
aproximação pode escolher a modalidade errada em silêncio.

Se nenhum nome/alias casar, o retorno diz `modalidade_nao_encontrada` e não afirma
que não existem aulas. Se mais de uma modalidade casar o mesmo alias, retorna
`modalidade_ambigua` com os nomes canônicos para o agente perguntar qual delas a
pessoa quis.

`publico`, quando informado, segue a mesma normalização, mas somente contra o nome
canônico: públicos ainda não possuem aliases no schema. Sem público, a consulta
devolve todos os públicos correspondentes e o agente só pergunta qual deles se a
diferença mudar a resposta.

### 5.5 Saída

```ts
type AcademiaClassSearchResult = {
  tipo_grade: "semanal_regular";
  modalidade: string;
  filtros: {
    dia_semana?: number;
    periodo?: "manha" | "tarde" | "noite";
    publico?: string;
  };
  aulas: Array<{
    dia_semana: number;
    dia: string;
    inicio: string;
    fim: string;
    duracao_minutos: number;
    publico: string;
    professor: string;
    ambiente: string;
    pendencias?: string[];
  }>;
  total: number;
  ha_mais: boolean;
  mensagem?: string;
};
```

Nenhum UUID, nome de tabela ou vocabulário interno chega ao modelo. `fim` é
calculado pelo mesmo contrato da tela. A ordenação é dia, início, público,
professor e id; o id só desempata e não sai no resultado.

As observações livres da grade não saem nesta etapa. A carga atual usa esse campo
para capacidade nominal, que não comprova vaga disponível; expô-lo ao modelo
criaria justamente a inferência proibida de disponibilidade.

Nesta etapa, o marcador confirmado de professor pendente é o nome normalizado
`a definir`, presente na carga aprovada do piloto. Ele gera
`pendencias: ["professor"]`. Outros nomes não são inferidos como pendência.

Se a lista for vazia depois de uma modalidade válida, a ferramenta diz que não
há aula correspondente na grade semanal regular. Não diz “lotado”, “sem vaga” ou
“cancelado”, porque a tabela não representa nenhuma dessas coisas.

## 6. Fluxo de dados

```text
Mensagem do cliente
  → runtime identifica pergunta sobre grade
  → crm_find_academia_classes
  → confirma módulo na organização
  → resolve modalidade/alias e público dentro da organização
  → filtra academia_weekly_classes ativa
  → busca nomes dos quatro vínculos com organization_id explícito
  → projeta apenas fatos próprios para o cliente
  → modelo responde pela tool send_message
  → before-send confirma que a consulta ocorreu neste turno
```

O handler nunca chama a API HTTP da tela. Tela e tool compartilham funções puras
de normalização, período e projeção; cada borda conserva sua própria autorização.

## 7. Comportamento do agente e anti-evasão

Quando `crm_find_academia_classes` estiver em `tool_ids`, um bloco residente do
system prompt manda:

- chamar a ferramenta antes de informar qualquer horário de aula;
- não pedir novamente modalidade, dia ou período já presentes no histórico;
- distinguir grade regular de ocorrência em data específica;
- responder os fatos conhecidos antes de tratar uma pendência;
- não transformar grade em disponibilidade, vaga ou reserva.

Instrução textual não é garantia. O runtime marca a execução real da tool no
turno, como já faz para Agenda. Um gate próprio veta quando a capacidade está
publicada, as seis mensagens mais recentes contêm sinal de grade e a tool ainda
não foi executada neste turno:

- “vou consultar/verificar a grade e retorno” e variações medidas;
- afirmação de horário de aula com hora explícita como se viesse da grade.

O veto volta ao modelo com uma ação concreta: chamar a tool ou, se o pedido for
uma data específica/feriado, chamar a ferramenta de handoff disponível no turno.
Essa combinação evita atingir assuntos sem relação, como rastreio ou outra consulta
genérica. O gate não é ativado para agentes sem a capacidade e não reaproveita
`agendaStallGate`: compromisso individual e grade de aulas são domínios
diferentes.

Falha técnica da tool nunca vira promessa vazia. O agente chama
a ferramenta de handoff disponível no turno, avisa em linguagem simples que a
equipe confirmará e encerra o turno. O nome interno pode diferir entre a borda MCP
e o runtime do agente; a implementação reutiliza a capacidade canônica já
registrada em cada uma, sem criar um segundo tipo de handoff.

## 8. Segurança, consistência e custo

- Service role filtra `organization_id` na organização, modalidade, público,
  grade, professores e ambientes.
- O módulo desligado falha fechado antes de devolver qualquer catálogo.
- Somente linhas ativas são candidatas; vínculos históricos inativos não voltam
  como oferta atual.
- A ferramenta é read-only e não cria audit de mutação. O servidor MCP continua
  registrando `mcp.tool_called`, sucesso, duração e resumo sem conteúdo sensível.
- A consulta busca no banco só a modalidade/dia/faixa necessários e limita a
  projeção a 20 aulas. Não envia as 110 linhas ao modelo.
- Não há migration nesta etapa: o schema necessário já existe na 0235.

## 9. RAG futuro — derivação, não autoridade

Uma etapa posterior poderá gerar um resumo da grade para melhorar perguntas
narrativas e descoberta semântica. Esse resumo terá:

- origem `academia_weekly_classes` declarada;
- `organization_id`, revisão e instante de geração;
- regeneração após cada alteração bem-sucedida da grade;
- reconciliação periódica para recuperar evento perdido;
- substituição atômica da versão anterior, sem acumular versões concorrentes.

Mesmo depois disso, horário, professor, ambiente e ocorrência continuam sendo
confirmados pela tool direta. Se RAG e banco divergirem, o banco vence e a
divergência gera sinal operacional. Atualização apenas periódica foi recusada:
entre duas rodadas ela serve informação antiga.

Essa infraestrutura não será criada na Etapa 5A; o contrato acima impede que a
implementação atual feche a porta para ela.

## 10. Observabilidade e laço de retorno

Entrada: mensagem sobre aula. Saída: resposta WhatsApp com fatos da grade.
Atividade: `mcp.tool_called` com nome da capacidade, sucesso e duração. Porta de
configuração: editor do agente, em capacidades. Anti-morte: gate determinístico
impede promessa de consulta sem consulta. Laço de retorno: erro/ausência/pendência
muda o próximo ato para pergunta objetiva ou handoff, em vez de repetir a mesma
frase.

O mapa vivo de Academia ganhará as arestas agente → tool → grade → resposta e a
rota alternativa tool → handoff. A documentação de arquitetura deixa explícito
que a tela não é a fonte consumida pelo agente.

## 11. Provas de aceite

### Unidade

- Normalização encontra `Cross fit`/`Cross` e `Spinning` pelos aliases.
- Alias inexistente e alias ambíguo não escolhem modalidade.
- Manhã, tarde e noite respeitam exatamente as fronteiras aprovadas.
- Resultado calcula fim, ordena deterministicamente e não expõe UUID.
- Resultado não expõe observações livres nem capacidade nominal.
- “A definir” preserva a aula e marca somente professor como pendente.
- Gate veta as frases reais “vou consultar a grade” sem execução da tool.

### API interna/MCP

- Tool aparece 1:1 no catálogo e no handler agregado.
- Módulo desligado recusa.
- Toda leitura usa `ctx.organizationId`, nunca input.
- Outra organização com nomes iguais não aparece.
- Grade vazia, modalidade ausente, alias ambíguo e falha de banco retornam
  condutas distintas.

### Banco

- Invariantes existentes da migration 0235 continuam verdes.
- Sonda com duas organizações prova que a consulta não cruza tenant mesmo usando
  service role.
- Nenhuma tabela, grant ou função nova é criada.

### Jornada visível

- Agente do piloto recebe a nova capacidade em uma versão publicada.
- A conversa real “Cross fit” → “pela manhã” → “segunda feira” responde 08:00,
  60 minutos e Box sem nova pergunta.
- Perguntar depois “quem dá essa aula?” informa a pendência e transfere.
- “Tem CrossFit na próxima segunda?” não confirma a ocorrência pela grade regular:
  explica o limite e transfere a confirmação da data.
- A resposta não contém “vou verificar”, vaga, reserva ou aula experimental.
- Evidência da conversa e trace da tool ficam na pasta de evidência sem telefone,
  e-mail ou outro dado real do contato.

## 12. Publicação e retorno

A mudança de produto traz fragmento em `.changes/`. A branch passa pelos gates
de tipo, lint, unidade e banco; a jornada visível usa o ambiente local já ativo.
Como não há schema novo, o retorno de código é voltar a imagem/commit anterior.
A versão publicada do agente também terá uma versão anterior preservada para
rollback pelo fluxo existente — não se edita versão publicada no lugar.

Não haverá envio para um contato real diferente do número de teste autorizado.
Ativação no piloto ocorre somente depois das provas automatizadas e da revisão
da nova versão do agente.
