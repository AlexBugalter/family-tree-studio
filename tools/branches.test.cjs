const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../app/family_tree_web_app.html'), 'utf8');
const script = html.match(/<script>([\s\S]+?)<\/script>/)[1];

function tree() {
  function element() {
    return {
      children: [], style: {}, dataset: {}, value: '', checked: true, listeners: new Map(),
      offsetWidth: 200, offsetHeight: 180,
      classList: { add() {}, remove() {} },
      setAttribute() {},
      focus() {},
      addEventListener(type, handler) { this.listeners.set(type, handler); },
      appendChild(child) { child.parentElement = child.parentNode = this; this.children.push(child); },
      remove() {
        this.parentElement.children = this.parentElement.children.filter(child => child !== this);
        this.parentElement = this.parentNode = null;
      },
      replaceChildren() { this.children = []; },
      set innerHTML(value) { this.markup = value; this.children = []; }
    };
  }
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    createElement: element,
    createElementNS: element
  };
  const stored = new Map();
  const sandbox = { window: {}, document, clearTimeout,
    localStorage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) } };
  vm.runInNewContext(script.replace('window.app = new App();', 'window.App = App;'), sandbox);
  const app = Object.create(sandbox.window.App.prototype);
  const person = (id, fields = {}) => ({ id, name: id, ...fields });
  app.S = {
    members: [
      person('grandparent'), person('parent', { father: 'grandparent' }),
      person('anchor', { father: 'parent', spouse: 'partner' }),
      person('partner'),
      person('sibling', { father: 'parent', spouse: 'sibling-partner' }),
      person('sibling-partner'),
      person('child', { father: 'anchor', children: ['grandchild'] }),
      person('grandchild'),
      person('shared-child', { father: 'anchor', mother: 'sibling' }),
      person('nephew', { father: 'sibling' }),
      person('unrelated', { groupIds: ['separate'] })
    ],
    groups: []
  };
  app.map = new Map();
  app.cache = new Map();
  app._collapsedBranches = new Map();
  app._cardSizes = new Map();
  app._connections = new Map();
  app.schedLines = () => {};
  app._esc = text => text;
  app._rebuildMap();
  app.render();
  const el = document.getElementById;
  return { app, el, stored, shown: () => el('cards').children.map(card => card.dataset.id).sort() };
}

test('ancestor arrow hides only ancestors and restores the same cards and lines', () => {
  const { app, el, shown } = tree();
  const initial = shown();
  const snapshot = JSON.stringify(app.S.members);
  const anchor = app.cache.get('anchor');
  assert.match(anchor.markup, /data-branch="ancestors"[^>]*aria-expanded="true"/);
  app.drawLines();
  const lines = el('svg-lines').children.length;
  app.toggleBranch('anchor', 'ancestors');
  assert.deepEqual(shown(), initial.filter(id => !['grandparent', 'parent'].includes(id)));
  assert.equal(el('mm-c').children.length, shown().length);
  assert.match(anchor.markup, /data-branch="ancestors"[^>]*aria-expanded="false"/);
  app.drawLines();
  assert.ok(el('svg-lines').children.length < lines);
  assert.equal(app._connections.has('parent'), false);
  app.toggleBranch('anchor', 'ancestors');
  assert.deepEqual(shown(), initial);
  app.drawLines();
  assert.equal(el('svg-lines').children.length, lines);
  assert.equal(JSON.stringify(app.S.members), snapshot);
});

test('lateral branch hides siblings and their families while retaining shared descendants', () => {
  const { app, shown } = tree();
  app.toggleBranch('anchor', 'siblings');
  for (const id of ['sibling', 'sibling-partner', 'nephew']) assert.ok(!shown().includes(id), id);
  for (const id of ['anchor', 'parent', 'partner', 'child', 'shared-child', 'unrelated']) {
    assert.ok(shown().includes(id), id);
  }
});

test('nested descendant branches stay collapsed until explicitly expanded', () => {
  const { app, el, shown } = tree();
  app.toggleBranch('child', 'descendants');
  app.toggleBranch('anchor', 'descendants');
  assert.ok(!shown().includes('child'));
  app.toggleBranch('anchor', 'descendants');
  assert.ok(shown().includes('child'));
  assert.ok(!shown().includes('grandchild'));
  app.expandAllBranches();
  assert.ok(shown().includes('grandchild'));
  assert.equal(el('expand-all-branches').disabled, true);
});

test('branch visibility respects the existing group filter', () => {
  const { app, el, shown } = tree();
  app.toggleBranch('anchor', 'descendants');
  el('sel-group').value = 'separate';
  app.applyFilter();
  assert.deepEqual(shown(), ['unrelated']);
  app.expandAllBranches();
  assert.deepEqual(shown(), ['unrelated']);
});

