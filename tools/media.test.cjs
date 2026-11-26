const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../app/family_tree_web_app.html'), 'utf8');
const script = html.match(/<script>([\s\S]+?)<\/script>/)[1];

function fixture() {
  const created = [];
  const written = [];
  const files = new Map();
  function directory(parent) {
    return {
      async getDirectoryHandle(name, { create } = {}) {
        const next = [parent, name].filter(Boolean).join('/');
        if (create) created.push(next);
        return directory(next);
      },
      async getFileHandle(name, { create } = {}) {
        const filePath = parent + '/' + name;
        if (!files.has(filePath)) {
          if (!create) throw new DOMException('Missing file', 'NotFoundError');
          files.set(filePath, null);
        }
        return {
          async getFile() { return { savedAt: filePath, data: files.get(filePath) }; },
          async createWritable() {
            return {
              async write(data) { files.set(filePath, data); written.push({ path: filePath, data }); },
              async close() {}
            };
          }
        };
      }
    };
  }

  const root = directory('');
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, {
        value: '', style: {}, classList: { add() {}, remove() {}, toggle() {} }
      });
      return elements.get(id);
    },
    querySelectorAll: () => []
  };
  const stored = new Map();
  let exportBlob;
  let importText;
  document.createElement = tag => ({
    get innerHTML() { return (this.textContent||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); },
    click() {
      if (tag === 'input') this.onchange({ target: { files: [{ text: importText }] } });
    }
  });
  const sandbox = {
    document, Blob, clearTimeout, setTimeout,
    FileReader: class {
      readAsText(file) { this.onload({ target: { result: file.text } }); }
    },
    localStorage: { setItem: (key, value) => stored.set(key, value) },
    URL: { createObjectURL: blob => {
      if (blob.savedAt) return 'blob:' + blob.savedAt;
      exportBlob = blob;
      return 'blob:export';
    } },
    window: { showDirectoryPicker: async () => root }
  };
  vm.runInNewContext(script.replace('window.app = new App();', 'window.App = App;'), sandbox);
  const app = Object.create(sandbox.window.App.prototype);
  const member = { id: 'person_1' };
  app.S = { members: [member], groups: [], _mediaCache: {} };
  app.map = new Map([[member.id, member]]);
  app._updDir = () => {};
  app.toast = (message, type) => { assert.notEqual(type, 'error', message); };
  let hydrated = false;
  app._hydrateMedia = () => { hydrated = true; };
  return { app, root, created, written, stored, element: document.getElementById,
    getExport: () => exportBlob.text(), wasHydrated: () => hydrated,
    importTree: text => { importText = text; app.loadFile(); },
    importGed: text => { importText = text; app.importGED(); },
    importMerge: text => { importText = text; app.mergeFile(); } };
}

test('connecting the project folder creates no media placeholders', async () => {
  const { app, root, created, wasHydrated } = fixture();
  await app.setupDir();
  assert.equal(app.S.rootDir, root);
  assert.equal(wasHydrated(), true);
  assert.deepEqual(created, []);
});

test('saving a photo creates only the directories required for that file', async () => {
  const { app, root, created, written } = fixture();
  app.S.rootDir = root;
  const data = Buffer.from('photo');
  const file = await app._saveFile('person_1', 'photos', 'photo_01.jpg', data);
  assert.equal(file, 'media/person_1/photos/photo_01.jpg');
  assert.deepEqual(created, ['media', 'media/person_1', 'media/person_1/photos']);
  assert.deepEqual(written, [{ path: file, data }]);
});

test('upload keeps an existing file and previews the written copy after saving', async () => {
  const { app, root, stored, written } = fixture();
  const member = app.byId('person_1');
  app.S.rootDir = root;
  app.S.editing = member.id;
  member.photos = [];
  const original = Buffer.from('existing file');
  const existing = await app._saveFile(member.id, 'photos', 'photo_01.jpg', original);
  app._renderGal = app.render = () => {};
  const file = { name: 'photo_01.jpg' };
  await app.addPhotos({ files: [file], value: 'photo_01.jpg' });
  assert.notEqual(member.photos[0], existing);
  assert.equal(written[0].data, original);
  assert.equal(written.filter(entry => entry.path === existing).length, 1);
  assert.equal(app.S._mediaCache[member.photos[0]], 'blob:' + member.photos[0]);
  assert.equal(JSON.parse(stored.get('ftree_v2')).m[0].photos[0], member.photos[0]);
});

