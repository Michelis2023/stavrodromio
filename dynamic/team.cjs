'use strict';
const { createCipheriv, createDecipheriv, createHash, randomBytes, sign, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');

const derive = promisify(scrypt);
const cost = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const ttl = 7 * 24 * 60 * 60 * 1000;
const digest = value => createHash('sha256').update(value).digest('hex');
const error = (status, message) => Object.assign(new Error(message), { status });
const badLogin = () => error(401, 'Το email ή ο κωδικός δεν είναι σωστά.');
const badInvite = () => error(400, 'Η πρόσκληση δεν είναι ενεργή. Ζήτησε νέα από τον ιδιοκτήτη.');
const tokenShape = /^[A-Za-z0-9_-]{43}$/;
const maxTeam = 30;
let busyHashes = 0;

function emailAddress(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw error(400, 'Συμπλήρωσε έγκυρη διεύθυνση email.');
  return email;
}
function authorName(value) {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!name || name.length > 120) throw error(400, 'Συμπλήρωσε το όνομα που θα εμφανίζεται στα άρθρα.');
  return name;
}
async function passwordHash(password, salt) {
  if (busyHashes >= 4) throw error(429, 'Περίμενε λίγο και δοκίμασε ξανά.');
  busyHashes++;
  try { return await derive(password, salt, 64, cost); }
  finally { busyHashes--; }
}

