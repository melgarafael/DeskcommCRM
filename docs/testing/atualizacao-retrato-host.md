# Idade da última conferência na tela de atualização

A informação de versão vem do último heartbeat gravado em `system_version`.
Mais de 30 minutos sem nova informação torna esse retrato antigo. A resposta
do dono em `GET /api/v1/system/version` leva `agent_stale` e
`agent_last_seen_at`; o limite de 24 horas de `agent_online` permanece separado.
No instante exato dos 30 minutos o retrato ainda é recente; um milissegundo
depois passa a antigo.

Quando esse retrato não anuncia atualização, o painel informa a hora da última
conferência e orienta verificar a conexão do servidor. Esse estado intermediário
não acrescenta comando manual. O ramo existente de agente offline continua
oferecendo esse caminho. Uma versão nova já anunciada continua com o botão
«Atualizar agora», mesmo quando o retrato ficou antigo.

## Prova preparada

O caso «retrato antigo informa a última conferência sem antecipar o comando
manual», em `tests/e2e/system-update.spec.ts`, usa o dono sintético existente,
login com MFA e heartbeat pelo endpoint real. Só a idade da linha sintética é
preparada diretamente no banco local da suíte; a rota de leitura, o hook e o
painel não recebem mocks. O caso confere quatro estados:

1. Heartbeat recente permite afirmar que a versão é a mais recente.
2. Retrato de 31 minutos mostra a última conferência e orientação de conexão,
   sem comando manual nem afirmação de que está em dia.
3. Retrato de 31 minutos com versão nova anunciada mantém «Atualizar agora».
4. Agente sem notícia há 25 horas mantém o aviso existente e o comando manual.

Screenshots dos estados antigo e offline são gravadas em
`evidence/retrato-host-3504/` e anexadas ao resultado do teste. Os arquivos novos
desse diretório entram na coleta existente do CI também quando o caso passa.
A fixture restaura um heartbeat recente no `finally`, inclusive quando alguma
asserção falha. A fronteira exata de 30 minutos e a de 24 horas são medidas no
teste unitário da rota, com relógio controlado.

**Estado:** prova de tela preparada; ainda sem execução deste caso no CI.
Os testes dirigidos de componente e rota não são prova de UX. O E2E prepara o
silêncio do host e não exercita o cron, DNS nem o bash do agente numa VPS.

## Integração

Destino: núcleo. A atualização da instalação é operação comum mesmo sem
extensões ativas. O fluxo existente alimenta o painel a partir de
`system_version` e volta a lê-lo a cada cinco segundos enquanto a tela está
aberta; uma batida nova encerra o aviso. A leitura não cria mutação nem nova
atividade de auditoria. A porta e a identidade do dono continuam as existentes.
O retorno desta correção é o próximo heartbeat, consumido pela mesma rota e
pelo painel; não há aprendizado automático nem configuração nova. O mapa
`docs/architecture/atualizacao-self-service.architecture.json` registra a idade
na ligação já existente entre o banco, a rota e a tela.

Implementação original de @webtecnica no PR #3504, preservada na ancestralidade
da adaptação.