test('cover and avatar framing are saved with the card and reused after reopening', async () => {
  const { app, root, element, stored, getExport, importTree, wasHydrated } = fixture();
  const member = app.byId('person_1');
  Object.assign(member, { name: 'Test', photos: ['media/person_1/portrait.jpg'], previewPhoto: 0 });
  app.S._mediaCache[member.photos[0]] = 'blob:portrait';
  app._fillSel = app._renderRels = app._renderGal = app._push = app.render = app._updStats = app._fillPF = () => {};
  app.openEdit(member.id);
  app.showPhotoFrame();
  assert.equal(element('frame-cover-preview').style.objectPosition, '50% 50%');
  element('frame-x').value = '38';
  element('frame-y').value = '12';
  app.setPhotoFrame();
  assert.equal(element('frame-cover-preview').style.objectPosition, '38% 12%');
  assert.equal(element('frame-avatar-preview').style.objectPosition, '50% 50%');
  assert.equal(member.photoFrames, undefined);
  element('frame-target').value = 'avatar';
  app.showPhotoFrame();
  element('frame-fit').value = 'contain';
  app.setPhotoFrame();
  assert.equal(element('frame-avatar-preview').style.objectFit, 'contain');
  assert.equal(element('frame-cover-preview').style.objectFit, 'cover');
  await app.saveMember();
  const [reloaded] = JSON.parse(stored.get('ftree_v2')).m;
  app.saveJSON();
  const exportText = await getExport();
  const [exported] = JSON.parse(exportText).mems;
  assert.deepEqual(exported.photoFrames, reloaded.photoFrames);
  assert.deepEqual(exported.photos, member.photos);
  app.S.rootDir = root;
  app._updGF = app.fitView = () => {};
  importTree(exportText);
  assert.equal(wasHydrated(), true);
  assert.notEqual(app.byId(member.id), member);
  app.openEdit(member.id);
  app.showPhotoFrame();
  assert.equal(element('frame-cover-preview').style.objectPosition, '38% 12%');
  assert.equal(element('frame-avatar-preview').style.objectFit, 'contain');
  element('frame-y').value = '90';
  app.setPhotoFrame();
  app.closeEdit();
  app.openEdit(member.id);
  app.showPhotoFrame();
  assert.equal(element('frame-cover-preview').style.objectPosition, '38% 12%');
});

test('saved and unsaved framing follows a photo through reordering and removal', () => {
  const { app } = fixture();
  const member = app.byId('person_1');
  const saved = { cover: { x: 50, y: 10, fit: 'cover' } };
  const edited = { cover: { x: 50, y: 30, fit: 'cover' } };
  member.photoFrames = [saved];
  app._photoFrameDraft = [edited];
  app._shiftPhotoFrames(member, 3, 0, 2);
  assert.equal(member.photoFrames[2], saved);
  assert.equal(app._photoFrameDraft[2], edited);
  app._shiftPhotoFrames(member, 3, 1, null);
  assert.equal(member.photoFrames[1], saved);
  assert.equal(app._photoFrameDraft[1], edited);
  app._shiftPhotoFrames(member, 2, 1, null);
  assert.equal(member.photoFrames.length, 0);
  assert.equal(app._photoFrameDraft.length, 0);
});

