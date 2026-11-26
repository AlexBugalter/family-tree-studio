const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../app/family_tree_web_app.html'), 'utf8');
const script = html.match(/<script>([\s\S]+?)<\/script>/)[1];

function editor() {
  const fields = new Map();
  const field = id => {
    if (!fields.has(id)) fields.set(id, { value: '', innerHTML: '', textContent: '', hidden: false });
    return fields.get(id);
  };
  const context = { window: {}, document: { getElementById: field } };
  vm.runInNewContext(script.replace('window.app = new App();', 'window.App = App;'), context);
  return { app: Object.create(context.window.App.prototype), field };
}

test('the entered style determines leap day validation and the displayed counterpart', () => {
  const { app, field } = editor();
  const member = { birthDate: '1900' };
  app._openProfileDate(member, 'birthDate');
  field('e-birth-calendar').value = 'julian';
  field('e-birth-day').value = '29';
  field('e-birth-month').value = '2';
  app.updateProfileDate('birthDate', 'parts');
  assert.match(field('e-birth-calendar-preview').textContent, /29\.02\.1900.*13\.03\.1900/);
  const saved = app._readProfileDate(member, 'birthDate');
  assert.equal(saved.value, '29.02.1900');
  assert.equal(saved.detail.calendar, 'julian');
  const reopened = { birthDate: saved.value, birthDateDetail: saved.detail };
  app._openProfileDate(reopened, 'birthDate');
  assert.equal(field('e-birth-day').value, '29');
  assert.equal(field('e-birth-calendar').value, 'julian');
  assert.equal(app._readProfileDate(reopened, 'birthDate'), null);
  field('e-birth-calendar').value = 'gregorian';
  assert.throws(() => app._readProfileDate(reopened, 'birthDate'), /существующую дату/);
});

test('Gregorian timeline year follows a Julian date across New Year with source text preserved', () => {
  const { app } = editor();
  const member = { birthDate: '28.12.1899', birthDateDetail: { mode: 'exact', calendar: 'julian', start: '28.12.1899' } };
  assert.equal(app._profileYear(member, 'birthDate'), 1900);
  assert.match(app._displayProfileDate(member, 'birthDate'), /28\.12\.1899.*09\.01\.1900/);
  const gregorian = { marriageDate: '14.02.1918', marriageDateDetail: { mode: 'exact', calendar: 'gregorian', start: '14.02.1918' } };
  assert.match(app._displayProfileDate(gregorian, 'marriageDate'), /14\.02\.1918.*01\.02\.1918/);
});

test('legacy and incomplete dates do not get fabricated days or calendar metadata', () => {
  const { app, field } = editor();
  const legacy = { birthDate: '1901-03-15' };
  app._openProfileDate(legacy, 'birthDate');
  assert.equal(field('e-birth-calendar').value, '');
  assert.equal(app._displayProfileDate(legacy, 'birthDate'), '1901-03-15');
  assert.equal(app._readProfileDate(legacy, 'birthDate'), null);
  field('e-birth-calendar').value = 'julian';
  field('e-birth-day').value = '';
  app.updateProfileDate('birthDate', 'parts');
  const saved = app._readProfileDate(legacy, 'birthDate');
  assert.equal(saved.value, '03.1901');
  assert.equal(saved.detail.calendar, 'julian');
  assert.doesNotMatch(field('e-birth-calendar-preview').textContent, /\d{2}\.\d{2}\.\d{4}/);
  app._openProfileDate({ deathDate: 'около Пасхи 1876' }, 'deathDate');
  assert.equal(field('e-death-calendar').hidden, true);
  assert.equal(field('e-death-calendar-preview').textContent, '');
});

test('GEDCOM calendar escapes round-trip exact, approximate, and mixed calendar ranges', () => {
  const { app } = editor();
  for (const value of [
    '@#DJULIAN@ 29 FEB 1900',
    'ABT @#DGREGORIAN@ 1900',
    'BET @#DJULIAN@ 28 DEC 1899 AND @#DGREGORIAN@ 11 JAN 1900'
  ]) {
    const date = app._parseGedProfileDate(value);
    assert.notEqual(date.detail.mode, 'text');
    assert.equal(app._gedProfileDate({ birthDate: date.value, birthDateDetail: date.detail }, 'birthDate'), value);
  }
  assert.equal(app._parseGedProfileDate('15 MAR 1901').detail, null);
});

test('calendar shift spans the 1582 transition and varies by century', () => {
  const { app } = editor();
  for (const [julian, gregorian] of [
    ['04.10.1582', '14.10.1582'],
    ['29.02.1700', '11.03.1700'],
    ['29.02.1800', '12.03.1800'],
    ['29.02.1900', '13.03.1900'],
    ['29.02.2000', '13.03.2000']
  ]) {
    const styles = { julian, gregorian };
    for (const [calendar, value] of Object.entries(styles)) {
      const member = { birthDate: value, birthDateDetail: { mode: 'exact', calendar, start: value } };
      const shown = app._displayProfileDate(member, 'birthDate');
      assert.ok(shown.startsWith(value));
      assert.ok(shown.includes(styles[calendar === 'julian' ? 'gregorian' : 'julian']));
    }
  }
});

test('mixed calendar date ranges compare the underlying day and retain both styles', () => {
  const { app, field } = editor();
  const member = {};
  app._openProfileDate(member, 'marriageDate');
  field('e-marriage-kind').value = 'between';
  field('e-marriage-calendar').value = 'julian';
  field('e-marriage-day').value = '28';
  field('e-marriage-month').value = '12';
  field('e-marriage-year').value = '1899';
  field('e-marriage-end-calendar').value = 'gregorian';
  field('e-marriage-end-day').value = '8';
  field('e-marriage-end-month').value = '1';
  field('e-marriage-end-year').value = '1900';
  assert.throws(() => app._readProfileDate(member, 'marriageDate'), /начало диапазона позже окончания/);
  field('e-marriage-end-day').value = '9';
  const saved = app._readProfileDate(member, 'marriageDate');
  assert.equal(saved.detail.calendar, 'julian');
  assert.equal(saved.detail.endCalendar, 'gregorian');
});
