const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createStore } = require('../mcp/tree.cjs');
const { createTools } = require('../mcp/tools.cjs');
const { webServer } = require('../mcp/server.cjs');
const { providers } = require('../mcp/llm.cjs');

function sample(t, writable = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'family-connector-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'working.json');
  const seed = path.join(directory, 'seed.json');
  const data = { mems: [
    { id: 'a', name: 'Алёна Мирова', birthDate: '1880', children: ['Иван Миров'], x: 20, y: 40 },
    { id: 'b', name: 'Иван Миров', mother: 'Алёна Мирова', x: 20, y: 440 },
    { id: 'c', name: 'Пётр Миров', x: 360, y: 40 },
    { id: 'd', name: 'Анна Мирова', x: 360, y: 440 }
  ], groups: [], marriages: [], marker: 'keep' };
  fs.writeFileSync(seed, JSON.stringify(data));
  const store = createStore({ file, seed, writable });
  return { directory, file, seed, data, store, tools: createTools(store) };
}

test('preview is read-only, writes preserve layout and references, stale revisions fail', t => {
  const { directory, file, seed, data, store, tools } = sample(t);
  assert.equal(tools.call('family_tree_search', { query: '1880 алена' }).people[0].id, 'a');
  assert.equal(tools.call('family_tree_relationship', { fromId: 'b', toId: 'a' }).path[1].relationFromPrevious, 'мать');
  const change = { operation: 'update_person', personId: 'a', values: { name: 'Алёна Мирова (Садова)' } };
  const preview = tools.call('family_tree_preview', { change });
  assert.equal(fs.existsSync(file), false);
  const saved = tools.call('family_tree_apply', { change, revision: preview.revision });
  assert.equal(store.read().tree.mems[1].mother, change.values.name);
  assert.equal(store.read().tree.mems[0].x, 20);
  assert.equal(store.read().tree.marker, 'keep');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'mcp-backups', saved.backup), 'utf8')), data);
  assert.deepEqual(JSON.parse(fs.readFileSync(seed, 'utf8')), data);
  assert.throws(() => tools.call('family_tree_apply', { change, revision: preview.revision }), /Дерево изменилось/);
});

test('writes validate parent cycles, ambiguous IDs, and children assigned to unions', t => {
  const { store, tools } = sample(t);
  const preview = change => tools.call('family_tree_preview', { change });
  assert.throws(() => preview({ operation: 'set_parents', personId: 'a', motherId: 'b' }), /цикл/);
  assert.throws(() => preview({ operation: 'set_parents', personId: 'a', fatherId: 'invalid' }), /не найдена/);
  assert.throws(() => preview({ operation: 'add_person', values: { name: 'Алена Мирова' } }), /уже используется/);
  const change = { operation: 'save_marriage', personId: 'a', partnerId: 'c', childIds: ['b'] };
  const view = preview(change);
  tools.call('family_tree_apply', { change, revision: view.revision });
  assert.equal(store.read().tree.marriages.length, 1);
  assert.throws(() => preview({ ...change, partnerId: 'd' }), /уже указан/);
  assert.throws(() => preview({ operation: 'set_parents', personId: 'b', fatherId: 'd' }), /не входит/);
  const add = { operation: 'add_person', values: { name: 'Новая Карточка', bio: 'Биография.' } };
  const result = tools.call('family_tree_apply', { change: add, revision: preview(add).revision });
  assert.equal(tools.call('family_tree_person', { id: result.createdId }).person.bio, 'Биография.');
});

test('MCP keeps the union date, divorce date and original type separate', t => {
  const { tools } = sample(t);
  const change = { operation:'save_marriage', personId:'a', partnerId:'c',
    values:{ relationType:'official', marriageDate:'1900', divorceDate:'1907' } };
  const args = { change };
  const { revision } = tools.call('family_tree_preview',args);
  const saved = tools.call('family_tree_apply',{ ...args, revision });
  const union = tools.call('family_tree_person',{id:'a'}).marriages[0];
  assert.equal(union.relationType,'official');
  assert.equal(union.marriageDate,'1900');
  assert.equal(union.divorceDate,'1907');
  assert.equal(union.divorced,true);
  assert.throws(() => tools.call('family_tree_preview',{change:{ ...change, marriageId:saved.marriageId,
    values:{divorceDate:'1899'} }}),/Дата развода раньше/);
});

