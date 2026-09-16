---
impacto: capacidade_nova
secao: adicionado
titulo: Agente mais robusto no catálogo, com coleta de dados e envio de fotos
---

Melhorias estruturais no atendimento por IA — todas observáveis por quem opera
a instalação, nenhuma exigindo edição de `.env`, compose ou arquivo à mão:

- **Catálogo (banco externo) robusto:** a ferramenta resolve a conexão e o
  schema sozinha — o modelo pode mandar `connection_id`/`schema` inventados sem
  derrubar a consulta; filtro sem `valor` é descartado e, quando nenhum registro
  casa, o catálogo é devolvido para a IA **ofertar opções próximas** em vez de
  dizer "não temos". Filtros de texto passam a ignorar espaços e caixa
  ("cb250" acha "CB 250").
- **Fotos:** o agente envia uma ou **várias** imagens em sequência (legenda só na
  primeira), inclusive a partir de URL externa do catálogo.
- **Coleta de dados do cliente:** nova ferramenta `save_client_data` e captura
  determinística de CPF/CNH/data de nascimento gravando no contato; o agente
  passa a saber o que já sabe e o que ainda falta perguntar, sem repetir.
- **Persona:** a camada de plataforma deixa de exigir apresentação como
  "assistente virtual" — a persona passa a ser definida pela organização.
- Correções: `crm_save_org_memory` volta a gravar; o agrupamento de mensagens
  passa a ter debounce real (uma rajada = um turno).