function createTeam({ repoApi, repository, local }) {
  const rawKey = process.env.STAVRODROMIO_TEAM_KEY;
  const appId = process.env.STAVRODROMIO_APP_ID;
  const privateKey = process.env.STAVRODROMIO_APP_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const key = /^[a-f0-9]{64}$/i.test(rawKey || '') ? Buffer.from(rawKey, 'hex') : null;
  const enabled = !!(key && (local || (appId && privateKey)));
  const additionalData = Buffer.from('stavrodromio-editorial-team-v1');
  let appToken;
  let appTokenPromise;

  function open(state) {
    if (!enabled) throw error(503, 'Η πρόσβαση συνεργατών δεν έχει ενεργοποιηθεί.');
    if (!state.editorialTeam) return { accounts: [], invites: [] };
    try {
      const [nonce, tag, bytes] = state.editorialTeam.split('.').map(part => Buffer.from(part, 'base64url'));
      if (nonce.length !== 12 || tag.length !== 16) throw new Error('Invalid record');
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(additionalData);
      decipher.setAuthTag(tag);
      const data = JSON.parse(Buffer.concat([decipher.update(bytes), decipher.final()]));
      if (!Array.isArray(data.accounts) || !Array.isArray(data.invites)) throw new Error('Invalid team');
      return data;
    } catch {
      throw error(503, 'Η πρόσβαση συνεργατών δεν είναι προσωρινά διαθέσιμη.');
    }
  }

  function protect(state, data) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(additionalData);
    const bytes = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
    return { ...state, editorialTeam: [nonce, cipher.getAuthTag(), bytes].map(part => part.toString('base64url')).join('.') };
  }
  function ownerView(state) {
    const team = open(state);
    return {
      accounts: team.accounts.map(({ id, email, name }) => ({ id, email, name })),
      invites: team.invites.filter(invite => invite.expires > Date.now()).map(({ id, email, name, expires }) => ({ id, email, name, expires })),
    };
  }

  function newInvite(state, input, secret) {
    const team = open(state);
    const email = emailAddress(input.email);
    const name = authorName(input.name);
    if (team.accounts.some(account => account.email === email)) throw error(409, 'Το email ανήκει ήδη σε συνεργάτη.');
    team.invites = team.invites.filter(invite => invite.expires > Date.now() && invite.email !== email);
    if (team.accounts.length + team.invites.length >= maxTeam) throw error(409, 'Ο κατάλογος συνεργατών είναι πλήρης.');
    team.invites.push({ id: randomBytes(16).toString('hex'), email, name, digest: digest(secret), expires: Date.now() + ttl });
    return protect(state, team);
  }

  function remove(state, id) {
    const team = open(state);
    const account = team.accounts.find(item => item.id === id);
    const invite = team.invites.find(item => item.id === id);
    if (!account && !invite) throw error(404, 'Η πρόσβαση δεν βρέθηκε.');
    team.accounts = team.accounts.filter(item => item.id !== id);
    team.invites = team.invites.filter(item => item.id !== id);
    return protect(state, team);
  }

  function requireMember(state, id) {
    const account = open(state).accounts.find(item => item.id === id);
    if (!account) throw error(401, 'Η πρόσβαση συνεργάτη έχει ανακληθεί.');
    return { id: account.id, role: 'coadmin', name: account.name };
  }

  function checkInvite(state, input) {
    if (typeof input.code !== 'string' || !tokenShape.test(input.code)) throw badInvite();
    const email = emailAddress(input.email);
    const expected = digest(input.code);
    const invite = open(state).invites.find(item => item.digest === expected && item.email === email && item.expires > Date.now());
    if (!invite) throw badInvite();
    return invite;
  }
  async function newPassword(password) {
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
      throw error(400, 'Ο κωδικός χρειάζεται από 12 έως 128 χαρακτήρες.');
    }
    const salt = randomBytes(16);
    return { salt: salt.toString('hex'), password: (await passwordHash(password, salt)).toString('hex') };
  }
  function redeem(state, input, verifier, accountId) {
    const invite = checkInvite(state, input);
    const team = open(state);
    if (team.accounts.some(account => account.email === invite.email)) throw badInvite();
    team.accounts.push({ id: accountId, email: invite.email, name: invite.name, ...verifier });
    team.invites = team.invites.filter(item => item.id !== invite.id);
    return protect(state, team);
  }
  async function signIn(state, input) {
    if (typeof input.password !== 'string' || input.password.length > 128) throw badLogin();
    const email = emailAddress(input.email);
    const account = open(state).accounts.find(item => item.email === email);
    const salt = Buffer.from(account?.salt || '00000000000000000000000000000000', 'hex');
    const expected = Buffer.from(account?.password || '00'.repeat(64), 'hex');
    const result = await passwordHash(input.password, salt);
    if (expected.length !== result.length || !timingSafeEqual(result, expected) || !account) throw badLogin();
    return { id: account.id, role: 'coadmin', name: account.name };
  }

  async function appRequest(endpoint, bearer, body) {
    const response = await fetch('https://api.github.com' + endpoint, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: {
        Authorization: 'Bearer ' + bearer, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json', 'User-Agent': 'Stavrodromio-CMS',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error('GitHub App unavailable');
    return response.json();
  }

  async function fetchAppToken() {
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(JSON.stringify({ iat: timestamp - 60, exp: timestamp + 540, iss: appId })).toString('base64url');
    const unsigned = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.' + payload;
    const jwt = unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url');
    const { id } = await appRequest(repoApi + '/installation', jwt);
    const result = await appRequest('/app/installations/' + id + '/access_tokens', jwt, {
      repositories: [repository], permissions: { contents: 'write' },
    });
    if (!result.token || result.permissions?.contents !== 'write' || !Number.isFinite(Date.parse(result.expires_at))) {
      throw new Error('Insufficient app access');
    }
    return { token: result.token, until: Date.parse(result.expires_at) - 120000 };
  }
  async function serviceToken() {
    if (!enabled) throw error(503, 'Η πρόσβαση συνεργατών δεν έχει ενεργοποιηθεί.');
    if (local) return 'local-team-test';
    if (appToken?.until > Date.now()) return appToken.token;
    if (!appTokenPromise) {
      appTokenPromise = fetchAppToken()
        .then(result => { appToken = result; return result.token; })
        .catch(() => { throw error(503, 'Η εφαρμογή GitHub του Σταυροδρομίου χρειάζεται έλεγχο πρόσβασης.'); })
        .finally(() => { appTokenPromise = undefined; });
    }
    return appTokenPromise;
  }

  return { enabled, ownerView, newInvite, remove, requireMember, checkInvite, newPassword, redeem, signIn, serviceToken };
}
module.exports = { createTeam };
