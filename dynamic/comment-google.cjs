'use strict';

const { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } = require('node:crypto');
const callback = '/api/comments/auth/google/callback';
const articleId = /^[a-z0-9][a-z0-9-]{0,95}$/;
const cookieName = 'stav_comment_oauth';
const lifetime = 600;

function createGoogleCommentAuth({ key, secure, clientId, clientSecret, comments }) {
  const enabled = !!(key && comments.enabled && clientSecret && /^[\w-]+\.apps\.googleusercontent\.com$/.test(clientId || ''));
  const secret = enabled && hkdfSync('sha256', key, '', 'stavrodromio-comment-google-v1', 32);
  const mac = value => createHmac('sha256', secret).update(value).digest('hex');
  const cookie = (value, age) => cookieName + '=' + value + '; HttpOnly; SameSite=Lax; Path=' + callback +
    '; Max-Age=' + age + (secure ? '; Secure' : '');

  function start(origin, id) {
    if (!articleId.test(id || '')) return null;
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const expires = Math.floor(Date.now() / 1000) + lifetime;
    const data = [id, state, verifier, expires].join('.');
    const params = new URLSearchParams({
      client_id: clientId, redirect_uri: origin + callback, response_type: 'code',
      scope: 'openid email profile', state, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    });
    return { url: 'https://accounts.google.com/o/oauth2/v2/auth?' + params, cookie: cookie(data + '.' + mac(data), lifetime) };
  }

  function read(req, state) {
    const value = req.headers.cookie?.match(/(?:^|;\s*)stav_comment_oauth=([^;]+)/)?.[1] || '';
    const match = /^([a-z0-9][a-z0-9-]{0,95})\.([\w-]{32})\.([\w-]{43})\.(\d{10,12})\.([a-f0-9]{64})$/.exec(value);
    if (!match) return null;
    const [, article, expected, verifier, expires, signature] = match;
    if (expected !== state || Number(expires) < Date.now() / 1000 ||
        !timingSafeEqual(Buffer.from(signature), Buffer.from(mac(value.slice(0, -65))))) return null;
    return { article, verifier };
  }

  async function finish(origin, code, verifier) {
    if (!code || code.length > 2048) throw new Error('Missing authorization code');
    const token = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, code_verifier: verifier,
        client_id: clientId, client_secret: clientSecret, redirect_uri: origin + callback,
      }),
    });
    if (!token.ok) throw new Error('Google token exchange failed');
    const { access_token: accessToken } = await token.json();
    if (typeof accessToken !== 'string' || !accessToken) throw new Error('Missing access token');
    const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      redirect: 'error', signal: AbortSignal.timeout(8000), headers: { Authorization: 'Bearer ' + accessToken },
    });
    if (!response.ok) throw new Error('Google user info unavailable');
    const profile = await response.json();
    if (profile.email_verified !== true || typeof profile.email !== 'string' || !profile.email || profile.email.length > 254 ||
        typeof profile.sub !== 'string' || !profile.sub || profile.sub.length > 255) throw new Error('Google profile not verified');
    const id = mac('reader:' + profile.sub);
    const existing = await comments.member(id);
    if (existing) return existing;
    const name = typeof profile.name === 'string' ? profile.name.replace(/\s+/g, ' ').trim() : '';
    if (!name || name.length > 91) throw new Error('Google profile missing a usable name');
    return comments.register(id, name, profile.email);
  }

  return { enabled, start, read, finish, clear: () => cookie('', 0) };
}

module.exports = { createGoogleCommentAuth };
