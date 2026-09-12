# Tela a tela — a ordem que o sistema impõe, os campos e o que cada um faz

Os rótulos abaixo são os do menu **Agente de IA** (v1.17.0). Cada peça exige a anterior: o
schema recusa publicar agente sem número conectado e sem credencial validada; fluxo só roda
publicado; material só vale com indexação pronta.

## 1. Conexões — o número (pré-requisito de tudo)

O onboarding conecta por QR. Para conferir: **Conexões** → o número aparece com status *WORKING*.
Número novo em modo de teste (lista de telefones autorizados) fica assim até alguém liberar na
Central de avisos — o agente não responde a estranhos até lá. Proteção de envio (janela, ritmo,
aquecimento) fica no próprio número.

## 2. IA › Credenciais

**Adicionar** → provedor (Anthropic, OpenAI, Google, OpenRouter), um nome ("Chave principal") e a
chave. A validação roda em segundo plano contra o provedor; só credencial **validada** publica um
agente. Sem credencial, o agente pode usar a chave da instalação (a do `.env`) para Anthropic,
OpenAI e OpenRouter — Google só funciona como credencial daqui. A chave da OpenAI para áudio e
base de conhecimento entra aqui também.

## 3. IA › Provedores

Um modelo por **ponto de uso**: atendimento (precisa usar ferramentas), roteador (classificador —
um modelo barato basta), follow-up, transcrição de áudio, embeddings (fixo: `text-embedding-3-small`
da OpenAI). "Automático" usa o provedor padrão da organização. É aqui que se troca de provedor
depois da instalação.

## 4. Funil — Configurações › Funis e Etapas do funil

Crie o funil com o nome do pacote; etapas na ordem, marcando exatamente uma como **ganhou** e uma
como **perdeu** (o sistema recusa duas). Em cada etapa, o **passo do agente** (novo, contatado,
qualificando, qualificado, negociando, ganhou, perdeu) — é o mapa que deixa o agente mover o lead;
etapa sem passo o agente não usa. Vocabulário (como chamar cliente/negócio/ganhou/perdeu) e
motivos de perda ficam na configuração do funil. O primeiro funil ativo vira o padrão.

## 5. IA › Conhecimento ("O que o agente sabe")

**Adicionar material** → tipo: *FAQ* (pares pergunta/resposta — cole em markdown com
`## Pergunta:` / `## Resposta:` ou preencha os pares), *documento* (PDF, MD ou TXT até 20 MB; ou
texto colado), *catálogo* (vem da loja integrada) e *conversas* (aprendizado automático). Nome
único por material. A indexação é assíncrona: o material aparece como "pronto" quando indexado;
sem chave da OpenAI ele fica sem indexar e a tela avisa. Materiais são da organização; cada agente
escolhe quais usa.

## 6. IA › Follow-ups ("Fluxos")

**Novo fluxo** → nome (único). No editor: **gatilho** (manual; silêncio por N minutos; mudança de
etapa; falta a compromisso; caso aberto; webhook) com *cancelar quando responder*; depois os nós:
**espera** (fixa, de 5 min a 90 dias, ou inteligente com mínimo/máximo), **mensagem** (texto,
gerada pela IA com uma orientação, ou modelo de mensagem), **condição** (etapa, tag, passos dados,
último desfecho), **classificar resposta** (até 8 classes, com carência mínima de 15 min), **fim**
(convertido, esgotado, personalizado). Política ao passar para humano: pausar, cancelar ou seguir.
**Publicar** valida o grafo (gatilho presente, nada inalcançável, caminho de fallback, ciclos só com
espera). Rascunho não roda.

## 7. IA › Agentes

**Novo agente** → aba **Configuração**: nome, descrição, prioridade (desempata quando dois agentes
publicados atendem o mesmo número); o **prompt**; provedor, modelo e credencial (ou "chave desta
instalação"); o **número** que atende; **funis** em que pode mover leads (nenhum = só conversa);
**materiais** que consulta; **follow-ups** que arma; palavras de passagem para humano (padrão:
"falar com humano", "atendente", "pessoa real"); casos (abrir demanda para o time); dividir
mensagens longas; horário de atendimento (fora dele, adia). Aba **Capacidades**: os pacotes
(*vender* já traz agenda, catálogo, conhecimento, notas e funil) e as capacidades **críticas**
uma a uma (enviar mensagem avulsa, cancelar agenda, fechar caso) — o teto é 25.

Salvar cria a **versão 1 em rascunho**. Mudou algo depois de publicado? É versão nova — versão
publicada é imutável, e **Reverter** cria outra a partir da anterior.

## 8. Testar (na versão, antes de publicar)

Aba de teste da versão: uma mensagem, um contato fictício. Volta o texto que o agente mandaria,
as ações que tentaria (oferecer horário, registrar, mover) e os portões que passaram ou vetaram.
Consome crédito da IA. Sem histórico nem memória do lead — é o teste da primeira mensagem.

## 9. Publicar

Botão **Publicar** com confirmação. O sistema recusa com motivo claro quando falta credencial
validada, o número não está WORKING, o modelo saiu do catálogo ou uma capacidade não existe. A
publicação vale no próximo atendimento, sem reiniciar nada.

## 10. IA › Roteadores (só com dois ou mais agentes no mesmo número)

**Novo roteador** → nome, **Número de WhatsApp** (só um roteador ativo por número). Depois,
**Intenções**: para cada uma, **Nome da intenção** ("quer agendar"), **Agente que atende**,
**Quando escolher esta intenção** (a descrição é o que o classificador lê — escreva como o cliente
fala) e **Frases de exemplo**. **Agente de fallback** para quando nenhuma casa; **Modelo do
classificador** ("Automático" usa o provedor da organização). Ative. Roteador sem intenções e sem
fallback não sequestra o número; membro sem versão publicada cai no fallback.

## 11. IA › Memória

**Documento da organização**: as regras da casa em texto corrido — **Publicar versão** (vale para
todos os agentes no próximo atendimento; só admin publica). **Aprendizados**: itens curtos com
**Título** e **O que o agente deve saber**; os "aprendidos automaticamente" vêm das propostas de
melhoria e ficam para revisar.

## 12. IA › Skills

As duas da plataforma (`agendamento`, `objecao-preco`) já valem para todo agente. **Instalar** cria
uma cópia da organização para personalizar; **Importar** aceita um `.zip` com `SKILL.md` (nome,
descrição, palavras-chave que ativam) — é um roteiro condicional de texto, não um programa.

## 13. Depois

Configurações › Webhooks e automações (formulário do site → funil → mensagem da IA); Equipe
(convites, papéis, distribuição manual ou rodízio); Uso e orçamento (teto mensal de IA). Tokens de
API só se um sistema externo for falar com o CRM pelo MCP.
