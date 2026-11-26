'use strict';
const get = id => document.getElementById(id);
const history = [];
let providers = [], proposal, busy = false, writable = false;

async function api(route, data) {
  const headers = { Authorization: 'Bearer ' + get('token').value.trim() };
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(route, { headers, method: data === undefined ? 'GET' : 'POST',
    body: data === undefined ? undefined : JSON.stringify(data) });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'HTTP ' + response.status);
  }
  return response.json();
}

function buttons() {
  for (const id of ['detect','download','clear','discard','token','question']) get(id).disabled = busy;
  get('provider').disabled = busy || !providers.length;
  get('model').disabled = busy || !get('model').value;
  get('send').disabled = busy || !get('model').value;
  get('apply').disabled = busy || !proposal || !writable;
}
async function run(task) {
  if (busy) return;
  busy = true;
  buttons();
  get('status').textContent = '';
  try { await task(); }
  catch (error) { get('status').textContent = error.message; }
  finally { busy = false; buttons(); }
}
function addMessage(role, content) {
  const card = document.createElement('article');
  const title = document.createElement('strong');
  const text = document.createElement('p');
  title.textContent = role === 'user' ? 'Вы' : 'Помощник';
  text.textContent = content;
  card.append(title,text);
  get('history').append(card);
}
function displayProposal(value) {
  proposal = value;
  get('proposal').hidden = !value;
  get('diff').textContent = value ? JSON.stringify({
    'Операция': value.operation, 'Карточка': value.personId, 'Было': value.before, 'Будет': value.after
  }, null, 2) : '';
}
function modelList() {
  const entry = providers.find(p => p.id === get('provider').value);
  get('model').replaceChildren(...(entry?.models || []).map(id => new Option(id,id)));
  buttons();
}
get('provider').addEventListener('change', modelList);
get('detect').addEventListener('click', () => run(async () => {
  providers = [];
  get('provider').replaceChildren();
  modelList();
  get('providers').textContent = 'Проверяем локальные серверы…';
  try {
    const [states, status] = await Promise.all([api('/api/models'), api('/api/tool', { name: 'family_tree_status' })]);
    writable = status.writable;
    get('providers').textContent = states.map(p =>
      p.name + ' — ' + (p.connected ? (p.models.length ? 'моделей: ' + p.models.length : 'модели отсутствуют') : p.message)
    ).join(' · ');
    providers = states.filter(p => p.connected && p.models.length);
    get('provider').replaceChildren(...providers.map(p => new Option(p.name,p.id)));
    modelList();
    if (!writable) get('status').textContent = 'Запись отключена. Доступны чтение и предпросмотр.';
  } catch (error) {
    get('providers').textContent = '';
    throw error;
  }
}));
get('chat').addEventListener('submit', event => {
  event.preventDefault();
  const content = get('question').value.trim();
  if (!content || !get('model').value) return;
  run(async () => {
    get('status').textContent = 'Модель готовит ответ…';
    const prompt = { role: 'user', content };
    const reply = await api('/api/chat', {
      provider: get('provider').value, model: get('model').value, messages: [...history.slice(-18), prompt]
    });
    const answer = { role: 'assistant', content: reply.answer };
    history.push(prompt, { ...answer, content: answer.content.slice(0, 8000) });
    for (const message of [prompt, answer]) addMessage(message.role, message.content);
    get('question').value = '';
    if (reply.proposal) displayProposal(reply.proposal);
    get('status').textContent = '';
  });
});
get('apply').addEventListener('click', () => run(async () => {
  const result = await api('/api/tool', {
    name: 'family_tree_apply', arguments: { revision: proposal.revision, change: proposal.change }
  });
  displayProposal(undefined);
  const note = 'Правка сохранена.' + (result.createdId ? ' ID новой карточки ' + result.createdId + '.' : '');
  const message = { role: 'assistant', content: note };
  history.push(message);
  addMessage(message.role, message.content);
  get('status').textContent = 'Обновлённый JSON доступен для загрузки в редактор.';
}));
get('discard').addEventListener('click', () => { displayProposal(undefined); buttons(); });
get('clear').addEventListener('click', () => {
  history.length = 0;
  get('history').replaceChildren();
  displayProposal(undefined);
  buttons();
});
get('download').addEventListener('click', () => run(async () => {
  const tree = await api('/api/tree');
  const target = document.createElement('a');
  target.href = URL.createObjectURL(new Blob([JSON.stringify(tree, null, 2)], { type: 'application/json' }));
  target.download = 'tree_mcp.json';
  target.click();
  setTimeout(() => URL.revokeObjectURL(target.href), 1000);
}));
