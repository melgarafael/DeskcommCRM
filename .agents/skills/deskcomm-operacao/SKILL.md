---
name: deskcomm-operacao
description: 'Guia de operação diária do DeskcommCRM para quem já tem o sistema instalado e precisa encontrar telas, entender fluxos, configurar recursos correntes e resolver dúvidas de uso sem mexer no código. Use quando alguém perguntar "onde fica", "como uso", "como configuro na tela", "o que este menu faz", "qual a ordem para operar", ou precisar de um mapa do produto entre Inbox, CRM, IA, Canais, Análise e Organização. Encaminha instalação, cliente novo, prompt, métricas e desenvolvimento para as skills específicas.'
metadata:
  publico: operador, gestor, implantador
  escopo: uso diário pela interface
---

# Operar o DeskcommCRM no dia a dia

Este guia é a porta de entrada para dúvidas de uso do produto depois que a instalação já está no ar.
Ele evita responder pela memória: localiza a área correta, consulta a documentação atual e encaminha
para uma skill especializada quando a pergunta deixar de ser operação cotidiana.

## Como agir

1. Identifique a intenção da pessoa antes de mandar comandos.
2. Prefira o caminho pela interface quando a tarefa existe na interface.
3. Diga o caminho como `Grupo → Tela → Ação`.
4. Explique o efeito da ação e os pré-requisitos.
5. Para comportamento que possa ter mudado, confirme em `README.md`, `docs/current-state.md`,
   `docs/index.md`, no `CHANGELOG.md` e no código atual.
6. Não invente campos, botões, estados ou permissões.
7. Não peça segredo em chat e nunca repita chaves/tokens na resposta.

## Quando usar outra skill

- Instalar, atualizar, VPS, domínio, Supabase, WhatsApp quebrado ou recuperação:
  `deskcomm-instalar`.
- Montar o CRM para um cliente/nicho, configurar agentes, roteadores, follow-ups e conhecimento:
  `deskcomm-cliente-novo`.
- O agente responde errado, escala demais ou não usa ferramentas:
  `deskcomm-prompt`.
- Conversão, desempenho, custo, funil e relatórios:
  `deskcomm-metricas`.
- Alterar/revisar código:
  `deskcomm-doutrina`.
- Abrir contribuição/PR:
  `deskcomm-contribuir`.
- Criar extensão/módulo de nicho:
  `deskcomm-extensao`.

Não duplique o procedimento especializado aqui; carregue a skill dona do assunto.

## Mapa da interface

Use `references/mapa-da-interface.md` para orientar perguntas como:
- "onde vejo conversas?"
- "onde altero o funil?"
- "onde configuro IA?"
- "onde conecto canais?"
- "onde vejo métricas?"
- "onde gerencio equipe e organização?"

## Como consultar na hora

O mapa acima envelhece; o comando abaixo pergunta ao menu e ao CHANGELOG na hora.
Caminhos relativos à pasta desta skill. Use `bash scripts/buscar.sh --menu` para
listar as telas atuais, e `bash scripts/buscar.sh <palavra>` para achar onde algo
mora (ex.: `buscar.sh pausar`, `buscar.sh videochamada`, `buscar.sh "planos de tarefa"`).
Pode digitar com ou sem acento: `prospecao` acha `Prospecção`.
O resultado do comando vale mais que o texto dos arquivos; se discordarem, siga o
comando e avise que o arquivo está desatualizado.

## Mapa de funcionalidades

Detalhe por área em `references/funcionalidades/` (uma linha do que há em cada um):
- `atendimento.md`: tela de conversa, agenda, radar e avisos que chegam a quem atende.
- `crm.md`: funil, contatos, empresas, tarefas, campanhas, produtos, propostas e chamadas.
- `ia.md`: agentes, follow-ups, fluxos, roteadores, conhecimento e supervisão.
- `canais.md`: conexões, Webhooks, integrações e proteções de envio.
- `analise.md`: desempenho, relatórios, faturamento e trilhas.
- `organizacao.md`: conta, empresa, equipe, acesso, LGPD e conversões.
- `admin-e-plataforma.md`: telas de `/admin` e o que só o dono da VPS vê ou configura.
- `so-api-ou-sem-tela.md`: o que só existe por rota, token, variável ou rotina, sem tela.
- `citado-e-nao-encontrado.md`: o que o CHANGELOG cita e não foi achado no menu nem no
  código; pode ter sido renomeado, movido ou removido — não afirme que existe.

Cada funcionalidade traz "desde <versão>" (a versão em que apareceu; a base 1.0.0 está incluída).

## Resposta padrão para "onde fica X?"

Responda nesta ordem:

1. **Caminho:** grupo → tela → ação.
2. **Serve para:** uma frase.
3. **Pré-requisito:** somente se existir.
4. **Depois disso:** o que muda/onde confirmar.
5. **Se não aparecer:** qual permissão, configuração ou estado verificar.

## Resposta padrão para "como faço X?"

1. Confirme o objetivo.
2. Liste apenas os passos necessários pela UI.
3. Aponte qualquer ação irreversível ou que publique/ative algo.
4. Diga como verificar que funcionou.
5. Se a tarefa exigir infraestrutura, código ou configuração de cliente, encaminhe à skill específica.

## Fonte de verdade

Precedência quando houver divergência:

1. o comando de busca (`bash scripts/buscar.sh`, relativo à pasta da skill);
2. `lib/navigation/catalogo.ts` (telas) e `CHANGELOG.md` (lançamentos);
3. código e estado atual do repositório;
4. documentação atual (`docs/current-state.md`, specs e runbooks);
5. skill especializada da área;
6. README e textos de ajuda.

Se dois lugares discordarem, explique a diferença e siga a fonte mais alta.