test('hover preview uses the saved cover frame for the selected photo', () => {
  const { app, element } = fixture();
  const card = { getBoundingClientRect: () => ({ right: 100, top: 25 }) };
  const member = app.byId('person_1');
  member.photos = ['media/person_1/photo_01.jpg', 'media/person_1/photo_02.jpg'];
  member.previewPhoto = 1;
  member.photoFrames = [null, {
    cover: { x: 40, y: 15, fit: 'contain' },
    avatar: { x: 90, y: 80, fit: 'cover' }
  }];
  app.S._mediaCache[member.photos[1]] = 'blob:selected-photo';
  app._showTT(member, card);
  assert.equal(element('tt-img').hidden, false);
  assert.equal(element('tt-photo').src, 'blob:selected-photo');
  assert.equal(element('tt-photo').style.objectPosition, '40% 15%');
  assert.equal(element('tt-photo').style.objectFit, 'contain');

  app._showTT({ photos: ['data:image/png;base64,AA=='] }, card);
  assert.equal(element('tt-photo').style.objectPosition, '50% 50%');
  assert.equal(element('tt-photo').style.objectFit, 'cover');
  app._showTT({ photos: [] }, card);
  assert.equal(element('tt-img').hidden, true);
});

test('profile saves qualified dates, a death without a date and custom suggestions', async () => {
  const { app, element, getExport } = fixture();
  const member = app.byId('person_1');
  Object.assign(member, { name: 'Test', gender: 'Женщина', birthDate: '12,04,1959', isAlive: false, photos: [] });
  app._fillSel = app._renderRels = app._renderGal = app._push = app.render = app._updStats = app._fillPF = () => {};
  app._save = () => {};
  app.openEdit(member.id);
  assert.equal(element('e-birth-day').value, '12');
  assert.equal(element('e-birth-month').value, '4');
  assert.equal(element('e-birth-year').value, '1959');
  assert.equal(element('e-life-dead').checked, true);
  element('e-maiden').value = 'Семейная фамилия';
  element('e-title').value = 'Свой вариант звания';
  element('e-mplace').value = 'Архив <село>';
  element('e-marriage-kind').value = 'between';
  element('e-marriage-year').value = '1980';
  element('e-marriage-end-month').value = '5';
  element('e-marriage-end-year').value = '1982';
  await app.saveMember();
  assert.equal(member.birthDate, '12,04,1959');
  assert.equal(member.isAlive, false);
  assert.equal(member.deathDate || '', '');
  assert.equal(member.maidenName, 'Семейная фамилия');
  assert.equal(member.title, 'Свой вариант звания');
  assert.equal(member.marriageDate, 'между 1980 и 05.1982');
  app.saveJSON();
  const [exported] = JSON.parse(await getExport()).mems;
  assert.deepEqual(exported.marriageDateDetail, { mode: 'between', start: '1980', end: '05.1982' });
  app.openEdit(member.id);
  assert.match(element('profile-places').innerHTML, /Архив &lt;село&gt;/);
  assert.equal(element('e-marriage-end-month').value, '5');
  assert.equal(element('e-marriage-end-year').value, '1982');
  assert.equal(element('e-marriage-kind').value, 'between');
});

test('gender radios disable female surname inputs while preserving stored values', async () => {
  const { app, element } = fixture();
  const member=app.byId('person_1');
  Object.assign(member,{ name:'Test', gender:'Женщина', maidenName:'Прежняя', photos:[] });
  app._fillSel = app._renderRels = app._renderGal = app._push = app.render = app._updStats = app._fillPF = app._save = () => {};
  app.openEdit(member.id);
  assert.equal(element('e-sex-female').checked,true);
  assert.equal(element('e-surname-fields').disabled,false);
  assert.equal(element('e-surname-fields').hidden,false);
  element('e-sex-female').checked=false;
  element('e-sex-male').checked=true;
  app.updateGenderFields();
  assert.equal(element('e-surname-fields').disabled,true);
  assert.equal(element('e-surname-fields').hidden,true);
  element('e-maiden').value='';
  await app.saveMember();
  assert.equal(member.gender,'Мужчина');
  assert.equal(member.maidenName,'Прежняя');
});

