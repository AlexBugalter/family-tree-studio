const { connection, edit, must, profile, search } = require('./tree.cjs');

const text = { type: 'string', minLength: 1, maxLength: 400 };
const id = { ...text, maxLength: 150 };
const nullableId = { type: ['string', 'null'], minLength: 1, maxLength: 150 };
const number = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const change = object({
  operation: { type: 'string', enum: ['add_person','update_person','set_parents','save_marriage'] },
  personId: id,
  values: { type: 'object', additionalProperties: true },
  fatherId: nullableId,
  motherId: nullableId,
  partnerId: id,
  childIds: { type: 'array', maxItems: 100, items: id },
  marriageId: id
}, ['operation']);

function validate(schema, value, label) {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array'
    : Number.isInteger(value) ? 'integer' : typeof value;
  must([schema.type].flat().includes(type), 'Неверный тип: ' + label);
  if (schema.enum) must(schema.enum.includes(value), 'Недопустимое значение: ' + label);
  if (type === 'string') must(value.length >= (schema.minLength ?? 0) && value.length <= (schema.maxLength ?? Infinity), 'Недопустимая длина: ' + label);
  if (type === 'integer') must(value >= schema.minimum && value <= schema.maximum, 'Значение вне диапазона: ' + label);
  if (type === 'object') {
    for (const key of schema.required || []) must(Object.hasOwn(value, key), 'Укажите ' + key);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties && Object.hasOwn(schema.properties, key)) validate(schema.properties[key], item, key);
      else must(schema.additionalProperties, 'Неизвестное поле: ' + key);
    }
  }
  if (type === 'array') {
    must(value.length <= schema.maxItems, 'Слишком длинный список: ' + label);
    for (const item of value) validate(schema.items, item, label);
  }
}

function createTools(store) {
  const tools = new Map();
  function add(name, description, inputSchema, run, write = false) {
    tools.set(name, { name, description, inputSchema, run, annotations: {
      readOnlyHint: !write, openWorldHint: false, destructiveHint: write, idempotentHint: !write
    } });
  }
  add('family_tree_status', 'Состояние семейного дерева, число карточек, групп и браков, ревизия и разрешение записи.', object({}),
    () => {
      const { tree, revision } = store.read();
      return { people: tree.mems.length, groups: tree.groups?.length || 0,
        marriages: tree.marriages?.length || 0, revision, writable: store.writable };
    });
  add('family_tree_search', 'Найти карточки по ФИО, вариантам фамилии, году, месту рождения или ID. Запрос можно разбить на слова и указать в произвольном порядке.', object({
    query: text, limit: number(1, 30), offset: number(0, 100000)
  }, ['query']), ({ query, limit = 10, offset = 0 }) => search(store.read().tree, query, limit, offset));
  add('family_tree_person', 'Карточка по ID, биография, близкие родственники и записанные браки. Поиск ID выполняет family_tree_search.',
    object({ id }, ['id']), args => profile(store.read().tree, args.id));
  add('family_tree_relationship', 'Кратчайшая записанная цепочка связей между двумя ID. Цепочка через брак сама по себе не доказывает кровное родство.',
    object({ fromId: id, toId: id }, ['fromId','toId']), ({ fromId, toId }) => connection(store.read().tree, fromId, toId));
  add('family_tree_preview', 'Проверить правку и получить before/after и revision без записи. add_person требует values.name; update_person требует personId и values; set_parents принимает personId и fatherId/motherId (null очищает); save_marriage принимает personId, partnerId, необязательные marriageId, childIds и values (relationType, marriageDate, marriagePlace, divorceDate, divorced). Указывайте дату развода отдельно от даты союза. Для карточки values содержит только поля профиля, например name, birthDate, birthPlace, bio.',
    object({ change }, ['change']), args => {
      const snapshot = store.read();
      const { createdId, marriageId, ...preview } = edit(snapshot.tree, args.change);
      return { ...preview, change: args.change, revision: snapshot.revision };
    });
  if (store.writable) {
    add('family_tree_apply', 'Записать явно согласованную с пользователем правку из family_tree_preview. Передайте ту же change и revision. Создаёт резервную копию.',
      object({ change, revision: { type: 'string', minLength: 64, maxLength: 64 } }, ['change','revision']),
      args => store.apply(args.revision, args.change), true);
  }
  return {
    definitions: [...tools.values()].map(({ run, ...definition }) => definition),
    call(name, args) {
      const tool = tools.get(name);
      must(tool, 'Неизвестный или отключённый инструмент: ' + name);
      validate(tool.inputSchema, args, 'arguments');
      return tool.run(args);
    }
  };
}

module.exports = { createTools };
