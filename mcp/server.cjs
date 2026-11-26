const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const http = require('node:http');
const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const { createStore, must } = require('./tree.cjs');
const { createTools } = require('./tools.cjs');
const llm = require('./llm.cjs');

const version = '1.0.0';
const protocols = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const skills = {
  family_tree_research: { description: 'Проверять сведения и объяснять родственные связи.', file: 'family-tree-research' },
  family_tree_edit: { description: 'Готовить и сохранять согласованные правки дерева.', file: 'family-tree-edit' }
};
const skillText = name => fs.readFileSync(path.resolve(__dirname, '../skills', skills[name].file, 'SKILL.md'), 'utf8');
const resultText = value => [{ type: 'text', text: JSON.stringify(value) }];
function rpc(tools, request) {
  const id = request?.id ?? null;
  const response = result => ({ jsonrpc: '2.0', id, result });
  const failure = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (request?.jsonrpc !== '2.0' || typeof request.method !== 'string') return failure(-32600, 'Invalid Request');
  if (request.id === undefined) return;
  const params = request.params || {};
  switch (request.method) {
    case 'initialize':
      return response({
        protocolVersion: protocols.includes(params.protocolVersion) ? params.protocolVersion : protocols[0],
        capabilities: { tools: {}, prompts: {} }, serverInfo: { name: 'family-tree', version },
        instructions: 'Проверяйте ID однофамильцев. Перед записью покажите предпросмотр пользователю.'
      });
    case 'ping':
      return response({});
    case 'tools/list':
      return response({ tools: tools.definitions });
    case 'tools/call':
      try {
        const result = tools.call(params.name, params.arguments ?? {});
        return response({ content: resultText(result), structuredContent: result });
      } catch (error) {
        return response({ isError: true, content: [{ type: 'text', text: error.message }] });
      }
    case 'prompts/list':
      return response({ prompts: Object.entries(skills).map(([name, { description }]) => ({ name, description })) });
    case 'prompts/get':
      if (!Object.hasOwn(skills, params.name)) return failure(-32602, 'Unknown prompt');
      return response({ messages: [{ role: 'user', content: { type: 'text', text: skillText(params.name) } }] });
    default:
      return failure(-32601, 'Method not found');
  }
}

function stdio(tools) {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  input.on('line', line => {
    let result;
    try { result = rpc(tools, JSON.parse(line)); }
    catch { result = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }; }
    if (result) process.stdout.write(JSON.stringify(result) + '\n');
  });
}

async function readJson(req) {
  must(/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || ''), 'Ожидается application/json.');
  const parts = [];
  let bytes = 0;
  for await (const part of req) {
    bytes += part.length;
    must(bytes <= 512 * 1024, 'Запрос слишком большой.');
    parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

function webServer(store, tools, configs, token) {
  const hash = value => createHash('sha256').update(value).digest();
  const expected = hash('Bearer ' + token);
  return http.createServer(async (req, res) => {
    const port = req.socket.localPort;
    const hosts = ['127.0.0.1:' + port, 'localhost:' + port];
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'" };
    const send = (status, body, type = 'application/json; charset=utf-8', extra = {}) => {
      res.writeHead(status, { ...headers, 'Content-Type': type, ...extra });
      res.end(type.startsWith('application/json') && body !== undefined ? JSON.stringify(body) : body);
    };
    try {
      if (!hosts.includes(req.headers.host) || (req.headers.origin && !hosts.some(host => req.headers.origin === 'http://' + host))) {
        return send(403, { error: 'Недопустимый Host или Origin.' });
      }
      const route = new URL(req.url, 'http://127.0.0.1').pathname;
      if (req.method === 'GET' && (route === '/' || route === '/chat.js')) {
        const asset = route === '/' ? ['chat.html','text/html'] : ['chat.js','text/javascript'];
        return send(200, fs.readFileSync(path.join(__dirname, asset[0])), asset[1] + '; charset=utf-8');
      }
      if (!timingSafeEqual(expected, hash(req.headers.authorization || ''))) {
        return send(401, { error: 'Нужен токен коннектора.' }, undefined, { 'WWW-Authenticate': 'Bearer' });
      }
      if (route === '/mcp') {
        if (req.method !== 'POST') return send(405, { error: 'Используйте POST.' }, undefined, { Allow: 'POST' });
        if (req.headers['mcp-protocol-version'] && !protocols.includes(req.headers['mcp-protocol-version'])) {
          return send(400, { error: 'Unsupported MCP protocol version' });
        }
        const result = rpc(tools, await readJson(req));
        return send(result ? 200 : 202, result);
      }
      if (req.method === 'GET' && route === '/api/models') return send(200, await llm.detect(configs));
      if (req.method === 'GET' && route === '/api/tree') {
        return send(200, store.read().tree, undefined, { 'Content-Disposition': 'attachment; filename="tree_mcp.json"' });
      }
      if (req.method === 'GET' && route === '/api/tools') return send(200, tools.definitions);
      if (req.method === 'POST' && route === '/api/tool') {
        const { name, arguments: args } = await readJson(req);
        return send(200, tools.call(name, args ?? {}));
      }
      if (req.method === 'POST' && route === '/api/chat') {
        return send(200, await llm.chat(configs, tools, await readJson(req)));
      }
      return send(404, { error: 'Маршрут не найден.' });
    } catch (error) {
      const message = error.code ? 'Ошибка чтения или записи файла дерева: ' + error.code : error.message;
      if (!res.headersSent && !res.destroyed) send(400, { error: message });
    }
  });
}

if (require.main === module) {
  const store = createStore();
  const tools = createTools(store);
  if (process.argv.includes('--http')) {
    const port = Number(process.env.FAMILY_MCP_PORT || 8765);
    must(Number.isInteger(port) && port >= 1024 && port <= 65535, 'Некорректный порт FAMILY_MCP_PORT.');
    const token = process.env.FAMILY_MCP_TOKEN || randomBytes(24).toString('base64url');
    must(token.length >= 24 && /^[a-zA-Z0-9_.~-]+$/.test(token), 'Токен должен содержать от 24 безопасных символов.');
    const server = webServer(store, tools, llm.providers(), token);
    server.on('error', error => { console.error(error.message); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => {
      console.error('Семейное дерево: http://127.0.0.1:' + port + '/');
      if (!process.env.FAMILY_MCP_TOKEN) console.error('Токен для локального чата: ' + token);
    });
  } else stdio(tools);
}

module.exports = { rpc, webServer };
