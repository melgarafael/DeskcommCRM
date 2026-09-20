const stages = [
  {label:'01 / ATENÇÃO', title:['Chegou interesse.','Encontre espaço.'], copy:'Quem chama quer ser ouvido. Acolha a primeira dúvida e descubra o que a pessoa realmente procura.', question:'Oi! Vocês têm horário esta semana?', answer:'Oi, Marina! Vamos encontrar um horário para você. Prefere de manhã ou à tarde?', result:'Primeiro contato acolhido'},
  {label:'02 / CONTEXTO', title:['Cada pessoa,','um bom motivo.'], copy:'Uma conversa que entende a necessidade aproxima. Sua equipe recebe o contexto para continuar sem fazer a pessoa repetir tudo.', question:'À tarde. Quero entender qual opção faz sentido para mim.', answer:'Claro! Me conta o que você está buscando. Assim, nossa equipe pode orientar você com mais cuidado.', result:'Necessidade em conversa'},
  {label:'03 / PRÓXIMO PASSO', title:['Do interesse','ao encontro.'], copy:'Dê continuidade ao que começou bem. Combine o próximo passo e mantenha a oportunidade perto de quem pode ajudar.', question:'Gostei! Podemos conversar na quinta?', answer:'Vamos combinar! Vou passar seu interesse para nossa equipe confirmar o melhor horário com você.', result:'Próximo passo encaminhado'}
];
const title = document.getElementById('step-title');
const bubbles = document.getElementById('bubbles');
document.querySelectorAll('[data-stage]').forEach(button => {
  button.addEventListener('click', () => {
    const stage = stages[Number(button.dataset.stage)];
    if (!stage) return;
    document.querySelectorAll('[data-stage]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    document.getElementById('step-number').textContent = stage.label;
    title.replaceChildren(document.createTextNode(stage.title[0]), document.createElement('br'), document.createTextNode(stage.title[1]));
    document.getElementById('step-copy').textContent = stage.copy;
    const customer = document.createElement('p'); customer.className = 'bubble customer'; customer.textContent = stage.question;
    const reply = document.createElement('p'); reply.className = 'bubble reply'; reply.textContent = stage.answer;
    const time = document.createElement('small'); time.textContent = '09:41 · Assistente de IA'; reply.append(time);
    const result = document.createElement('div'); result.className = 'result-tag';
    const dot = document.createElement('span'); dot.className = 'dot'; result.append(dot, document.createTextNode(stage.result));
    bubbles.replaceChildren(customer, reply, result);
    document.dispatchEvent(new Event('conversation-change'));
  });
});
const film = document.getElementById('film');
const video = film.querySelector('video');
document.querySelectorAll('[data-film]').forEach(button => button.addEventListener('click', () => {
  film.showModal();
  document.dispatchEvent(new Event('film-open'));
  video.play().catch(() => { /* Native controls remain available if playback needs another gesture. */ });
}));
document.getElementById('close-film').addEventListener('click', () => film.close());
film.addEventListener('close', () => video.pause());
film.addEventListener('click', event => { if(event.target === film) {const box = film.getBoundingClientRect(); if(event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) film.close();} });
