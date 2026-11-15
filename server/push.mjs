// web-push wrapper: VAPID keys, sending to every subscription, and cleanup of dead ones.

import * as webpush from 'web-push';

// Placeholder only. scripts/deploy.sh sets VAPID_SUBJECT to the app's origin (https://<machine>.<tailnet>.ts.net:8443).
export const DEFAULT_VAPID_SUBJECT = 'https://example.com/checkin';

/** Load VAPID keys from the store, generating and saving a pair on first start. */
export function loadOrCreateVapid(store) {
  const existing = store.get('vapid', null);
  if (existing && typeof existing.publicKey === 'string' && typeof existing.privateKey === 'string') {
    return existing;
  }
  const keys = webpush.generateVAPIDKeys();
  const value = { publicKey: keys.publicKey, privateKey: keys.privateKey, createdAt: new Date().toISOString() };
  store.set('vapid', value);
  return value;
}

/** Validate a PushSubscription JSON object. Returns an error sentence or null. */
export function subscriptionError(sub) {
  if (!sub || typeof sub !== 'object' || Array.isArray(sub)) return 'Send a subscription object.';
  let url;
  try {
    url = new URL(sub.endpoint);
  } catch {
    return 'The subscription needs an https endpoint.';
  }
  if (url.protocol !== 'https:' || sub.endpoint.length > 2048) return 'The subscription needs an https endpoint.';
  const keys = sub.keys;
  if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string' ||
      !keys.p256dh || !keys.auth || keys.p256dh.length > 512 || keys.auth.length > 512) {
    return 'The subscription is missing its keys.';
  }
  return null;
}

/**
 * createPusher({ store, vapid, subject, send, log })
 * `send(subscription, payloadString, options)` defaults to web-push's sendNotification
 * and is injectable so tests never touch the network.
 */
export function createPusher({ store, vapid, subject = DEFAULT_VAPID_SUBJECT, send = webpush.sendNotification, log = console }) {
  const vapidDetails = { subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey };

  const list = () => store.get('subscriptions', []);

  function upsert(sub) {
    const now = new Date().toISOString();
    const subs = list().slice();
    const clean = {
      endpoint: sub.endpoint,
      expirationTime: sub.expirationTime ?? null,
      keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    };
    const i = subs.findIndex((s) => s.endpoint === sub.endpoint);
    if (i >= 0) subs[i] = { ...subs[i], ...clean, updatedAt: now };
    else subs.push({ ...clean, createdAt: now, updatedAt: now });
    store.set('subscriptions', subs);
  }

  function remove(endpoint) {
    const subs = list();
    const next = subs.filter((s) => s.endpoint !== endpoint);
    if (next.length !== subs.length) store.set('subscriptions', next);
    return subs.length - next.length;
  }

  /** Send one payload to every subscription. Resolves to { sent, failed, removed }. */
  async function sendToAll(payload, options = {}) {
    const subs = list();
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const results = await Promise.allSettled(
      subs.map((s) => send(
        { endpoint: s.endpoint, keys: s.keys },
        body,
        { ...options, vapidDetails, timeout: 15_000 },
      )),
    );
    let sent = 0;
    let failed = 0;
    const dead = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        sent++;
        return;
      }
      failed++;
      const code = r.reason && r.reason.statusCode;
      const host = safeHost(subs[i].endpoint);
      if (code === 404 || code === 410) {
        dead.push(subs[i].endpoint);
        log.warn?.(`[push] ${host} says the subscription is gone (${code}); removing it.`);
      } else {
        log.error?.(`[push] Sending to ${host} failed${code ? ` (${code})` : ''}: ${r.reason && r.reason.message}`);
      }
    });
    if (dead.length) {
      const deadSet = new Set(dead);
      store.set('subscriptions', list().filter((s) => !deadSet.has(s.endpoint)));
    }
    return { sent, failed, removed: dead.length };
  }

  return { list, upsert, remove, sendToAll, publicKey: vapid.publicKey };
}

function safeHost(endpoint) {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'unknown push service';
  }
}