test('clicking a branch arrow collapses the branch without dragging or selecting a hidden card', () => {
  const { app, shown } = tree();
  const card = app.cache.get('anchor');
  const button = { dataset: { branch: 'descendants' }, closest: () => button };
  let refocused = false;
  card.querySelector = selector => {
    assert.equal(selector, '[data-branch="descendants"]');
    return { focus: () => { refocused = true; } };
  };
  app.S.sel = 'child';
  card.listeners.get('mousedown')({ button: 0, target: button });
  assert.equal(app.S.drag, undefined);
  card.listeners.get('click')({ target: button, stopPropagation() {} });
  assert.ok(!shown().includes('child'));
  assert.equal(app.S.sel, null);
  assert.equal(refocused, true);
});

test('choosing a reference person computes kinship and branch colors without altering tree data', () => {
  const { app, el } = tree();
  const additional = [
    {id:'mother',name:'mother',gender:'Женщина',father:'maternal-grandfather',mother:'maternal-grandmother'},
    {id:'maternal-grandfather',name:'maternal-grandfather',gender:'Мужчина'},
    {id:'maternal-grandmother',name:'maternal-grandmother',gender:'Женщина'},
    {id:'paternal-grandmother',name:'paternal-grandmother',gender:'Женщина'},
    {id:'aunt',name:'aunt',gender:'Женщина',father:'grandparent'},
    {id:'cousin',name:'cousin',gender:'Женщина',mother:'aunt'},
    {id:'aunt-partner',name:'aunt-partner',gender:'Мужчина',spouse:'aunt'},
    {id:'partner-father',name:'partner-father',gender:'Мужчина',children:['partner']}
  ];
  app.S.members.push(...additional);
  Object.assign(app.byId('anchor'),{mother:'mother'});
  Object.assign(app.byId('parent'),{gender:'Мужчина',mother:'paternal-grandmother'});
  Object.assign(app.byId('sibling'),{gender:'Женщина'});
  Object.assign(app.byId('partner'),{gender:'Женщина'});
  Object.assign(app.byId('nephew'),{gender:'Мужчина'});
  app._rebuildMap();
  const snapshot=JSON.stringify(app.S.members);
  app.S.selfId='anchor';
  app.S.branchColors=true;
  app.render();
  const expected={
    anchor:'Вы',parent:'Отец',mother:'Мать',aunt:'Тётя',cousin:'Двоюродная сестра',
    partner:'Супруга',sibling:'Сестра',nephew:'Племянник','aunt-partner':'Муж тёти','partner-father':'Тесть'
  };
  for(const [id,label] of Object.entries(expected))assert.ok(app.cache.get(id).markup.includes(label),id);
  assert.equal(app.cache.get('grandparent').dataset.familyBranch,'paternal-father');
  assert.equal(app.cache.get('paternal-grandmother').dataset.familyBranch,'paternal-mother');
  assert.equal(app.cache.get('maternal-grandfather').dataset.familyBranch,'maternal-father');
  assert.equal(app.cache.get('maternal-grandmother').dataset.familyBranch,'maternal-mother');
  assert.equal(app.cache.get('child').dataset.familyBranch,'descendants');
  const aunt=app.byId('aunt');
  app._showTT(aunt,{getBoundingClientRect:()=>({right:100,top:25})});
  app._ppRender(aunt);
  assert.equal(el('tt-kin').textContent,'Тётя');
  assert.equal(el('pp-kin').textContent,'Тётя');
  app.S.branchColors=false;
  app.render();
  assert.equal(app.cache.get('child').dataset.familyBranch,undefined);
  assert.ok(app.cache.get('aunt').markup.includes('Тётя'));
  assert.equal(JSON.stringify(app.S.members),snapshot);
});

test('find self selects a hidden card and reloads the browser preference separately', () => {
  const { app, el, stored, shown } = tree();
  el('sel-group').value='separate';
  app.render();
  assert.ok(!shown().includes('anchor'));
  let centered;
  app.ctxCenter=()=>{centered=app.S.sel;};
  app.openSelfPicker();
  el('self-search').value='anchor';
  app.renderSelfPicker();
  assert.equal(el('self-results').children.length,1);
  el('self-results').children[0].listeners.get('click')();
  assert.ok(shown().includes('anchor'));
  assert.equal(centered,'anchor');
  app.setFamilyColors(false);
  assert.deepEqual(JSON.parse(stored.get('ftree_kinship_view')),{selfId:'anchor',branchColors:false});
  assert.equal(stored.has('ftree_v2'),false);
  app.S.selfId=null;
  app._loadKinshipView();
  assert.equal(app.S.selfId,'anchor');
  assert.equal(app.S.branchColors,false);
  app.chooseSelf(null);
  assert.equal(app._kinshipLabels.size,0);
});

test('an explicit father wins over a conflicting reverse child link in kinship labels', () => {
  const { app }=tree();
  Object.assign(app.byId('parent'),{gender:'Мужчина'});
  Object.assign(app.byId('unrelated'),{gender:'Мужчина',children:['anchor']});
  app.S.selfId='anchor';
  app.render();
  assert.equal(app._kinshipLabels.get('parent'),'Отец');
  assert.equal(app._kinshipLabels.has('unrelated'),false);
  assert.deepEqual(app.byId('unrelated').children,['anchor']);
});