test('stdio MCP initializes, publishes skills and calls search without allowing writes', t => {
  const { seed } = sample(t, false);
  const lines = [
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    { method: 'notifications/initialized' },
    { id: 2, method: 'tools/list' }, { id: 3, method: 'prompts/list' },
    { id: 4, method: 'prompts/get', params: { name: 'family_tree_research' } },
    { id: 5, method: 'tools/call', params: { name: 'family_tree_search', arguments: { query: 'аЛена' } } }
  ].map(message => JSON.stringify({ jsonrpc: '2.0', ...message })).join('\n');
  const run = spawnSync(process.execPath, [path.resolve(__dirname, '../mcp/server.cjs')], {
    input: lines + '\n', encoding: 'utf8',
    env: { ...process.env, FAMILY_TREE_FILE: seed, FAMILY_TREE_WRITE: '0' }
  });
  assert.equal(run.status, 0, run.stderr);
  const [init, tools, prompts, content, search] = run.stdout.trim().split('\n').map(line => JSON.parse(line).result);
  assert.equal(init.protocolVersion, '2025-11-25');
  assert.ok(!tools.tools.some(tool => tool.name === 'family_tree_apply'));
  assert.equal(prompts.prompts.length, 2);
  assert.match(content.messages[0].content.text, /family_tree_search/);
  assert.equal(search.structuredContent.people[0].id, 'a');
});

async function listen(t, server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

test('HTTP agent and browser paths work with OpenAI-compatible local model and explicit write', async t => {
  const { file, store, tools } = sample(t);
  const stages = [];
  const model = await listen(t, http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
    const buffers = [];
    for await (const part of req) buffers.push(part);
    const input = JSON.parse(Buffer.concat(buffers));
    stages.push(input);
    const message = stages.length === 1 ? { tool_calls: [{
      id: 'one', type: 'function', function: { name: 'family_tree_preview', arguments: JSON.stringify({ change: {
        operation: 'update_person', personId: 'a', values: { bio: 'Запись.' }
      } }) }
    }] } : { content: 'Правка готова к проверке.' };
    res.end(JSON.stringify({ choices: [{ message }] }));
  }));
  const token = 'connector-test-only-00-token';
  const url = await listen(t, webServer(store, tools, providers({ FAMILY_LMSTUDIO_URL: model + '/v1',
    FAMILY_UNSLOTH_URL: model + '/v1' }), token));
  const get = (route, body, extra = {}) => fetch(url + route, { headers: { Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json', ...extra }, method: body === undefined ? 'GET' : 'POST',
    body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal((await fetch(url + '/api/tree')).status, 401);
  assert.equal((await get('/api/tree', undefined, { Origin: 'https://example.org' })).status, 403);
  const rpc = (method, params, id) => get('/mcp', { jsonrpc: '2.0', id, method, params });
  assert.equal((await (await rpc('initialize', { protocolVersion: '2025-11-25' }, 1)).json()).result.serverInfo.name, 'family-tree');
  assert.equal((await rpc('notifications/initialized')).status, 202);
  assert.ok((await (await rpc('tools/list', {}, 2)).json()).result.tools.some(tool => tool.name === 'family_tree_apply'));
  const states = await (await get('/api/models')).json();
  assert.ok(states.every(state => state.connected && state.models[0] === 'test-model'));
  const reply = await (await get('/api/chat', { provider: 'lmstudio', model: 'test-model', messages: [
    { role: 'user', content: 'Обнови биографию.' }
  ] })).json();
  assert.equal(reply.answer, 'Правка готова к проверке.');
  assert.equal(reply.proposal.after.bio, 'Запись.');
  assert.ok(stages.every(step => !step.tools.some(tool => tool.function.name === 'family_tree_apply')));
  assert.equal(fs.existsSync(file), false);
  const { revision, change } = reply.proposal;
  const applied = await get('/api/tool', { name: 'family_tree_apply', arguments: { revision, change } });
  assert.equal(applied.status, 200);
  const downloaded = await (await get('/api/tree')).json();
  assert.equal(downloaded.mems[0].bio, 'Запись.');
  assert.match(await (await fetch(url)).text(), /Помощник семейного дерева/);
});
