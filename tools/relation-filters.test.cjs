const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../app/family_tree_web_app.html'), 'utf8');
const script = html.match(/<script>([\s\S]+?)<\/script>/)[1];

function editor() {
  function element() {
    return {
      children: [], value: '', style: {}, handlers: {},
      classList: { add() {}, remove() {} },
      set innerHTML(value) { this.children = []; },
      appendChild(child) { this.children.push(child); },
      append(...children) { this.children.push(...children); },
      addEventListener(event, handler) { this.handlers[event] = handler; },
      querySelector() { return this.children.find(row => row.children[0]?.type === 'checkbox')?.children[0]; },
      focus() { this.focused = true; },
      setAttribute() {}
    };
  }
  const elements = new Map();
  const field = id => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const document = { getElementById: field, createElement: element, querySelectorAll: () => [] };
  const context = { window: {}, document };
  vm.runInNewContext(script.replace('window.app = new App();', 'window.App = App;'), context);
  const app = Object.create(context.window.App.prototype);
  const root = { id: 'root', name: 'Редактируемый человек', gender: 'Мужчина', siblings: ['Семён Белый'], children: [] };
  const sibling = { id: 'sibling', name: 'Семён Белый', gender: 'Мужчина', birthDate: '01.02.1909', groupIds: ['group-a'] };
  const daughter = { id: 'daughter', name: 'Алёна Белая', gender: 'Женщина', birthDate: '1912', groupIds: ['group-b'] };
  const other = { id: 'other', name: 'Семён Иванов', gender: 'Мужчина', birthDate: '1912', groupIds: ['group-b'] };
  app.S = { members: [root, sibling, daughter, other], groups: [
    { id: 'group-a', name: 'Первая семья' }, { id: 'group-b', name: 'Вторая семья' }
  ] };
  app.map = new Map();
  app._rebuildMap();
  app._renderGal = app._save = app._push = app.render = app._updStats = app._fillPF = app.toast = () => {};
  app.openEdit(root.id);
  const listed = prefix => field(prefix).children.filter(row => row.children.length > 1)
    .map(row => [row.children[1].textContent, row.children[0].checked]);
  const filter = (prefix, suffix, value, type) => {
    field(prefix + '-' + suffix).value = value;
    app.filterRelations(type);
  };
  return { app, field, listed, filter, root, daughter };
}

test('sibling search works across case, ё, name tokens and birth year', () => {
  const { listed, filter } = editor();
  filter('e-sibs', 'search', 'БЕЛЫЙ  семен 1909', 'siblings');
  assert.deepEqual(listed('e-sibs'), [['Семён Белый', true]]);
  assert.equal(listed('e-kids').length, 3);
});

test('sex, group and selection filters combine in the children list', () => {
  const { listed, filter, field } = editor();
  filter('e-kids', 'gender', 'Женщина', 'children');
  filter('e-kids', 'group', 'group-b', 'children');
  filter('e-kids', 'status', 'unchecked', 'children');
  assert.deepEqual(listed('e-kids'), [['Алёна Белая', false]]);
  filter('e-kids', 'status', 'checked', 'children');
  assert.deepEqual(listed('e-kids'), []);
  assert.match(field('e-kids').children[0].textContent, /Никого не найдено/);
});

test('a checked child survives search changes and is linked only on save', async () => {
  const { app, field, listed, filter, root, daughter } = editor();
  filter('e-kids', 'search', 'алена', 'children');
  const checkbox = field('e-kids').children[0].children[0];
  checkbox.checked = true;
  checkbox.handlers.change();
  assert.deepEqual(root.children, []);
  filter('e-kids', 'search', 'иванов', 'children');
  filter('e-kids', 'search', '', 'children');
  filter('e-kids', 'status', 'checked', 'children');
  assert.deepEqual(listed('e-kids'), [['Алёна Белая', true]]);
  await app.saveMember();
  assert.deepEqual([...root.children], ['Алёна Белая']);
  assert.equal(daughter.father, root.name);
});

test('cancel discards hidden checkboxes and reopening resets both sets of filters', () => {
  const { app, field, listed, filter, root } = editor();
  filter('e-sibs', 'search', 'белый', 'siblings');
  const checkbox = field('e-sibs').children[0].children[0];
  checkbox.checked = false;
  checkbox.handlers.change();
  filter('e-kids', 'gender', 'Женщина', 'children');
  app.closeEdit();
  app.openEdit(root.id);
  assert.equal(field('e-sibs-search').value, '');
  assert.equal(field('e-kids-gender').value, '');
  assert.deepEqual(listed('e-sibs')[0], ['Семён Белый', true]);
});

test('unchecking the last selected result updates the filtered list immediately', () => {
  const { field, listed, filter, root } = editor();
  filter('e-sibs', 'status', 'checked', 'siblings');
  const checkbox = field('e-sibs').children[0].children[0];
  checkbox.checked = false;
  checkbox.handlers.change();
  assert.deepEqual(listed('e-sibs'), []);
  assert.equal(field('e-sibs-status').focused, true);
  assert.deepEqual(root.siblings, ['Семён Белый']);
});
