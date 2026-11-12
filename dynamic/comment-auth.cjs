'use strict';

const { createHmac, hkdfSync, randomBytes, randomInt, timingSafeEqual } = require('node:crypto');
const emailPattern = /^[^\s@<>]+@[^\s@<>.]+(?:\.[^\s@<>.]+)+$/u;
const ttl = 10 * 60 * 1000;
const sessionAge = 30 * 24 * 60 * 60;
const error = (status, message) => Object.assign(new Error(message), { status });

function createCommentAuth({ key, secure, comments, apiKey, sender }) {
  const secret = key && hkdfSync('sha256', key, '', 'stavrodromio-comment-auth-v1', 32);
  const enabled = !!(secret && comments.enabled && apiKey && emailPattern.test(sender || ''));
  const pending = new Map();
  const limits = new Map();
  const sign = (purpose, value) => createHmac('sha256', secret).update(purpose + ':' + value).digest('hex');
  const matches = (left, right) => timingSafeEqual(Buffer.from(left), Buffer.from(right));
  const clean = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

  function limit(address, email) {
    const now = Date.now();
    for (const [id, item] of limits) if (item.until <= now) limits.delete(id);
    for (const [id, item] of pending) if (item.until <= now) pending.delete(id);
    const keys = [['total', 40], ['ip:' + address, 6], ['email:' + email, 3]];
    const entries = keys.map(([key, max]) => [key, max, limits.get(key) || { count: 0, until: now + ttl }]);
    if (entries.some(([, max, item]) => item.count >= max)) throw error(429, 'Περίμενε λίγα λεπτά πριν ζητήσεις νέο κωδικό.');
    for (const [key, , item] of entries) {
      item.count++;
      limits.set(key, item);
    }
  }

  async function request(input, address) {
    const email = clean(input.email).toLowerCase();
    const first = clean(input.first);
    const last = clean(input.last);
    if (!emailPattern.test(email) || email.length > 254 || !!first !== !!last || first.length > 45 || last.length > 45) {
      throw error(400, 'Έλεγξε το email και, αν δηλώσεις όνομα, συμπλήρωσε και το επώνυμο.');
    }
    const member = sign('member', email);
    limit(address, member);
    const id = randomBytes(24).toString('hex');
    const code = String(randomInt(0, 1000000)).padStart(6, '0');
    let response;
    try {
      response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          sender: { email: sender, name: 'Σταυροδρόμι Κοινότητα' }, to: [{ email }],
          subject: 'Κωδικός σύνδεσης στο Σταυροδρόμι',
          textContent: 'Ο κωδικός σύνδεσης για τα σχόλια είναι ' + code + '. Ισχύει για 10 λεπτά.',
        }),
      });
    } catch { /* Show the same error for transport and provider failures. */ }
    if (!response?.ok) throw error(503, 'Ο κωδικός δεν στάλθηκε. Δοκίμασε ξανά σε λίγο.');
    pending.set(id, { member, email, name: first && first + ' ' + last, code: sign(id, code), attempts: 0, until: Date.now() + ttl });
    return id;
  }

  async function verify(input) {
    const challenge = typeof input.challenge === 'string' && pending.get(input.challenge);
    if (!challenge || challenge.until <= Date.now() || challenge.attempts >= 5) {
      throw error(401, 'Ο κωδικός έληξε. Ζήτησε νέο κωδικό.');
    }
    challenge.attempts++;
    if (typeof input.code !== 'string' || !/^\d{6}$/.test(input.code) || !matches(challenge.code, sign(input.challenge, input.code))) {
      throw error(401, 'Ο κωδικός δεν είναι σωστός.');
    }
    pending.delete(input.challenge);
    const existing = await comments.member(challenge.member);
    if (existing) return existing;
    if (!challenge.name) throw error(400, 'Για την πρώτη εγγραφή, ζήτησε νέο κωδικό μαζί με το όνομα και το επώνυμό σου.');
    return comments.register(challenge.member, challenge.name, challenge.email);
  }

  function cookie(member) {
    const value = member ? member.id + '.' + (Math.floor(Date.now() / 1000) + sessionAge) : '';
    return 'stav_comment=' + (value ? value + '.' + sign('session', value) : '') +
      '; HttpOnly; SameSite=Strict; Path=/api/comments; Max-Age=' + (value ? sessionAge : 0) + (secure ? '; Secure' : '');
  }

  async function reader(req) {
    const value = req.headers.cookie?.match(/(?:^|;\s*)stav_comment=([^;]*)/)?.[1] || '';
    const match = /^([a-f0-9]{64})\.(\d{10,12})\.([a-f0-9]{64})$/.exec(value);
    if (!match || Number(match[2]) <= Date.now() / 1000 ||
        !matches(match[3], sign('session', match[1] + '.' + match[2]))) return null;
    return comments.member(match[1]);
  }

  return { enabled, request, verify, reader, cookie };
}

module.exports = { createCommentAuth };
