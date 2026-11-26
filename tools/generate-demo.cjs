// All people, places and events below are fictional and independent of any project data.
const fs = require('node:fs');
const path = require('node:path');

const groups = [
  { id: 'demo_g_linden', name: 'Липовая ветвь', color: '#257f70' },
  { id: 'demo_g_river', name: 'Речная ветвь', color: '#6c52a3' },
  { id: 'demo_g_garden', name: 'Садовая ветвь', color: '#b66542' }
];
const [linden, river, garden] = groups.map(group => group.id);
const people = [
  ['stepan','Степан Липовец','Мужчина','01.02.1876','1952',260,60,linden],
  ['vera','Вера Липовец','Женщина','1881','1964',500,60,linden],
  ['matvei','Матвей Береговой','Мужчина','1885','1959',846,60,river],
  ['sofya','Софья Береговая','Женщина','1887','1972',1086,60,river],
  ['pavel','Павел Степанович Липовец','Мужчина','1908','1987',240,430,linden],
  ['daria','Дарья Матвеевна Липовец','Женщина','1910','1992',480,430,river],
  ['rina','Ирина Степановна Яснолистова','Женщина','1914','1991',730,430,linden],
  ['boris','Борис Яснолистов','Мужчина','1912','1985',970,430,garden],
  ['vadim','Вадим Павлович Липовец','Мужчина','1936','2012',80,800,linden],
  ['marina','Марина Садовая','Женщина','1937','2008',320,800,garden],
  ['timur','Тимур Береговой','Мужчина','1935','2016',590,800,river],
  ['olga','Ольга Павловна Береговая','Женщина','1939','2024',830,800,linden],
  ['irakli','Ираклий Камышов','Мужчина','1941','2018',1070,800,garden],
  ['nadia','Надежда Борисовна Яснолистова','Женщина','1946','',1310,800,garden],
  ['lidia','Лидия Вадимовна Липовец','Женщина','1964','',80,1170,linden],
  ['lev','Лев Садовый','Мужчина','1963','',320,1170,garden],
  ['mila','Мила Тимуровна Береговая','Женщина','1968','',610,1170,river],
  ['roman','Роман Ираклиевич Камышов','Мужчина','1975','',1040,1170,garden],
  ['maxim','Максим Львович Садовый','Мужчина','1996','',200,1540,garden]
];
const mems = people.map(([key,name,gender,birthDate,deathDate,x,y,group]) => ({
  id: 'demo_' + key, name, gender, birthDate, deathDate, x, y,
  groupIds: [group], isAlive: !deathDate, children: [], siblings: [], photos: [], videos: [], previewPhoto: 0
}));
const lookup = Object.fromEntries(mems.map(person => [person.id.slice(5),person]));
function family(fatherKey,motherKey,childKeys,relationType,marriageDate) {
  const father = lookup[fatherKey], mother = lookup[motherKey];
  const children = childKeys.map(key => lookup[key]);
  father.children.push(...children.map(p => p.name));
  mother.children.push(...children.map(p => p.name));
  for (const child of children) {
    child.father = father.name;
    child.mother = mother.name;
    child.siblings.push(...children.filter(member => member !== child).map(member => member.name));
  }
  return { id:'demo_union_'+fatherKey+'_'+motherKey, partnerIds:[father.id,mother.id],
    childIds:children.map(p => p.id), relationType, marriageDate, marriagePlace:'Ивовый Лог (вымышленный)' };
}
const marriages = [
  family('stepan','vera',['pavel','rina'],'official','1905'),
  family('matvei','sofya',['daria'],'official','1907'),
  family('pavel','daria',['vadim','olga'],'official','1931'),
  family('boris','rina',['nadia'],'official','1938'),
  family('vadim','marina',['lidia'],'official','1959'),
  family('timur','olga',['mila'],'divorce','1962'),
  family('irakli','olga',['roman'],'official','1973'),
  family('lev','lidia',['maxim'],'civil','1990')
];
Object.assign(lookup.stepan, {
  birthDateDetail:{mode:'exact',start:'01.02.1876',end:'',calendar:'julian'},
  birthPlace:'Ивовый Лог (вымышленный)',
  bio:'Степан — вымышленный персонаж. В демонстрационной истории он мастерил музыкальные инструменты для ярмарок.'
});
Object.assign(lookup.daria, {maidenName:'Береговая',marriedName:'Липовец',
  bio:'Вымышленный пример биографии: Дарья вела тетрадь с зарисовками растений и посылала гербарии знакомым.'});
Object.assign(lookup.olga, {maidenName:'Липовец',marriedName:'Береговая',
  bio:'Два союза и дети в каждом показывают работу семейных связей. Все персонажи вымышлены.'});
const tree = { exportDate:'2026-11-26T00:00:00.000Z', mems, groups, marriages };
const target = process.argv[2] || path.resolve(__dirname,'../demo/tree.json');
fs.writeFileSync(target, JSON.stringify(tree, null, 2) + '\n');
