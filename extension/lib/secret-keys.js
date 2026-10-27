/**
 * One policy for "is this key's value a secret?", shared by the request-side redactors
 * (network-capture.js) and the response-body redactors (response-bodies.js). Pure.
 *
 * A key is cut into words (camelCase, `_`, `-`, `.`, `[`): `apiKey`, `api_key` and `X-API-Key`
 * all give api + key. Stems such as token, secret, pass or pwd match inside a word
 * (accessToken, client_secret, dbpass, userpwd). A few common English words that only
 * contain `pass` (passive, compass, bypass) are listed as ordinary data. Over-matching hides
 * a little data; under-matching leaks a secret.
 */

// Inside any word: accesstoken, clientsecret, passwd, dbpass, userpwd, credentials, authorization, cookies.
const STEM = /token|secret|pass|pwd|credential|authoriz|cookie|apikey|privatekey|sessionid/;
// Ordinary words that contain `pass`. Anything else with `pass` in it stays secret.
const PLAIN_WORDS = new Set([
  'passive', 'compass', 'bypass', 'surpass', 'overpass', 'underpass', 'passenger', 'passengers',
  'passage', 'passages', 'passed', 'passes', 'passing', 'passthrough',
]);
// Words that make a number a quantity rather than a credential: max_tokens, total_tokens, prompt_tokens.
const QUANTITY_WORDS = new Set([
  'max', 'min', 'total', 'count', 'limit', 'num', 'number', 'usage', 'prompt', 'completion',
  'input', 'output', 'cached', 'remaining', 'used', 'length', 'size',
]);

function wordsOf(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Does `key` name a secret? */
export function isSecretKey(key) {
  const words = wordsOf(key);
  const telling = words.filter((word) => !PLAIN_WORDS.has(word));
  if (telling.some((word) => STEM.test(word))) return true;
  // Keys split into words: api_key, private-key, session.id, X-API-Key.
  return STEM.test(telling.join(''));
}

/**
 * Is `value` under the secret `key` a harmless counter (max_tokens: 50) rather than a
 * credential? Only a number qualifies, and only when the key itself says it is a quantity.
 */
export function isQuantity(key, value) {
  return typeof value === 'number' && wordsOf(key).some((word) => QUANTITY_WORDS.has(word));
}
