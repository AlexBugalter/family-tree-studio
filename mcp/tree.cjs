const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const project = path.resolve(__dirname, '..');
const revision = text => createHash('sha256').update(text).digest('hex');
const normalize = value => String(value || '').normalize('NFC').toLowerCase().replaceAll('ё', 'е');
const must = (ok, message) => { if (!ok) throw new Error(message); };
const fields = [
  'name', 'gender', 'isAlive', 'birthDate', 'deathDate', 'birthPlace', 'deathPlace',
  'burialPlace', 'deathCause', 'residence', 'nationality', 'status', 'title', 'bio',
  'maidenName', 'marriedName'
];
const summary = person => ({
  id: person.id, name: person.name, birthDate: person.birthDate || '',
  birthPlace: person.birthPlace || '', deathDate: person.deathDate || ''
});
const publicProfile = person => Object.fromEntries(
  ['id', ...fields, 'birthDateDetail', 'deathDateDetail'].filter(key => key in person)
    .map(key => [key, typeof person[key] === 'string' ? person[key].slice(0, 8000) : person[key]])
);

function createStore({
  file = process.env.FAMILY_TREE_FILE || path.join(project, 'data/tree_mcp.json'),
  seed = process.env.FAMILY_TREE_SEED || (process.env.FAMILY_TREE_FILE ? file : path.join(project, 'demo/tree.json')),
  writable = process.env.FAMILY_TREE_WRITE === '1'
} = {}) {
  file = path.resolve(file);
  seed = path.resolve(seed);
  function read() {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT' || file === seed) throw error;
      text = fs.readFileSync(seed, 'utf8');
    }
    const tree = JSON.parse(text.replace(/^\uFEFF/, ''));
    must(Array.isArray(tree.mems), 'Ожидается экспорт редактора с массивом mems.');
    must(new Set(tree.mems.map(p => p.id)).size === tree.mems.length, 'В экспорте повторяются ID.');
    return { tree, text, revision: revision(text) };
  }

  function apply(expected, change) {
    must(writable, 'Запись отключена. Установите FAMILY_TREE_WRITE=1 при запуске.');
    const lock = file + '.lock';
    const temporary = file + '.' + randomUUID() + '.tmp';
    let handle;
    try {
      try { handle = fs.openSync(lock, 'wx'); }
      catch (error) {
        if (error.code === 'EEXIST') throw new Error('Дерево занято другой записью. Повторите после её завершения.');
        throw error;
      }
      const snapshot = read();
      must(snapshot.revision === expected, 'Дерево изменилось. Получите свежий предпросмотр.');
      const result = edit(snapshot.tree, change);
      const backupDir = path.join(path.dirname(file), 'mcp-backups');
      fs.mkdirSync(backupDir, { recursive: true });
      const backup = path.join(backupDir, path.basename(file) + '.' + Date.now() + '.' + randomUUID() + '.json');
      fs.writeFileSync(backup, snapshot.text, { flag: 'wx' });
      snapshot.tree.exportDate = new Date().toISOString();
      const text = JSON.stringify(snapshot.tree, null, 2) + '\n';
      fs.writeFileSync(temporary, text, { flag: 'wx', flush: true });
      fs.renameSync(temporary, file);
      return { ...result, revision: revision(text), backup: path.basename(backup) };
    } finally {
      if (handle !== undefined) {
        fs.closeSync(handle);
        try { fs.rmSync(temporary, { force: true }); }
        finally { fs.unlinkSync(lock); }
      }
    }
  }
  return { read, apply, writable };
}

function resolve(tree, id) {
  const person = tree.mems.find(p => p.id === id);
  must(person, 'Карточка с ID ' + id + ' не найдена.');
  return person;
}