test('date entry rejects invalid dates and reversed intervals without changing the profile', () => {
  const { app, element } = fixture();
  const member = app.byId('person_1');
  member.birthDate = '1900';
  app._openProfileDate(member, 'birthDate');
  element('e-birth-day').value = '29';
  element('e-birth-month').value = '2';
  assert.throws(() => app._readProfileDate(member, 'birthDate'), /существующую дату/);
  element('e-birth-kind').value = 'period';
  element('e-birth-day').value = '';
  element('e-birth-month').value = '';
  element('e-birth-year').value = '1902';
  element('e-birth-end-year').value = '1901';
  assert.throws(() => app._readProfileDate(member, 'birthDate'), /позже окончания/);
  assert.equal(member.birthDate, '1900');
  element('e-birth-kind').value = 'text';
  element('e-birth').value = 'После Пасхи 1900 года';
  assert.equal(app._readProfileDate(member, 'birthDate').value, 'После Пасхи 1900 года');
});

test('date controls switch between dropdowns and free text and mark a death entry', () => {
  const { app, element }=fixture();
  const member=app.byId('person_1');
  app._setProfileLife(true);
  app._openProfileDate(member,'deathDate');
  assert.equal(element('e-death-parts').hidden,false);
  assert.equal(element('e-death').hidden,true);
  element('e-death-kind').value='between';
  app.updateProfileDate('deathDate','mode');
  assert.equal(element('e-death-end-group').hidden,false);
  element('e-death-end-year').value='1905';
  app.updateProfileDate('deathDate','parts');
  assert.equal(element('e-life-dead').checked,true);
  assert.equal(element('e-life-alive').checked,false);
  element('e-death-kind').value='text';
  app.updateProfileDate('deathDate','mode');
  assert.equal(element('e-death').hidden,false);
  assert.equal(element('e-death-parts').hidden,true);
  assert.equal(element('e-death-end-group').hidden,true);
});

test('structured names preserve legacy spelling and update relationship references when edited', async () => {
  const { app, element }=fixture();
  const person=app.byId('person_1');
  Object.assign(person,{name:'Миролесова Мария Ивановна (Иванова)',gender:'Женщина',photos:[]});
  const child={id:'child',name:'Ребёнок',mother:person.name};
  app.S.members.push(child);
  app._renderGal=app._push=app._save=app.render=app._updStats=app._fillPF=()=>{};
  app._fillSel=app._renderRels=()=>{};
  app.openEdit(person.id);
  assert.equal(element('e-last-name').value,'Миролесова');
  assert.equal(element('e-first-name').value,'Мария');
  assert.equal(element('e-patronymic').value,'Ивановна');
  await app.saveMember();
  assert.equal(person.name,'Миролесова Мария Ивановна (Иванова)');
  app.openEdit(person.id);
  element('e-patronymic').value='Ильинична';
  await app.saveMember();
  assert.equal(person.firstName,'Мария');
  assert.equal(person.lastName,'Миролесова');
  assert.equal(person.patronymic,'Ильинична');
  assert.equal(child.mother,person.name);
  assert.match(person.name,/\(Иванова\)$/);
});

test('GEDCOM date ranges and partial dates keep their precision', () => {
  const { app } = fixture();
  const month = app._parseGedProfileDate('FEB 1902');
  assert.equal(month.value, '02.1902');
  assert.equal(app._gedProfileDate({ birthDate: month.value }, 'birthDate'), 'FEB 1902');
  const range = app._parseGedProfileDate('BET 1902 AND 4 APR 1904');
  assert.equal(range.value, 'между 1902 и 04.04.1904');
  assert.equal(app._gedProfileDate({ birthDate: range.value, birthDateDetail: range.detail }, 'birthDate'),
    'BET 1902 AND 4 APR 1904');
  assert.equal(app._parseGedProfileDate('1902').value, '1902');
});

