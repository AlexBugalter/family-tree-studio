const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

// node tools/layout.test.cjs [app HTML] [optional tree JSON for the load test]
const appFile = path.resolve(process.argv[2] || path.join(__dirname, '../app/family_tree_web_app.html'));
const edge = process.env.FAMILY_TEST_BROWSER ||
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const tmp = fs.mkdtempSync(path.join(process.env.TEMP || __dirname, 'family-layout-'));

function inBrowser(tree) {
  const pending = new Map();
  let frameId = 0;
  window.requestAnimationFrame = callback => {
    pending.set(++frameId, callback);
    return frameId;
  };
  window.cancelAnimationFrame = id => pending.delete(id);
  const frame = () => {
    for (const [id, callback] of [...pending]) {
      pending.delete(id);
      callback();
    }
  };
  const check = (condition, message) => {
    if (!condition) throw Error(message);
  };
  const point = (el, type, x, y, altKey = false) => {
    el.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, altKey, button: 0, bubbles: true }));
  };
  const member = (id, x, y, extra = {}) => ({ id, name: id, x, y, ...extra });
  const setup = () => {
    app.S.marriages = [];
    app.S.members = [
      member('parent', 60, 60), member('child', 310, 380, { father: 'parent' }),
      member('aunt', 630, 60), member('cousin', 630, 380, { father: 'aunt' })
    ];
    app.S.scale = 1;
    app.S.sel = null;
    app._norm();
    app._rebuildMap();
    app.render();
    frame();
  };
  const card = id => document.querySelector('.card[data-id="' + id + '"]');
  const svg = document.getElementById('svg-lines');
  const set = (control, value, event = 'change') => {
    control.value = value;
    control.dispatchEvent(new Event(event, { bubbles: true }));
  };
  const tests = {
    'group settings search by name and combine filters without losing assigned members'() {
      setup();
      app.S.groups = [{id:'one', name:'Семья Ёлкиных', color:'#2563eb'}, {id:'two', name:'Другая группа', color:'#334155'}];
      Object.assign(app.byId('parent'), {name:'Семён Белый',gender:'Мужчина',birthDate:'1901',groupIds:['one']});
      Object.assign(app.byId('child'), {name:'Алёна Белая',gender:'Женщина',birthDate:'1925'});
      app.openGroups();
      const field=id=>document.getElementById(id);
      const rows=()=>[...document.querySelectorAll('#gr-mems .mchk')];
      check(field('gr-member-search') && field('gr-search'), 'group settings have no search controls');
      set(field('gr-search'),'елкиных','input');
      const groups=[...field('gr-list').querySelectorAll('.gritem')];
      check(groups.length===1 && groups[0].textContent.includes('Ёлкиных'),'group-name search failed');
      groups[0].click();
      set(field('gr-member-search'),'белая алена 1925','input');
      set(field('gr-member-gender'),'Женщина');
      set(field('gr-member-status'),'outside');
      check(rows().length===1 && rows()[0].textContent.includes('Алёна'), 'combined member filters found the wrong person');
      rows()[0].querySelector('input').click();
      check(rows().length===0 && field('gr-mems').textContent.includes('Никого не найдено'), 'unchecked-only list did not update');
      set(field('gr-member-search'),'','input');
      set(field('gr-member-gender'),'');
      set(field('gr-member-status'),'inside');
      check(rows().length===2 && rows().every(row=>row.querySelector('input').checked),'existing group assignments were lost');
      check(app.byId('parent').groupIds.includes('one') && app.byId('child').groupIds.includes('one'),'model lost group assignments');
      app.closeGroups();
      app.S.groups=[];
    },
    'media tab shows the folder ID of the card being edited'() {
      setup();
      const mediaTab = document.querySelector('#m-edit [data-tab="media"]');
      for (const id of ['parent', 'child']) {
        app.openEdit(id);
        mediaTab.click();
        const folderId = document.querySelector('#tc-media #e-media-id');
        check(folderId?.textContent === id && folderId.getClientRects().length > 0,
          'the media tab does not show the current card folder ID');
        app.closeEdit();
      }
    },
    'drag follows the pointer outside the original card and saves immediately'() {
      setup();
      point(card('child'), 'mousedown', 350, 420);
      point(window, 'mousemove', 476, 103);
      frame();
      check(app.byId('child').x === 440 && app.byId('child').y === 60,
        'pointer displacement and row alignment were not preserved');
      point(window, 'mouseup', 476, 103);
      const saved = JSON.parse(localStorage.getItem('ftree_v2'));
      check(saved?.m.find(m => m.id === 'child').y === 60, 'drop not available immediately in browser storage');
      app._load();
      check(app.byId('child').y === 60, 'reload did not preserve saved row');
    },
    'connections reach the rendered card edges and update in place'() {
      setup();
      const connections = [...svg.children];
      const line = connections[0];
      const unrelated = connections[1].getAttribute('d');
      const endpoints = () => [line.getPointAtLength(0), line.getPointAtLength(line.getTotalLength())];
      let [start, end] = endpoints();
      check(start.x === 160 && start.y === 60 + card('parent').offsetHeight &&
        end.x === 410 && end.y === 380, 'parent or child endpoint is outside the edge center');
      point(card('child'), 'mousedown', 350, 420);
      point(window, 'mousemove', 10, 440, true);
      frame();
      const updated = [...svg.children];
      check(updated.length === connections.length &&
        connections.every((node, i) => updated[i] === node), 'drag rebuilt the SVG elements');
      check(connections[1].getAttribute('d') === unrelated, 'an unrelated line changed');
      [start, end] = endpoints();
      check(end.x === 70 && end.y === 400, 'line failed to follow the moved card');
      point(window, 'mousemove', -160, 440, true);
      frame();
      check(endpoints()[1].x === -100 && getComputedStyle(svg).overflow === 'visible',
        'line does not reach into the negative part of the canvas');
      point(window, 'mouseup', -160, 440, true);
    },
    'Alt bypasses alignment, and undo restores the original position'() {
      setup();
      point(card('child'), 'mousedown', 350, 420);
      point(window, 'mousemove', 476, 103, true);
      frame();
      point(window, 'mouseup', 476, 103, true);
      check(app.byId('child').x === 436 && app.byId('child').y === 63, 'Alt did not preserve the free position');
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
      check(app.byId('child').x === 310 && app.byId('child').y === 380, 'undo did not restore the position');
    },
    'grid can be disabled and a drop before the next frame still saves'() {
      setup();
      const grid = document.getElementById('tg-grid');
      grid.click();
      check(!document.getElementById('vp').classList.contains('grid'), 'grid stayed visible');
      app.zoom(-0.5);
      point(card('child'), 'mousedown', 350, 420);
      point(window, 'mousemove', 367, 452);
      point(window, 'mouseup', 367, 452);
      check(app.byId('child').x === 344 && app.byId('child').y === 444, 'drop lost the final pointer position or snapped to a hidden grid');
      check(JSON.parse(localStorage.getItem('ftree_v2')).m.find(m => m.id === 'child').y === 444, 'drop missed browser storage');
      frame();
      grid.click();
    },
    'zooming out from the whole-tree view makes the grid smaller'() {
      setup();
      app.S.scale = 0.1;
      app.zoom(-0.1);
      check(app.S.scale < 0.1, 'zooming out increased the scale');
    },
    'Delete does not remove the selected card during a drag'() {
      setup();
      app.S.sel = 'child';
      point(card('child'), 'mousedown', 350, 420);
      point(window, 'mousemove', 373, 447, true);
      frame();
      let asked = false;
      const confirm = window.confirm;
      window.confirm = () => { asked = true; return false; };
      try {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }));
        point(window, 'mouseup', 373, 447, true);
      } finally {
        window.confirm = confirm;
      }
      check(!asked && app.byId('child').x === 333, 'Delete reached the selected card during the drag');
    },
    'JSON export includes the saved coordinates'() {
      setup();
      point(card('child'), 'mousedown', 350, 420);
      point(window, 'mousemove', 373, 447, true);
      point(window, 'mouseup', 373, 447, true);
      let exported;
      const NativeBlob = window.Blob;
      window.Blob = class extends NativeBlob {
        constructor(parts, options) {
          super(parts, options);
          exported = JSON.parse(parts[0]);
        }
      };
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {};
      try {
        app.saveJSON();
      } finally {
        window.Blob = NativeBlob;
        HTMLAnchorElement.prototype.click = click;
      }
      const result = exported?.mems.find(m => m.id === 'child');
      check(result?.x === 333 && result?.y === 407, 'exported coordinates differ from the canvas');
    },
    'calendar controls show and save both styles for a documented date'() {
      setup();
      app.openEdit('parent');
      const field = id => document.getElementById('e-birth-' + id);
      set(field('calendar'), 'julian');
      set(field('day'), '29');
      set(field('month'), '2');
      set(field('year'), '1900', 'input');
      const preview = field('calendar-preview');
      check(!preview.hidden && preview.textContent.includes('13.03.1900'), 'converted day was not shown in the editor');
      document.querySelector('#m-edit [onclick="app.saveMember()"]').click();
      check(app.byId('parent').birthDateDetail.calendar === 'julian', 'source calendar was not saved');
      check(card('parent').textContent.includes('13.03.1900'), 'card hides the converted day');
    },
    'marriage editor links each child to the selected marriage'() {
      setup();
      app.byId('parent').gender = 'Мужчина';
      app.S.members.push(
        member('spouse-one', 120, 60, {gender:'Женщина'}),
        member('spouse-two', 220, 60, {gender:'Женщина'}),
        member('child-two', 330, 380, {father:'parent'})
      );
      app._norm();
      app._rebuildMap();
      app.openEdit('parent');
      document.querySelector('#m-edit [data-tab="rels"]').click();
      const add = document.querySelector('#m-edit [onclick="app.addMarriage()"]');
      for(const [index,spouse,child] of [[0,'spouse-one','child'],[1,'spouse-two','child-two']]){
        add.click();
        const row=()=>document.querySelectorAll('#e-marriages .marriage-card')[index];
        set(row().querySelector('select[onchange*="spouse"]'),spouse);
        const childRow=[...document.querySelectorAll('#e-kids label')].find(label=>label.querySelector('span')?.textContent===child);
        const checkbox=childRow.querySelector('input');
        if(!checkbox.checked)checkbox.click();
        set(document.querySelector('#e-kids-marriages select[data-child="'+child+'"]'),String(index));
      }
      document.querySelector('#m-edit [onclick="app.saveMember()"]').click();
      check(app.S.marriages.length === 2, 'the two marriages were not saved');
      check(app.S.marriages[0].childIds[0] === 'child' && app.S.marriages[1].childIds[0] === 'child-two',
        'children were assigned to the wrong marriage');
      app.ppOpen('child-two');
      const family=document.getElementById('pp-marriages').textContent;
      check(family.includes('spouse-two') && !family.includes('spouse-one'), 'child profile shows the wrong marriage');
      app.ppClose();
    }
  };
  if (tree) tests['drag on the supplied tree changes only connected paths'] = () => {
    app.S.members = tree.mems;
    app.S.groups = tree.groups;
    app.S.marriages = app._validMarriageRecords(tree.marriages);
    app._norm();
    app._rebuildMap();
    app.render();
    frame();
    const [id, connected] = [...app._connections].sort((a, b) => b[1].length - a[1].length)[0];
    const all = [...svg.children];
    check(all.length > connected.length, 'tree needs both connected and unrelated paths');
    const unrelated = new Set(all.filter(path => !connected.some(line => line.node === path)));
    const observer = new MutationObserver(() => {});
    observer.observe(svg, { subtree: true, childList: true, attributes: true });
    const oldX = app.byId(id).x;
    point(card(id), 'mousedown', 100, 100);
    // Feed several mouse events before each frame to check that work is coalesced.
    for (let i = 1; i <= 30; i++) {
      for (let j = 0; j < 5; j++) point(window, 'mousemove', 100 + 5 * i + j, 100, true);
      frame();
    }
    point(window, 'mouseup', 254, 100, true);
    const records = observer.takeRecords();
    observer.disconnect();
    check(app.byId(id).x > oldX, 'card did not move');
    check(records.length && records.every(r => r.type === 'attributes' && !unrelated.has(r.target)),
      'the move changed an unrelated path or replaced part of the SVG');
    check(records.length <= 31 * connected.length, 'more than one update per connected path and frame');
  };
  const result = [];
  for (const [name, run] of Object.entries(tests)) {
    try { run(); result.push('PASS ' + name); }
    catch (error) { result.push('FAIL ' + name + ' - ' + error.message); }
  }
  const report = document.createElement('pre');
  report.id = 'layout-test-results';
  report.textContent = result.join('\n');
  document.body.append(report);
}

try {
  const html = fs.readFileSync(appFile, 'utf8');
  const fixture = path.join(tmp, 'test.html');
  const tree = process.argv[3] ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) : null;
  const fixtureData = JSON.stringify(tree).replace(/</g, '\\u003c');
  fs.writeFileSync(fixture, html.replace('</body>', () =>
    '<script>(' + inBrowser + ')(' + fixtureData + ');</script></body>'));
  const run = spawnSync(edge, [
    '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + path.join(tmp, 'profile'), '--dump-dom', pathToFileURL(fixture).href
  ], { encoding: 'utf8', timeout: 25000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
  const report = run.stdout.match(/<pre id="layout-test-results">([\s\S]*?)<\/pre>/);
  assert.ok(report, 'Browser did not produce a test report');
  console.log(report[1]);
  process.exitCode = report[1].split('\n').some(line => line.startsWith('FAIL ')) ? 1 : 0;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}