function graph(tree) {
  const links = new Map(tree.mems.map(p => [p.id, []]));
  const refs = new Map(tree.mems.map(p => [p.id, p.id]));
  const names = new Map();
  for (const person of tree.mems) {
    names.set(person.name, names.has(person.name) ? null : person.id);
  }
  const link = (from, to, kind, reverse) => {
    if (from === to || !links.has(from) || !links.has(to)) return;
    if (!links.get(from).some(edge => edge.id === to && edge.kind === kind)) {
      links.get(from).push({ id: to, kind });
      links.get(to).push({ id: from, kind: reverse });
    }
  };
  const ref = value => refs.get(value) ?? names.get(value);
  for (const person of tree.mems) {
    link(person.id, ref(person.father), 'отец', 'ребёнок');
    link(person.id, ref(person.mother), 'мать', 'ребёнок');
    link(person.id, ref(person.spouse), 'супруг(а)', 'супруг(а)');
    for (const value of person.siblings || []) link(person.id, ref(value), 'брат/сестра', 'брат/сестра');
  }
  for (const person of tree.mems) {
    for (const value of person.children || []) {
      const id = ref(value);
      const child = tree.mems.find(p => p.id === id);
      if (!child || links.get(child.id).some(e => e.id === person.id && ['отец','мать'].includes(e.kind))) continue;
      const genderRole = { Мужчина: 'отец', Женщина: 'мать' }[person.gender];
      const named = links.get(id).filter(e => e.kind === 'отец' || e.kind === 'мать');
      if (named.length >= 2 || named.some(edge => edge.kind === genderRole)) continue;
      link(person.id, id, 'ребёнок', 'родитель');
    }
  }
  for (const marriage of tree.marriages || []) {
    const [a, b] = marriage.partnerIds;
    link(a, b, 'супруг(а)', 'супруг(а)');
    for (const id of marriage.childIds) {
      for (const partner of [a, b]) {
        if (links.get(id)?.some(edge => edge.id === partner && ['отец','мать','родитель'].includes(edge.kind))) continue;
        link(partner, id, 'ребёнок по записи о союзе', 'родитель по записи о союзе');
      }
    }
  }
  return links;
}

function search(tree, query, limit, offset) {
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  const hits = tree.mems.filter(person => {
    const haystack = normalize([person.id, person.name, person.maidenName, person.marriedName,
      person.birthDate, person.deathDate, person.birthPlace].join(' '));
    return terms.every(term => haystack.includes(term));
  });
  return { total: hits.length, offset, people: hits.slice(offset, offset + limit).map(summary) };
}

function profile(tree, id) {
  const person = resolve(tree, id);
  return {
    person: publicProfile(person),
    relatives: graph(tree).get(id).map(edge => ({ ...summary(resolve(tree, edge.id)), relation: edge.kind })),
    marriages: (tree.marriages || []).filter(m => m.partnerIds.includes(id))
  };
}

function connection(tree, from, to) {
  resolve(tree, from);
  resolve(tree, to);
  const links = graph(tree);
  const visited = new Map([[from, null]]);
  const queue = [from];
  for (let i = 0; i < queue.length && !visited.has(to); i++) {
    for (const { id, kind } of links.get(queue[i])) {
      if (visited.has(id)) continue;
      visited.set(id, { previous: queue[i], kind });
      queue.push(id);
    }
  }
  if (!visited.has(to)) return { found: false, path: [] };
  const result = [];
  for (let id = to; id;) {
    const edge = visited.get(id);
    result.unshift({ ...summary(resolve(tree, id)), relationFromPrevious: edge?.kind || null });
    id = edge?.previous;
  }
  return { found: true, path: result };
}

