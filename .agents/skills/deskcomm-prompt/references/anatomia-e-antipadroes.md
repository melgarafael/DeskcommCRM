# Anatomia do prompt final — e os anti-padrões medidos no código

## O que o motor monta a cada resposta (v1.17.0)

**Sistema (estável, em cache):** regras de compliance da plataforma (apresentar-se como assistente
virtual, não fingir humano, não pedir dado sensível, não inventar preço, mensagens curtas, emoji
com parcimônia) → **o prompt do agente** (a versão publicada) → memória da organização (documento
+ aprendizados ativos) → índice de skills → blocos fixos (nunca narrar problema interno; abrir caso
antes de prometer humano; nunca confirmar agenda sem usar a ferramenta).

**Usuário (por cliente, volátil):** checkpoint anterior (compromissos, objeções, próxima ação),
resumo acumulado, estado no funil, índice de notas, compromissos, contexto do lead, a mensagem
atual, "agora é…", corpo das skills que casaram por palavra-chave, dica do classificador de
etapa, dica de divisão de mensagem.

**Saída — onze portões, nesta ordem:** STOP, LGPD, ritmo de envio, janela de 24 h, cópia
repetida, promessa fora da tabela, promessa semântica, promessa sem caso aberto, vocabulário
interno, agenda sem ferramenta, aviso de IA. O veto volta ao modelo como erro de ensino — ele
tenta de novo; cada tentativa custa.

**Chamadas por turno:** ao menos duas (o turno e o checkpoint) com o **mesmo** sistema. Prompt
grande dobra o custo. Temperatura, comprimento e idioma **não** são botões por agente — é texto.

## O que o prompt controla

Persona e contexto do negócio; diagnóstico antes da oferta; qualificação; o que dizer em cada
situação; quando usar uma capacidade (pelo que ela faz, nunca pelo nome); limites por situação;
tom, tamanho, uma pergunta por vez; o que registrar para o retorno.

## Anti-padrões medidos (cada um tem um defeito real por trás)

| anti-padrão | o que acontece | o conserto |
|---|---|---|
| "Encaminhe ao gerente Fulano tudo que não souber" | o modelo responde "vou confirmar com o Fulano" **em vez de usar a agenda**; medido num agente real | limite só a situações que nenhuma capacidade cobre; nomeie situações, não pessoas |
| "USE as ferramentas", "chame `update_lead_state`", "mantenha a casa em ordem" | prompt na voz de operador vazou jargão em 30% dos turnos; na voz de atendimento, 0% — com as mesmas ferramentas | fale do que a capacidade faz ("ofereça horários", "consulte os materiais") |
| "lead", "etapa qualified", "webhook", "admin", "uuid" | veto de vocabulário interno; o prompt é a origem | vocabulário do cliente (paciente, consulta, pedido) |
| "não invente preço", "apresente-se como assistente", "respeite STOP", "não mande de madrugada" | já é portão; só gasta contexto | corte |
| "a equipe vai verificar e retorna" sem abrir caso | veto de promessa sem caso | "se precisar de uma pessoa, abra um caso e diga que alguém retorna" (o motor exige o caso) |
| desconto ou prazo no prompt acima da tabela de promessas | veto de promessa | alinhe com a tabela; sem tabela, o portão não age — crie a tabela |
| preço e prazo em texto quando há catálogo/materiais | duas fontes de verdade; o modelo escolhe uma | "consulte os materiais antes de responder preço, prazo, política" |
| `{{nome}}`, `{{empresa}}` | o motor não substitui placeholders; injeta contexto por conta própria | texto direto |
| "resuma no fim", "leia o histórico antes de repetir a pergunta", "que dia é hoje" | já vem no contexto de cada turno | corte |
| um único bloco de 3 mil palavras | custo dobrado por turno, atenção diluída | mova conteúdo situacional para skills do produto (corpo só entra no assunto) |
| instruir "mover o lead" num agente sem funil na versão | capacidade que o agente não tem naquele turno | confira `pipeline_ids` e capacidades da versão antes de instruir |

## Checklist de revisão (marque cada linha com o trecho do prompt)

1. Identidade em uma frase: quem, para quem, o que o negócio faz.
2. Diagnóstico: 2-4 perguntas, uma por vez, antes de qualquer oferta.
3. Decisão: "se X, faça Y" para os 3-5 caminhos mais comuns.
4. Situações do nicho: objeção de preço, "vou pensar", fora do escopo, urgência.
5. Capacidades pelo que fazem; nenhuma pelo nome.
6. Limites por situação; passagem para humano por situação, não por pessoa.
7. Estilo: tamanho, uma pergunta, emoji.
8. Nada que seja portão do motor; nada com jargão; nada com placeholder.
9. Tamanho: cabe em uma tela? Se não, o que vai para skill do produto?

## Skills do produto — o lugar do conteúdo condicional

Um roteiro situacional (objeção de preço, reativação depois de 30 dias, agendamento) vira uma
skill da organização: índice sempre presente, corpo só quando a palavra-chave aparece. Corpo
curto e imperativo, palavras-chave em português sem acento (a normalização remove), no máximo
200 linhas. Skills de plataforma `agendamento` e `objecao-preco` já valem para todos.
