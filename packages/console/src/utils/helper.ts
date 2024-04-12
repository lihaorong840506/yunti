import { RELEASE_BRANCH_PREFIX, TREE_DEFAULT } from './constants';

export const uuid = (prefix: string, length = 8) => {
  const str = Math.random().toString(36);
  return prefix + '-' + str.slice(Math.max(0, str.length - length));
};
// 添加 use 属性；修复部分组件无法转化英文
export const transformSchemaI18n = (schema, locale) => {
  const transformObject = obj => {
    for (const key of Object.keys(obj)) {
      if (Object.prototype.toString.call(obj[key]) === '[object Object]') {
        obj[key] = transformObject(obj[key]);
      }
      if (Object.prototype.toString.call(obj[key]) === '[object Array]') {
        obj[key] = transformArray(obj[key]);
      }
      if (obj.type === 'i18n') {
        obj.use = locale;
      }
    }
    return obj;
  };
  const transformArray = arr => {
    return arr.map(item => {
      if (Object.prototype.toString.call(item) === '[object Array]') {
        return transformArray(item);
      }
      if (Object.prototype.toString.call(item) === '[object Object]') {
        return transformObject(item);
      }
      return item;
    });
  };
  transformArray(schema?.componentsTree || []);
  return schema;
};

export const TREES_KEY = 'yunti_trees';

export const getTrees = () => {
  try {
    const trees = JSON.parse(
      window.sessionStorage.getItem(TREES_KEY) || window.localStorage.getItem(TREES_KEY) || '{}'
    ) as Record<string, string>;
    return trees || {};
  } catch {
    return {};
  }
};

export const getTreeById = (id?: string) => {
  if (!id) {
    return null;
  }
  const tree = getTrees()[id] || `${id}/${TREE_DEFAULT}`;
  return tree;
};

export const setTree = (id: string, tree: string, sessionOnly = false) => {
  const trees = getTrees();
  trees[id] = tree;
  window.sessionStorage.setItem(TREES_KEY, JSON.stringify(trees));
  if (!sessionOnly) {
    window.localStorage.setItem(TREES_KEY, JSON.stringify(trees));
  }
  return tree;
};

export const getTreeNames = (id: string) => {
  const tree = getTreeById(id);
  const names = { name: tree, displayName: '' };
  if (!tree) {
    names.name = `${id}/${TREE_DEFAULT}`;
    names.displayName = TREE_DEFAULT;
    return names;
  }
  // support commit hash
  if (!tree.includes('/')) {
    names.displayName = tree.slice(0, 8);
    return names;
  }
  names.displayName = tree?.replace(`${id}/`, '') || '';
  if (names.displayName !== TREE_DEFAULT && !names.displayName.startsWith(RELEASE_BRANCH_PREFIX)) {
    const [, ...branchName] = names.displayName.split('/');
    names.displayName = branchName.join('/');
  }
  return names;
};