function edit(tree, change) {
  const { operation, personId, values, fatherId, motherId, partnerId, childIds, marriageId } = change;
  if (operation === 'add_person' || operation === 'update_person') {
    const adding = operation === 'add_person';
    must(values && Object.keys(values).length, 'Укажите поля карточки.');
    if (adding) must(typeof values.name === 'string' && values.name.trim(), 'Укажите полное имя.');
    const person = adding ? {
      id: 'm_' + randomUUID(), name: '', gender: 'Неизвестно', isAlive: null,
      x: 120, y: Math.max(0, ...tree.mems.map(p => Number.isFinite(p.y) ? p.y : 0)) + 400,
      children: [], siblings: [], groupIds: [], photos: [], videos: [], previewPhoto: 0, bio: ''
    } : resolve(tree, personId);
    const oldName = person.name;
    const before = adding ? null : publicProfile(person);
    for (const [key, value] of Object.entries(values)) {
      must(fields.includes(key), 'Поле недоступно для изменения: ' + key);
      if (key === 'gender') must(['Мужчина','Женщина','Неизвестно'].includes(value), 'Укажите допустимый пол.');
      else if (key === 'isAlive') must(value === null || typeof value === 'boolean', 'Статус жизни: true, false или null.');
      else must(typeof value === 'string' && value.length <= (key === 'bio' ? 8000 : 400), 'Недопустимое значение поля ' + key);
      if (key === 'name') {
        must(value.trim() && !tree.mems.some(p => p.id !== person.id && normalize(p.name) === normalize(value.trim())), 'Полное имя пустое или уже используется в дереве.');
        if (!adding && value.trim() !== oldName) {
          must(!tree.mems.some(p => p.id !== person.id && p.name === oldName), 'Старое имя неоднозначно.');
          must(!['firstName','lastName','patronymic'].some(key => Object.hasOwn(person, key)),
            'Эта карточка хранит фамилию, имя и отчество раздельно. Измените их в редакторе.');
          for (const entry of tree.mems) {
            for (const role of ['father','mother','spouse']) if (entry[role] === oldName) entry[role] = value.trim();
            for (const role of ['children','siblings']) if (Array.isArray(entry[role])) {
              entry[role] = entry[role].map(name => name === oldName ? value.trim() : name);
            }
          }
        }
      }
      if (['birthDate','deathDate'].includes(key) && person[key + 'Detail'] && person[key] !== value.trim()) {
        throw new Error('Составную дату или дату с календарным стилем меняйте в редакторе.');
      }
      person[key] = typeof value === 'string' ? value.trim() : value;
    }
    if (adding) tree.mems.push(person);
    const after = publicProfile(person);
    if (adding) delete after.id;
    return { operation, ...(adding ? { createdId: person.id } : { personId }), before, after };
  }
  const person = resolve(tree, personId);
  const uniqueName = p => p && tree.mems.filter(other => other.name === p.name).length === 1;
  if (operation === 'set_parents') {
    const before = { father: person.father || '', mother: person.mother || '' };
    must(fatherId !== undefined || motherId !== undefined, 'Укажите fatherId или motherId.');
    must(uniqueName(person), 'Имя ребёнка неоднозначно в формате редактора.');
    for (const [role, id] of [['father', fatherId], ['mother', motherId]]) {
      if (id === undefined) continue;
      const parent = id === null ? null : resolve(tree, id);
      must(!parent || uniqueName(parent), 'Имя родителя неоднозначно в формате редактора.');
      const oldParent = tree.mems.find(p => p.name === person[role] || p.id === person[role]);
      if (oldParent && oldParent.id !== id) oldParent.children = (oldParent.children || []).filter(n => n !== person.name && n !== person.id);
      person[role] = parent?.name || '';
      if (parent) parent.children = [...new Set([...(parent.children || []), person.name])];
    }
    must(!person.father || person.father !== person.mother, 'Отец и мать должны ссылаться на разные карточки.');
    const family = (tree.marriages || []).find(record => record.childIds.includes(person.id));
    if (family) {
      for (const id of [fatherId, motherId]) {
        must(!id || family.partnerIds.includes(id), 'Родитель не входит в записанный союз ребёнка. Сначала уточните запись о союзе.');
      }
    }
    verifyAncestors(tree, person.id);
    return { operation, personId, before, after: { father: person.father || '', mother: person.mother || '' } };
  }
  must(operation === 'save_marriage', 'Неизвестная операция.');
  const partner = resolve(tree, partnerId);
  must(person.id !== partner.id, 'Для союза нужны две разные карточки.');
  for (const id of childIds || []) {
    resolve(tree, id);
    must(id !== person.id && id !== partner.id, 'Участник союза не может быть его ребёнком.');
  }
  const records = tree.marriages ??= [];
  const existing = marriageId ? records.find(r => r.id === marriageId) : null;
  must(!marriageId || existing, 'Союз с этим ID не найден.');
  must(!existing || [person.id,partner.id].every(id => existing.partnerIds.includes(id)), 'Участники существующего союза должны совпадать.');
  const data = values || {};
  for (const [key, value] of Object.entries(data)) {
    const valid = key === 'divorced' ? typeof value === 'boolean'
      : ['relationType','marriagePlace','marriageDate','divorceDate'].includes(key) && typeof value === 'string' && value.length <= 400;
    must(valid, 'Недопустимое поле союза: ' + key);
  }
  for (const key of ['marriageDate','divorceDate']) {
    if (existing?.[key + 'Detail'] && data[key] !== undefined && data[key] !== existing[key]) {
      throw new Error('Дату с календарным стилем меняйте в редакторе.');
    }
  }
  const record = { id: 'u_' + randomUUID(), relationType: '', marriageDate: '', marriagePlace: '',
    ...existing, ...data, partnerIds: [person.id, partner.id], childIds: [...new Set(childIds ?? existing?.childIds ?? [])] };
  if (data.divorceDate !== undefined || data.divorced !== undefined || (existing?.relationType === 'divorce' && data.relationType !== undefined)) {
    must(data.divorced !== false || !record.divorceDate?.trim(), 'При снятии отметки очистите дату развода.');
    record.divorced = data.divorced ?? Boolean(record.divorceDate?.trim() || existing?.divorced || existing?.relationType === 'divorce');
    if (data.divorced === false && record.relationType === 'divorce') record.relationType = 'unknown';
  }
  if (data.marriageDate !== undefined || data.divorceDate !== undefined) {
    const year = key => /^(?:\d{1,2}\.){0,2}(\d{4})$/.exec(String(record[key] || '').trim())?.[1];
    const start = year('marriageDate'), end = year('divorceDate');
    if (start && end && !record.marriageDateDetail && !record.divorceDateDetail) {
      must(start <= end, 'Дата развода раньше даты заключения союза.');
    }
  }
  if (childIds !== undefined) {
    const reserved = new Set(records.filter(entry => entry !== existing).flatMap(entry => entry.childIds));
    for (const id of record.childIds) {
      must(!reserved.has(id), 'Ребёнок уже указан в другом союзе. Сначала уточните ту запись.');
      const child = resolve(tree, id);
      for (const name of [child.father, child.mother].filter(Boolean)) {
        const parent = tree.mems.find(p => p.id === name || p.name === name);
        must(!parent || record.partnerIds.includes(parent.id), 'Записанный родитель ребёнка не входит в этот союз.');
      }
    }
  }
  if (existing) records[records.indexOf(existing)] = record;
  else records.push(record);
  for (const id of record.childIds) verifyAncestors(tree, id);
  const after = { ...record };
  if (!existing) delete after.id;
  return { operation, marriageId: record.id, before: existing, after };
}

function verifyAncestors(tree, subject) {
  const edges = graph(tree);
  const visited = new Set();
  const parentEdges = id => edges.get(id).filter(e => /^(отец|мать|родитель)/.test(e.kind));
  const queue = parentEdges(subject);
  for (const edge of queue) {
    must(edge.id !== subject, 'Эта правка создаёт цикл в родительских связях.');
    if (visited.has(edge.id)) continue;
    visited.add(edge.id);
    queue.push(...parentEdges(edge.id));
  }
  const member = resolve(tree, subject);
  must(![member.id, member.name].some(value => value === member.father || value === member.mother),
    'Карточка не может ссылаться на себя как на родителя.');
}

module.exports = { connection, createStore, edit, must, profile, search };
