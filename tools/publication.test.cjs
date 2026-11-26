const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const publication = require('../app/tree_publication.js');

const editor = fs.readFileSync(path.join(__dirname,'../app/family_tree_web_app.html'),'utf8');
const script = editor.match(/<script>([\s\S]+?)<\/script>/)[1];
function setup() {
  const context = { window: {} };
  vm.runInNewContext(script.replace('window.app = new App();','window.App = App;'), context);
  const app = Object.create(context.window.App.prototype);
  app.map = new Map();
  app.S = {
    members: [
      {id:'parent',name:'Алёна Мирова',gender:'Женщина',birthDate:'01.01.1900',x:-100,y:-32,
        photos:['media/a.jpg','media/b.jpg'],previewPhoto:1,photoFrames:[null,{cover:{fit:'contain',x:35,y:25}}],
        phone:'DO-NOT-PUBLISH',residence:'DO-NOT-PUBLISH',bio:'Биография <script>alert(1)</script>'},
      {id:'child',name:'Иван Миров',mother:'Алёна Мирова',birthDate:'1925',x:250,y:570,photos:['media/b.jpg']},
      {id:'partner',name:'Пётр Миров',x:120,y:-32}
    ], groups: [], marriages: [{ id:'union',partnerIds:['parent','partner'],childIds:['child'],relationType:'official',
      marriageDate:'1922', divorced:true, divorceDate:'1933' }]
  };
  app._rebuildMap();
  return app;
}

test('publication snapshots saved coordinates, dates, links and omits private fields', () => {
  const app = setup();
  const before = JSON.stringify(app.S);
  const model = publication.collect(app);
  const [parent,child] = model.people;
  assert.equal(child.x - parent.x,350);
  assert.equal(child.y - parent.y,602);
  assert.equal(child.links.find(link => link.label === 'Мать').index,0);
  assert.equal(parent.marriages[0].children[0],1);
  assert.deepEqual({...parent.frame},{fit:'contain',x:35,y:25});
  assert.ok(model.edges.some(edge => edge.kind === 'child' && edge.a === 0 && edge.b === 1));
  const html = publication.build(model,{title:'Дерево <А>'});
  assert.match(html,/Дерево &lt;А&gt;/);
  assert.match(html,/href="#person-1"/);
  assert.match(html,/id="person-1"/);
  assert.match(html,/Дата союза · 1922<\/div>\s*<div>Дата развода · 1933/);
  assert.match(html,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html,/DO-NOT-PUBLISH|<script>\s*alert\(1\)|tree_publication\.js/);
  assert.equal(JSON.stringify(app.S),before);
});

test('embeds shared safe images once and keeps a usable fallback for missing images', async () => {
  const model = publication.collect(setup());
  const unavailable = await publication.embedPhotos(model,async source =>
    source === 'media/b.jpg' ? 'data:image/jpeg;base64,YWJj' : 'data:image/svg+xml;base64,YWJj');
  assert.equal(unavailable,1);
  assert.equal(model.photos.length,1);
  assert.equal(model.people[0].cover,0);
  assert.equal(model.people[1].cover,0);
  const html = publication.build(model);
  assert.equal(html.match(/data:image\/jpeg;base64,YWJj/g).length,1);
  assert.match(html,/object-fit:contain;object-position:35% 25%/);
  assert.doesNotMatch(html,/media\/a.jpg|media\/b.jpg|data:image\/svg/);
});

test('print version contains all profiles and links even when bios and photos are excluded', () => {
  const model = publication.collect(setup(),{includePhotos:false,includeBio:false});
  assert.ok(model.people.every(person => !person.bio && person.sources.length === 0));
  const html = publication.build(model,{print:true});
  assert.match(html,/id="print-index"/);
  assert.match(html,/id="print-now"/);
  assert.match(html,/href="#print-index"/);
  assert.ok((html.match(/class="print-tile"/g) || []).length >= 2);
  assert.equal((html.match(/id="person-\d+"/g) || []).length,3);
  assert.doesNotMatch(html,/Биография|data-photo="/);
});