test('GEDCOM round trip restores marriage facts for distinct spouses', async () => {
  const { app, getExport, importGed } = fixture();
  const first=app.byId('person_1');
  Object.assign(first, { name:'First', gender:'Неизвестно', spouse:'Second',
    birthDate:'1900', marriageDate:'05.1920', marriagePlace:'Place', title:'Ротмистр',
    deathPlace:'Town', deathCause:'Болезнь', isAlive:false });
  app.S.members.push({ id:'person_2', name:'Second', gender:'Женщина', spouse:'First' });
  app._push = app._updGF = app.render = app.fitView = app._updStats = app._fillPF = app._save = () => {};
  app.exportGED();
  const ged=await getExport();
  assert.match(ged,/1 HUSB @person_1@\n1 WIFE @person_2@/);
  importGed(ged);
  const restored=app.S.members.find(member=>member.name==='First');
  assert.equal(restored.spouse,'Second');
  assert.equal(restored.birthDate,'1900');
  assert.equal(restored.marriageDate,'05.1920');
  assert.equal(restored.marriagePlace,'Place');
  assert.equal(restored.deathPlace,'Town');
  assert.equal(restored.deathCause,'Болезнь');
  assert.equal(restored.title,'Ротмистр');
});

test('marriage and divorce preserve separate dates and the original union type', async () => {
  const { app, element, getExport, importGed, importTree }=fixture();
  const owner=app.byId('person_1');
  const partner={id:'spouse',name:'Второй супруг',gender:'Мужчина'};
  app.S.members.push(partner);
  app._rebuildMap();
  app._push=app._updGF=app.render=app.fitView=app._updStats=app._fillPF=app._save=()=>{};
  app.S.editing=owner.id;
  app.S.marriages=[{id:'u',partnerIds:[owner.id,partner.id],childIds:[],relationType:'official',marriageDate:'1900'}];
  app._openMarriageDraft(owner);
  assert.match(element('e-marriages').innerHTML,/Дата развода/);
  app.editMarriage(0,'divorceCalendar','julian');
  app.editMarriage(0,'divorceDate','06.02.1918');
  app.S.marriages=app._validateMarriageDraft(owner);
  app.saveJSON();
  importTree(await getExport());
  assert.equal(app.S.marriages[0].divorceDate,'06.02.1918');
  app.exportGED();
  const ged=await getExport();
  assert.match(ged,/1 MARR\n2 DATE 1900\n1 DIV\n2 DATE @#DJULIAN@ 6 FEB 1918/);
  importGed(ged);
  const restored=app.S.marriages[0];
  assert.equal(restored.relationType,'official');
  assert.equal(app._isDivorced(restored),true);
  assert.equal(restored.marriageDate,'1900');
  assert.equal(restored.divorceDate,'06.02.1918');
  assert.match(app._displayProfileDate(restored,'divorceDate'),/19\.02\.1918/);
});

test('legacy undated divorce preserves marriage date and refuses unambiguously reversed dates', () => {
  const { app }=fixture();
  const owner=app.byId('person_1');
  const partner={id:'spouse',name:'Супруга',gender:'Женщина'};
  app.S.members.push(partner);
  app._rebuildMap();
  app.S.editing=owner.id;
  app.S.marriages=[{id:'u',partnerIds:[owner.id,partner.id],childIds:[],relationType:'divorce',marriageDate:'1910'}];
  app._openMarriageDraft(owner);
  assert.equal(app._validateMarriageDraft(owner),null);
  app.editMarriage(0,'divorceDate','1909');
  assert.throws(()=>app._validateMarriageDraft(owner),/Дата развода раньше/);
  app.editMarriage(0,'divorceDate','1910');
  assert.equal(app._validateMarriageDraft(owner)[0].marriageDate,'1910');
});

test('the divorce date alone controls status and children stay in their own section', () => {
  const { app, element }=fixture();
  const owner=app.byId('person_1');
  const partner={id:'spouse',name:'Другой супруг',gender:'Мужчина'};
  const child={id:'child',name:'Ребёнок',father:partner.name,mother:owner.name};
  app.S.members.push(partner,child);
  app._rebuildMap();
  app.S.editing=owner.id;
  app._relationDraft={children:[child.name],siblings:[]};
  app.S.marriages=[{id:'u',partnerIds:[owner.id,partner.id],childIds:[child.id],relationType:'divorce',divorced:true,marriageDate:'1900'}];
  app._openMarriageDraft(owner);
  assert.doesNotMatch(element('e-marriages').innerHTML,/Развод состоялся|marriage-children|Добавить ребёнка/);
  assert.match(element('e-kids-marriages').innerHTML,/Ребёнок/);
  assert.equal(app._isDivorced(app.S.marriages[0]),false);
  app.editMarriage(0,'divorceDate','17,12,2019');
  assert.equal(app._marriageDraft[0].divorceDate,'17.12.2019');
  assert.equal(app._isDivorced(app._marriageDraft[0],new Date(2019,11,16)),false);
  assert.equal(app._isDivorced(app._marriageDraft[0],new Date(2019,11,17)),true);
  app.editMarriage(0,'divorceDate','');
  assert.equal(app._isDivorced(app._validateMarriageDraft(owner)[0]),false);
  assert.deepEqual(Array.from(app._marriageDraft[0].childIds),[child.id]);
  app.setMarriageChild(child.id,'');
  assert.equal(app._marriageDraft[0].childIds.length,0);
  assert.deepEqual(app._relationDraft.children,[child.name]);
});

test('two marriages retain separate children in JSON and GEDCOM', async () => {
  const { app, getExport, importTree, importGed }=fixture();
  const owner=app.byId('person_1');
  Object.assign(owner,{name:'Отец',gender:'Мужчина',photos:[]});
  const records=[
    {id:'s1',name:'Первая',gender:'Женщина'}, {id:'s2',name:'Вторая',gender:'Женщина'},
    {id:'c1',name:'Старший',gender:'Мужчина'}, {id:'c2',name:'Младшая',gender:'Женщина'}
  ];
  app.S.members.push(...records);
  app._rebuildMap();
  app._push=app._updGF=app.render=app.fitView=app._updStats=app._fillPF=app._save=()=>{};
  app.S.marriages=[
    {id:'u1',partnerIds:[owner.id,'s1'],childIds:['c1'],relationType:'divorce',marriageDate:'1920',marriagePlace:''},
    {id:'u2',partnerIds:[owner.id,'s2'],childIds:['c2'],relationType:'official',marriageDate:'1930',marriagePlace:''}
  ];
  app.saveJSON();
  const json=await getExport();
  assert.equal(JSON.parse(json).marriages.length,2);
  importTree(json);
  assert.equal(app._marriageRecords().length,2);
  app.exportGED();
  const ged=await getExport();
  assert.equal((ged.match(/@ FAM\n/g)||[]).length,2);
  importGed(ged);
  const restored=app._marriageRecords().map(record=>[
    record.partnerIds.map(id=>app.byId(id).name).find(name=>name!=='Отец'),
    record.childIds.map(id=>app.byId(id).name)[0]
  ]).sort();
  assert.deepEqual(JSON.parse(JSON.stringify(restored)),[['Вторая','Младшая'],['Первая','Старший']]);
});

test('card editing migrates the legacy union only on change and keeps its children separate', async () => {
  const { app, element }=fixture();
  const owner=app.byId('person_1');
  Object.assign(owner,{name:'Отец',gender:'Мужчина',spouse:'Первая',photos:[]});
  const first={id:'s1',name:'Первая',gender:'Женщина',spouse:'Отец'};
  const second={id:'s2',name:'Вторая',gender:'Женщина'};
  const older={id:'c1',name:'Старший',father:'Отец',mother:'Первая'};
  const younger={id:'c2',name:'Младшая',father:'Отец'};
  app.S.members.push(first,second,older,younger);
  app._rebuildMap();
  app._fillSel=app._renderRels=app._renderGal=app._push=app.render=app._updStats=app._fillPF=app._save=()=>{};
  app.openEdit(owner.id);
  element('e-spouse').value=first.name;
  assert.equal(app._validateMarriageDraft(owner),null);
  app.addMarriage();
  app.editMarriage(1,'spouse',second.id);
  app.editMarriage(1,'calendar','julian');
  app.editMarriage(1,'marriageDate','29.02.1900');
  app.setMarriageChild(older.id,'1');
  assert.throws(()=>app._validateMarriageDraft(owner),/указан другой родитель/);
  app.setMarriageChild(older.id,'0');
  app.setMarriageChild(younger.id,'1');
  await app.saveMember();
  assert.equal(app.S.marriages.length,2);
  assert.deepEqual(JSON.parse(JSON.stringify(app.S.marriages.map(record=>record.childIds))),[['c1'],['c2']]);
  assert.equal(younger.mother,second.name);
  assert.equal(older.mother,first.name);
  assert.match(app._displayProfileDate(app.S.marriages[1],'marriageDate'), /13\.03\.1900/);
  app.openEdit(owner.id);
  element('e-spouse').value=first.name;
  app.removeMarriage(0);
  await app.saveMember();
  assert.equal(app._marriageRecords().length,1);
  assert.equal(older.mother,first.name);
});

test('merging a JSON union links matched local cards by their existing IDs', () => {
  const { app, importMerge } = fixture();
  Object.assign(app.byId('person_1'),{name:'Первый',gender:'Мужчина'});
  app.S.members.push({id:'local-spouse',name:'Вторая',gender:'Женщина'},{id:'local-child',name:'Ребёнок',gender:'Женщина'});
  app._rebuildMap();
  app._renderMerge=app._push=app._save=app.render=app._updStats=app._fillPF=()=>{};
  importMerge(JSON.stringify({mems:[
    {id:'imported-first',name:'Первый',gender:'Мужчина',title:'Новое звание'},
    {id:'imported-second',name:'Вторая',gender:'Женщина'},
    {id:'imported-child',name:'Ребёнок',gender:'Женщина'}
  ],marriages:[{id:'merge-union',partnerIds:['imported-first','imported-second'],childIds:['imported-child']}]}));
  app.doMerge();
  assert.equal(app.byId('person_1').title,'Новое звание');
  assert.deepEqual(JSON.parse(JSON.stringify(app.S.marriages[0].partnerIds)),['person_1','local-spouse']);
  assert.deepEqual(JSON.parse(JSON.stringify(app.S.marriages[0].childIds)),['local-child']);
});

test('GEDCOM keeps parents outside a marriage and preserves the type of a recorded union', async () => {
  const { app, getExport, importGed }=fixture();
  const member=app.byId('person_1');
  Object.assign(member,{name:'Отец',gender:'Мужчина'});
  app.S.members.push(
    {id:'sp',name:'Партнёр',gender:'Женщина'},
    {id:'c',name:'Ребёнок',father:'Отец',mother:'Партнёр',gender:'Женщина'}
  );
  app._rebuildMap();
  app.S.marriages=[{id:'u',partnerIds:['person_1','sp'],childIds:[],relationType:'broken',marriageDate:'1936'}];
  app._push=app._updGF=app.render=app.fitView=app._updStats=app._fillPF=app._save=()=>{};
  app.exportGED();
  const ged=await getExport();
  assert.match(ged,/_FTREE_PARENTAGE Y/);
  importGed(ged);
  const child=app.S.members.find(m=>m.name==='Ребёнок');
  assert.equal(child.father,'Отец');
  assert.equal(child.mother,'Партнёр');
  assert.equal(app.S.marriages.length,1);
  assert.equal(app.S.marriages[0].childIds.length,0);
  assert.equal(app.S.marriages[0].relationType,'broken');
});

test('changing calendar in a recorded marriage preserves the date qualifier and range', () => {
  const { app }=fixture();
  const record={marriageDate:'между 29.02.1900 и 20.03.1900',marriageDateDetail:{
    mode:'between',start:'29.02.1900',end:'20.03.1900',endCalendar:'gregorian'
  }};
  app._marriageDraft=[record];
  app.editMarriage(0,'calendar','julian');
  assert.equal(record.marriageDateDetail.mode,'between');
  assert.equal(record.marriageDateDetail.endCalendar,'gregorian');
  assert.match(app._displayProfileDate(record,'marriageDate'), /13\.03\.1900/);
  app.editMarriage(0,'calendar','');
  assert.equal(record.marriageDateDetail.mode,'between');
  assert.equal(record.marriageDateDetail.calendar,undefined);
});
