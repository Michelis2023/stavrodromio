'use strict';

const fs = require('node:fs');
const { createCipheriv, createDecipheriv, hkdfSync, randomBytes } = require('node:crypto');

const branch = 'stavrodromio-comments';
const filename = '/contents/comments.enc';
const context = Buffer.from('stavrodromio-comments-v1');
const idPattern = /^[0-9a-f]{32}$/;
const interval = 10 * 60 * 1000;
const error = (status, message) => Object.assign(new Error(message), { status });

function createComments({ local, key, enabled, repoApi, gh, serviceToken }) {
  const secret = key && Buffer.from(hkdfSync('sha256', key, '', context, 32));
  const limitByAddress = new Map();
  let cached;
  let reading;
  let localWrite = Promise.resolve();

  function seal(items) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', secret, nonce);
    cipher.setAAD(context);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(items), 'utf8'), cipher.final()]);
    return [nonce, cipher.getAuthTag(), ciphertext].map(part => part.toString('base64url')).join('.');
  }

  function open(data) {
    const [nonce, tag, ciphertext] = data.split('.').map(part => Buffer.from(part, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', secret, nonce, { authTagLength: 16 });
    decipher.setAAD(context);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  }

  async function load(token) {
    if (local) {
      try { return { items: open(fs.readFileSync(local + '.comments', 'utf8')) }; }
      catch (cause) { if (cause.code === 'ENOENT') return { items: [] }; throw cause; }
    }
    try {
      const file = await gh(repoApi + filename + '?ref=' + branch, token, 'GET', undefined, 8000);
      return { sha: file.sha, items: open(Buffer.from(file.content, 'base64').toString('utf8')) };
    } catch (cause) {
      if (cause.status !== 404) throw cause;
      await gh(repoApi + '/git/ref/heads/' + branch, token);
      return { items: [] };
    }
  }

  function remember(items) {
    cached = { items, until: Date.now() + 15000 };
    return items;
  }

  async function list() {
    if (cached?.until > Date.now()) return cached.items;
    if (!reading) {
      const previous = cached;
      reading = serviceToken().then(load).then(({ items }) => cached === previous ? remember(items) : cached?.items ?? items)
        .finally(() => { reading = undefined; });
    }
    return reading;
  }

  async function write(change) {
    const token = await serviceToken();
    for (let attempt = 0; attempt < 4; attempt++) {
      const { sha, items } = await load(token);
      const next = change(items);
      if (next === items) return remember(items);
      const data = seal(next);
      if (data.length > 750000) throw error(503, 'Ο χώρος για σχόλια έχει γεμίσει προσωρινά.');
      if (local) {
        fs.writeFileSync(local + '.comments.tmp', data, { mode: 0o600 });
        fs.renameSync(local + '.comments.tmp', local + '.comments');
        return remember(next);
      }
      try {
        await gh(repoApi + filename, token, 'PUT', {
          branch, sha, message: 'Update comment storage', content: Buffer.from(data).toString('base64'),
        });
        // A different request may have committed again while this response was in transit.
        cached = undefined;
        return next;
      } catch (cause) {
        if (![409, 422].includes(cause.status) || attempt === 3) throw cause;
      }
    }
  }

  function mutate(change) {
    if (!local) return write(change);
    const result = localWrite.then(() => write(change));
    localWrite = result.catch(() => {});
    return result;
  }

  function limit(address) {
    const now = Date.now();
    for (const [key, value] of limitByAddress) {
      if (value.until <= now) limitByAddress.delete(key);
    }
    const global = limitByAddress.get(null) || { count: 0, until: now + interval };
    const visitor = limitByAddress.get(address) || { count: 0, until: now + interval };
    if (global.count >= 60 || visitor.count >= 5) throw error(429, 'Περίμενε λίγα λεπτά πριν στείλεις άλλο σχόλιο.');
    global.count++;
    visitor.count++;
    limitByAddress.set(null, global);
    limitByAddress.set(address, visitor);
  }

  async function submit(article, input, address) {
    const name = typeof input.name === 'string' ? input.name.replace(/\s+/g, ' ').trim() : '';
    const body = typeof input.body === 'string' ? input.body.replace(/\r\n?/g, '\n').trim() : '';
    if (input.website || typeof input.id !== 'string' || !idPattern.test(input.id) || name.length > 60 || !name ||
        body.length > 2000 || !body) throw error(400, 'Συμπλήρωσε όνομα και σχόλιο έως 2.000 χαρακτήρες.');
    limit(address);
    const entry = { id: input.id, article, name, body, created: new Date().toISOString() };
    let created;
    const items = await mutate(items => {
      created = !items.some(item => item.id === entry.id);
      return created ? [...items, entry] : items;
    });
    return { created, items: forArticle(items, article) };
  }

  function remove(id) {
    if (typeof id !== 'string' || !idPattern.test(id)) throw error(400, 'Μη έγκυρη ενέργεια σχολίου.');
    return mutate(items => items.some(item => item.id === id) ? items.filter(item => item.id !== id) : items);
  }

  function forArticle(items, article) {
    return items.filter(item => item.article === article)
      .map(({ name, body, created }) => ({ name, body, created }));
  }

  return { enabled: !!(enabled && secret), list, submit, remove,
    published: async article => forArticle(await list(), article),
  };
}

module.exports = { createComments };
