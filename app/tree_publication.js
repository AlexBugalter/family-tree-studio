/* Published documents contain only the selected display fields and their own reader. */
(function () {
  'use strict';
  const cardWidth = 200;
  const cardHeight = 145;
  const quality = .83;
  const format = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
  const inertJson = value => JSON.stringify(value).replaceAll('<', '\\u003c');
  const profileLink = person => '#person-' + person.index;
  const facts = [
    ['Девичья фамилия','maidenName'], ['Фамилия после брака','marriedName'], ['Звание','title'],
    ['Место рождения','birthPlace'], ['Место смерти','deathPlace'], ['Место захоронения','burialPlace'],
    ['Национальность','nationality'], ['Статус','status']
  ];
  const unionTypes = {official:'Официальный брак',civil:'Гражданский союз',divorce:'Развод',
    broken:'Прерванный союз',conflict:'Конфликтный союз'};

  function collect(app, { includePhotos = true, includeBio = true } = {}) {
    const members = app.S.members;
    const indexes = new Map(members.map((member, index) => [member.id, index]));
    const knownGroups = new Map(app.S.groups.map(group => [group.id, group.name]));
    const names = new Map();
    for (const member of members) if (!names.has(member.name)) names.set(member.name, member.id);
    const resolve = reference => indexes.has(reference) ? reference : names.get(reference);
    const marriages = app._marriageRecords();
    const graph = app._branchGraph(true);
    const xOf = (member, index) => Number.isFinite(member.x) ? member.x : (index % 8) * 240;
    const yOf = (member, index) => Number.isFinite(member.y) ? member.y : Math.floor(index / 8) * 220;
    const minX = Math.min(...members.map(xOf));
    const minY = Math.min(...members.map(yOf));
    const people = members.map((member, index) => {
      const tree = graph.get(member.id);
      const add = (label, ids) => [...ids].filter(id => id !== member.id && indexes.has(id))
        .map(id => ({ label, index: indexes.get(id) }));
      const father = resolve(member.father);
      const mother = resolve(member.mother);
      const birth = app._displayProfileDate(member, 'birthDate');
      const death = app._displayProfileDate(member, 'deathDate');
      const details = [
        ['Дата рождения', birth], ['Дата смерти', death],
        ...facts.map(([label, key]) => [label, member[key]])
      ].filter(([, value]) => typeof value === 'string' && value.trim());
      return {
        index, name: member.name || 'Имя неизвестно',
        x: Math.round(xOf(member, index) - minX + 25), y: Math.round(yOf(member, index) - minY + 25),
        female: member.gender === 'Женщина',
        short: [app._briefProfileDate(member,'birthDate'), app._briefProfileDate(member,'deathDate')].filter(Boolean).join(' — '),
        details, groups: (member.groupIds || []).map(id => knownGroups.get(id)).filter(Boolean),
        links: [
          ...add('Отец', [father]), ...add('Мать', [mother]),
          ...add('Родитель', [...tree.parents].filter(id => id !== father && id !== mother)),
          ...add('Супруг(а)', tree.partners), ...add('Брат или сестра', app._branchSiblings(member.id, graph)),
          ...add('Ребёнок', tree.children)
        ],
        marriages: marriages.filter(record => record.partnerIds.includes(member.id) || record.childIds.includes(member.id)).map(record => ({
          own: record.partnerIds.includes(member.id),
          partners: record.partnerIds.filter(id => id !== member.id && indexes.has(id)).map(id => indexes.get(id)),
          children: record.childIds.filter(id => indexes.has(id)).map(id => indexes.get(id)),
          date: app._displayProfileDate(record, 'marriageDate'), place: record.marriagePlace,
          type: Object.hasOwn(unionTypes, record.relationType) ? unionTypes[record.relationType] : ''
        })),
        bio: includeBio && typeof member.bio === 'string' ? member.bio : '',
        sources: includePhotos ? (member.photos || []).filter(source => typeof source === 'string' && source) : [],
        coverSource: includePhotos ? member.photos?.[member.previewPhoto || 0] : undefined,
        frame: app._photoFrame(member.photoFrames, member.previewPhoto || 0, 'cover')
      };
    });
    const edges = [];
    for (const [id, link] of graph) {
      const a = indexes.get(id);
      for (const child of link.children) {
        if (indexes.has(child)) edges.push({ a, b: indexes.get(child), kind: 'child' });
      }
      for (const partner of link.partners) {
        const b = indexes.get(partner);
        if (b > a) edges.push({ a, b, kind: 'partner' });
      }
    }
    return { people, edges, photos: [] };
  }

  async function embedPhotos(model, load, progress = () => {}) {
    const sources = [...new Set(model.people.flatMap(person => person.sources))];
    const map = new Map();
    let done = 0;
    async function worker() {
      for (;;) {
        const source = sources.pop();
        if (!source) return;
        try {
          const result = await load(source);
          if (/^data:image\/(?:jpeg|png|webp);base64,[a-zA-Z0-9+/=]+$/.test(result || '')) {
            map.set(source, model.photos.length);
            model.photos.push(result);
          }
        } catch { /* A missing image leaves its card usable. */ }
        progress(++done);
      }
    }
    await Promise.all(Array.from({length: Math.min(3, sources.length)}, worker));
    for (const person of model.people) {
      person.photos = person.sources.filter(source => map.has(source)).map(source => map.get(source));
      person.cover = map.get(person.coverSource) ?? person.photos[0];
      if (!map.has(person.coverSource) && person.cover !== undefined) person.frame = {fit:'cover',x:50,y:50};
    }
    return done - map.size;
  }

  async function localPhoto(app, source) {
    // Publication is offline. Do not fetch remote URLs during export.
    if (/^https?:\/\//i.test(source) || /^data:image\/svg/i.test(source)) return '';
    const url = await app._mediaURL(source);
    if (!/^(?:blob:|data:image\/(?!svg))/i.test(url)) return '';
    const response = await fetch(url);
    const blob = await response.blob();
    if (/svg/i.test(blob.type)) return '';
    const image = await createImageBitmap(blob);
    try {
      const ratio = Math.min(1, 1400 / Math.max(image.width, image.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.width * ratio));
      canvas.height = Math.max(1, Math.round(image.height * ratio));
      const ctx = canvas.getContext('2d', {alpha:false});
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', quality);
    } finally { image.close(); }
  }

  function edgePath(edge, people) {
    const a = people[edge.a], b = people[edge.b];
    const ax = a.x + cardWidth / 2, ay = a.y + cardHeight / 2;
    const bx = b.x + cardWidth / 2, by = b.y + cardHeight / 2;
    if (edge.kind === 'child' && Math.abs(ay - by) >= cardHeight) {
      const direction = Math.sign(by - ay);
      const start = ay + direction * cardHeight / 2;
      const end = by - direction * cardHeight / 2;
      const middle = (start + end) / 2;
      return `M${ax} ${start}V${middle}H${bx}V${end}`;
    }
    const direction = Math.sign(bx - ax);
    const start = ax + direction * cardWidth / 2;
    const end = bx - direction * cardWidth / 2;
    const middle = (start + end) / 2;
    return `M${start} ${ay}H${middle}V${by}H${end}`;
  }

  function profileReference(person, label = '') {
    return `<a href="${profileLink(person)}">${label ? format(label) + ' · ' : ''}${format(person.name)}</a>`;
  }

  function card(person, print = false) {
    const { x, y, name, short, female, cover, frame } = person;
    const coverImage = !print && cover !== undefined ?
      `<img alt="" data-photo="${cover}" style="object-fit:${frame.fit};object-position:${frame.x}% ${frame.y}%">` : '';
    return `<a class="map-card ${female ? 'female' : ''}" href="${profileLink(person)}" title="${format(name)}" style="left:${x}px;top:${y}px">
      ${coverImage}<span class="map-label"><strong>${format(name)}</strong>${short ? `<small>${format(short)}</small>` : ''}</span></a>`;
  }

  function profile(person, people) {
    const pairs = person.details.map(([key,value]) => `<dt>${format(key)}</dt><dd>${format(value)}</dd>`).join('');
    const refs = person.links.map(link => `<li>${profileReference(people[link.index],link.label)}</li>`).join('');
    const unions = person.marriages.map(record => `<li>
      <strong>${record.own ? 'Союз' : 'Союз родителей'}</strong> · ${record.partners.map(i => profileReference(people[i])).join(', ')}
      <div>${[record.type, record.date, record.place].filter(Boolean).map(format).join(' · ')}</div>
      ${record.own && record.children.length ? `<div>Дети · ${record.children.map(i => profileReference(people[i])).join(', ')}</div>` : ''}
    </li>`).join('');
    const images = (person.photos || []).map((id, index) =>
      `<img data-photo="${id}" alt="${format(person.name)} · фото ${index+1}">`).join('');
    return `<article class="person" id="person-${person.index}" tabindex="-1">
      <a class="back" href="#tree">← К дереву</a><a class="print-back" href="#print-index">← К указателю</a>
      <h1>${format(person.name)}</h1>
      ${person.groups.length ? `<p class="groups">${person.groups.map(format).join(' · ')}</p>` : ''}
      ${pairs ? `<dl>${pairs}</dl>` : ''}
      ${refs ? `<section><h2>Родственники</h2><ul class="references">${refs}</ul></section>` : ''}
      ${unions ? `<section><h2>Семейные союзы</h2><ul class="unions">${unions}</ul></section>` : ''}
      ${person.bio ? `<section><h2>Биография</h2><div class="biography">${format(person.bio)}</div></section>` : ''}
      ${images ? `<section class="photos-section"><h2>Фотографии</h2><div class="photos">${images}</div></section>` : ''}
      ${pairs || refs || unions || person.bio || images ? '' : '<p>Сведения отсутствуют.</p>'}
    </article>`;
  }

  function mapSvg(width, height, lines) {
    return `<svg class="connections" width="${width}" height="${height}" aria-hidden="true">${lines}</svg>`;
  }

  function printMap(people, width, height, lines) {
    const tileWidth = 920, tileHeight = 490;
    const tiles = new Map();
    for (const person of people) {
      const col = Math.floor(person.x / tileWidth), row = Math.floor(person.y / tileHeight);
      const key = row + ':' + col;
      if (!tiles.has(key)) tiles.set(key, { row, col, people: [] });
      tiles.get(key).people.push(person);
    }
    return [...tiles.values()].sort((a,b) => a.row-b.row || a.col-b.col).map(({row,col,people}) =>
      `<section class="print-tile"><h2>Дерево · ряд ${row+1}, сектор ${col+1}</h2>
      <div class="tile-crop"><div class="tile-scale"><div class="map-layer" style="left:${-col*tileWidth}px;top:${-row*tileHeight}px">
      ${mapSvg(width,height,lines)}${people.map(person => card(person,true)).join('')}</div></div></div></section>`
    ).join('');
  }

  const css = `
    :root{color-scheme:light;--ink:#252e29;--muted:#53645d;--line:#ccd6ce;--paper:#f7f7f0;--white:#fffdf8;--accent:#245e54;--plum:#794d68;font:16px/1.45 system-ui,sans-serif;color:var(--ink);background:var(--paper)}
    *{box-sizing:border-box}
    body{margin:0}
    a{color:var(--accent)}
    a:focus-visible,button:focus-visible,input:focus-visible{outline:3px solid #bd7b38;outline-offset:2px}
    h1,h2{font-family:Georgia,serif;font-weight:600;line-height:1.15}
    header{display:flex;gap:12px 24px;align-items:center;justify-content:space-between;flex-wrap:wrap;padding:12px 24px;border-bottom:1px solid var(--line);background:var(--white)}
    header a{font:600 clamp(1.25rem,3vw,1.7rem) Georgia,serif;color:var(--ink);text-decoration:none}
    .lookup{position:relative;flex:0 1 330px}
    input,button{font:inherit;border:1px solid #9cab9f;border-radius:6px;padding:6px 10px;background:var(--white);color:var(--ink)}
    input{width:100%}
    button{cursor:pointer}
    button:hover{background:#e9efe8}
    #results{position:absolute;z-index:10;left:0;right:0;max-height:55vh;overflow:auto;top:100%;margin:4px 0 0;padding:6px;list-style:none;border:1px solid var(--line);border-radius:6px;background:var(--white);box-shadow:0 7px 24px #203c2924}
    #results a,#results li.empty{display:block;padding:6px 8px}
    #results a:hover{background:#e9efe8}
    .visually-hidden{clip-path:inset(50%);position:absolute;width:1px;height:1px;overflow:hidden;white-space:nowrap}
    #tree{padding:12px 24px 16px}
    .tools{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:9px}
    #zoom-label{min-width:3.8em;text-align:center;color:var(--muted);font-variant-numeric:tabular-nums}
    #viewport{height:calc(100dvh - 138px);min-height:280px;overflow:auto;cursor:grab;border:1px solid var(--line);border-radius:9px;background-color:#ebf0e8;background-image:radial-gradient(#ccd8cd 1px,transparent 1px);background-size:16px 16px}
    #viewport.panning{cursor:grabbing;user-select:none}
    #sheet{position:relative;overflow:hidden}
    .map-layer{position:absolute;transform-origin:top left}
    .connections{position:absolute;top:0;left:0;pointer-events:none}
    .connections path{fill:none;stroke:#708578;stroke-width:2}
    .connections .partner{stroke:#94647c;stroke-dasharray:5 3;stroke-width:2.5}
    .map-card{display:flex;align-items:stretch;justify-content:flex-end;position:absolute;width:${cardWidth}px;height:${cardHeight}px;flex-direction:column;overflow:hidden;border:1px solid #acbfb2;border-top:4px solid var(--accent);border-radius:8px;background:var(--white);color:var(--ink);text-decoration:none}
    .map-card.female{border-top-color:var(--plum)}
    .map-card:hover{border-color:#245e54;box-shadow:0 0 0 2px #245e5455}
    .map-card img{width:100%;flex:1 1 0;min-height:44px;object-fit:cover;background:#e6ede6}
    .map-label{display:block;padding:8px 10px;overflow-wrap:anywhere}
    .map-label strong{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;line-height:1.2}
    .map-label small{display:block;color:var(--muted);line-height:1.18;margin-top:4px}
    .person{margin:24px auto 48px;max-width:880px;padding:0 22px;overflow-wrap:anywhere}
    .person h1{font-size:clamp(1.75rem,5vw,2.7rem);margin:14px 0 8px}
    .person h2{font-size:1.3rem;margin:20px 0 8px}
    .person section{border-top:1px solid var(--line);margin-top:16px}
    .groups{color:var(--muted)}
    dl{display:grid;grid-template-columns:minmax(110px,34%) 1fr;margin:14px 0;gap:4px 12px}
    dt{color:var(--muted)}
    dd{margin:0}
    .references,.unions{padding-left:22px;margin:6px 0}
    .references{columns:2 220px}
    .references li,.unions li{break-inside:avoid;padding-bottom:4px}
    .biography{white-space:pre-wrap}
    .photos{display:flex;flex-wrap:wrap;gap:12px}
    .photos img{width:min(100%,250px);height:200px;object-fit:contain;background:#e9efe8;border:1px solid var(--line);border-radius:7px}
    .print-only,.print-back,.person[hidden],[hidden]{display:none}
    .print-controls{display:none}
    body.for-print .print-controls{display:flex;gap:12px;align-items:center;padding:14px 24px}
    body.for-print #tree,body.for-print header,body.for-print .people{display:none}
    @media(max-width:580px){header,#tree{padding-left:12px;padding-right:12px}.lookup{flex-grow:1}#viewport{height:calc(100dvh - 165px)}}
    @page{size:A4 landscape;margin:10mm}
    @media print{
      :root{background:white;font-size:10pt}
      body{print-color-adjust:exact;-webkit-print-color-adjust:exact}
      header,#tree,.print-controls,body.for-print .print-controls,.person .back{display:none!important}
      .print-only,body.for-print .people,.person[hidden],.print-back{display:block!important}
      h1,h2{break-after:avoid}
      .index h1{font-size:23pt;margin:0 0 8pt}
      .index ul{columns:3;column-gap:18pt;margin:8pt 0;padding-left:16pt}
      .index li{break-inside:avoid;margin-bottom:2pt}
      .print-tile{break-before:page}
      .print-tile h2{font-size:15pt;margin:0 0 8pt}
      .tile-crop{width:960px;height:548px;position:relative;overflow:hidden;border:1px solid var(--line);background:#f0f4ed}
      .tile-scale{position:absolute;transform:scale(.85);transform-origin:top left}
      .print-tile .map-card{justify-content:center}
      .print-tile .map-label{font-size:16px}
      .people{display:block}
      .person{break-before:page;margin:0;padding:0;max-width:none}
      .person h1{font-size:23pt;margin:7pt 0 4pt}
      .person h2{font-size:14pt;margin:10pt 0 5pt}
      .person section{margin-top:8pt}
      .person dt,.person dd{break-inside:avoid}
      .photos img{width:150px;height:115px;break-inside:avoid}
    }
  `;

  function runViewer(width, height) {
    const get = id => document.getElementById(id);
    const viewport = get('viewport'), sheet = get('sheet'), map = get('world');
    const search = get('search'), results = get('results');
    const records = JSON.parse(get('search-data').textContent);
    const photos = JSON.parse(get('photo-data').textContent);
    for (const image of document.querySelectorAll('img[data-photo]')) image.src = photos[Number(image.dataset.photo)];
    let current, zoom = 1, drag, suppressClick = false;
    function resize(value) {
      zoom = value;
      sheet.style.width = Math.ceil(width * zoom) + 'px';
      sheet.style.height = Math.ceil(height * zoom) + 'px';
      map.style.transform = 'scale(' + zoom + ')';
      get('zoom-label').textContent = Math.round(zoom * 100) + '%';
    }
    function fit() {
      resize(Math.min(1, (viewport.clientWidth - 2) / width, (viewport.clientHeight - 2) / height));
      viewport.scrollTo(0,0);
    }
    function zoomBy(factor) {
      const old = zoom, x = viewport.clientWidth / 2, y = viewport.clientHeight / 2;
      const left = viewport.scrollLeft, top = viewport.scrollTop;
      resize(Math.max(Math.min(.1,old), Math.min(2.5,old * factor)));
      viewport.scrollTo((left + x) * zoom / old - x, (top + y) * zoom / old - y);
    }
    function route() {
      if (current) current.hidden = true;
      const id = /^#person-\d+$/.test(location.hash) ? location.hash.slice(1) : '';
      current = id ? get(id) : null;
      get('tree').hidden = Boolean(current);
      results.hidden = true;
      if (current) {
        current.hidden = false;
        current.focus({preventScroll:true});
        window.scrollTo(0,0);
      }
    }
    for (const article of document.querySelectorAll('.person')) article.hidden = true;
    get('fit').addEventListener('click',fit);
    get('zoom-in').addEventListener('click',() => zoomBy(1.3));
    get('zoom-out').addEventListener('click',() => zoomBy(1/1.3));
    const normalize = value => value.toLocaleLowerCase('ru').replaceAll('ё','е');
    const showResults = () => {
      const terms = normalize(search.value.trim()).split(/\s+/).filter(Boolean);
      const matches = terms.length ? records.filter(({words}) => terms.every(term => normalize(words).includes(term))) : [];
      results.replaceChildren();
      for (const person of matches.slice(0,30)) {
        const item = document.createElement('li'), link = document.createElement('a');
        link.href = '#person-' + person.index;
        link.textContent = [person.name,person.short].filter(Boolean).join(' · ');
        item.append(link);
        results.append(item);
      }
      if (terms.length && !matches.length) {
        const item = document.createElement('li');
        item.className = 'empty';
        item.textContent = 'Никого не найдено';
        results.append(item);
      }
      results.hidden = !terms.length;
    };
    search.addEventListener('input',showResults);
    search.addEventListener('focus',showResults);
    search.addEventListener('keydown',event => {
      if (event.key === 'Escape') results.hidden = true;
      if (event.key === 'ArrowDown') results.querySelector('a')?.focus();
      if (event.key === 'Enter' && !results.hidden) results.querySelector('a')?.click();
    });
    document.addEventListener('click',event => {
      if (!event.target.closest('.lookup')) results.hidden = true;
    });
    viewport.addEventListener('pointerdown',event => {
      if (event.button !== 0 || event.pointerType !== 'mouse') return;
      suppressClick = false;
      drag = { id:event.pointerId,x:event.clientX,y:event.clientY,left:viewport.scrollLeft,top:viewport.scrollTop };
    });
    viewport.addEventListener('pointermove',event => {
      if (!drag || drag.id !== event.pointerId || !event.buttons) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (!suppressClick && Math.hypot(dx,dy) < 4) return;
      if (!suppressClick) viewport.setPointerCapture(event.pointerId);
      suppressClick = true;
      viewport.classList.add('panning');
      viewport.scrollTo(drag.left - dx,drag.top - dy);
    });
    for (const type of ['pointerup','pointercancel','lostpointercapture']) viewport.addEventListener(type,() => {
      drag = null;
      viewport.classList.remove('panning');
      setTimeout(() => { suppressClick = false; },0);
    });
    viewport.addEventListener('click',event => {
      if (suppressClick) { event.preventDefault(); event.stopPropagation(); }
    },true);
    const print = get('print-now');
    if (print) print.addEventListener('click',async () => {
      print.disabled = true;
      await Promise.allSettled([...document.images].map(image => image.decode()));
      window.print();
      print.disabled = false;
    });
    if (!document.body.classList.contains('for-print')) {
      fit();
      window.addEventListener('hashchange',route);
      route();
    }
  }

  function build(model, { title = 'Семейное дерево', print = false } = {}) {
    const { people, edges, photos } = model;
    const width = Math.max(260, ...people.map(p => p.x + cardWidth + 25));
    const height = Math.max(210, ...people.map(p => p.y + cardHeight + 25));
    const paths = edges.map(edge => `<path class="${edge.kind}" d="${edgePath(edge,people)}"/>`).join('');
    const index = [...people].sort((a,b) => a.name.localeCompare(b.name,'ru'));
    const lookup = index.map(person => ({ index:person.index,name:person.name,short:person.short,
      words:[person.name,person.short,...person.details.filter(([key]) => key.includes('рождения') || key.includes('фамилия')).map(([,v]) => v)].join(' ') }));
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
    <title>${format(title)}${print ? ' · PDF' : ''}</title><style>${css}</style></head>
    <body class="${print ? 'for-print' : ''}">
    <header><a href="#tree">${format(title)}</a><div class="lookup">
      <label class="visually-hidden" for="search">Поиск человека</label>
      <input id="search" type="search" placeholder="ФИО или год рождения" autocomplete="off">
      <ul id="results" hidden></ul></div></header>
    <section id="tree" aria-label="Схема дерева"><div class="tools">
      <button id="zoom-out" aria-label="Уменьшить">−</button><output id="zoom-label"></output><button id="zoom-in" aria-label="Увеличить">+</button>
      <button id="fit">Вписать дерево</button></div>
      <div id="viewport" tabindex="0" aria-label="Карта семейного дерева"><div id="sheet"><div id="world" class="map-layer">
      ${print ? '' : mapSvg(width,height,paths)+people.map(person => card(person)).join('')}
      </div></div></div></section>
    ${print ? '<div class="print-controls"><button id="print-now">Сохранить в PDF</button><span>В окне печати выберите «Сохранить как PDF».</span></div>' : ''}
    <div class="print-only"><section id="print-index" class="index"><h1>${format(title)}</h1>
      <h2>Алфавитный указатель</h2><ul>${index.map(person => `<li>${profileReference(person)}${person.short ? ' · '+format(person.short) : ''}</li>`).join('')}</ul></section>
      ${printMap(people,width,height,paths)}</div>
    <main class="people">${index.map(person => profile(person,people)).join('')}</main>
    <script id="search-data" type="application/json">${inertJson(lookup)}</script>
    <script id="photo-data" type="application/json">${inertJson(photos)}</script>
    <script>(${runViewer})(${width},${height});</script></body></html>`;
  }

  const api = { build, collect, embedPhotos, localPhoto };
  if (typeof module !== 'undefined') module.exports = api;
  else window.TreePublication = api;
})();
