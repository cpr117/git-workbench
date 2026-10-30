const audience = 'marketplace.visualstudio.com';
const emit = (event, data) => console.log('[orbit-oidc-diag] ' + JSON.stringify({ event, ...data }));
const fields = ['iss', 'aud', 'repository', 'repository_id', 'repository_owner_id', 'workflow_ref', 'job_workflow_ref', 'sub', 'ref', 'event_name', 'iat', 'nbf', 'exp'];
const requestIds = ['activityid', 'x-vss-e2eid', 'x-tfs-session', 'x-ms-request-id', 'x-request-id'];
const usedTokens = new Set();
const safeErrors = new Set(['GitHub OIDC environment unavailable', 'Unexpected GitHub OIDC host', 'GitHub OIDC response lacks token', 'Unexpected GitHub OIDC token format', 'GitHub repeated an OIDC token']);

async function probe(publisherName) {
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  const endpoint = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  if (!requestToken || !endpoint) throw new Error('GitHub OIDC environment unavailable');
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.actions.githubusercontent.com')) {
    throw new Error('Unexpected GitHub OIDC host');
  }
  url.searchParams.set('audience', audience);
  const github = await fetch(url, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${requestToken}` },
    signal: AbortSignal.timeout(15000),
  });
  emit('github-response', { publisherName, status: github.status });
  if (!github.ok) return false;
  const payload = await github.json();
  if (typeof payload.value !== 'string' || !payload.value) throw new Error('GitHub OIDC response lacks token');
  const token = payload.value;
  if (usedTokens.has(token)) throw new Error('GitHub repeated an OIDC token');
  usedTokens.add(token);
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Unexpected GitHub OIDC token format');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  const now = Math.floor(Date.now() / 1000);
  emit('claims', {
    publisherName,
    decodedOnly: true,
    claims: Object.fromEntries(fields.filter(key => claims[key] !== undefined).map(key => [key, claims[key]])),
    matches: {
      audience: claims.aud === audience || (Array.isArray(claims.aud) && claims.aud.includes(audience)),
      repository: claims.repository === process.env.GITHUB_REPOSITORY,
      repositoryId: String(claims.repository_id) === process.env.GITHUB_REPOSITORY_ID,
      ownerId: String(claims.repository_owner_id) === process.env.GITHUB_REPOSITORY_OWNER_ID,
      workflowRef: claims.workflow_ref === process.env.GITHUB_WORKFLOW_REF,
      ref: claims.ref === process.env.GITHUB_REF,
      time: claims.exp > now && (claims.nbf === undefined || claims.nbf <= now),
    },
  });
  const response = await fetch('https://marketplace.visualstudio.com/_apis/gallery/token?api-version=7.2-preview.1', {
    method: 'POST',
    headers: { Accept: 'application/json', Authorization: `FederatedToken ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'vsce' },
    body: JSON.stringify({ publisherName }),
    signal: AbortSignal.timeout(15000),
  });
  const ids = Object.fromEntries(requestIds.filter(key => response.headers.has(key)).map(key => [key, response.headers.get(key)]));
  let data;
  try { data = await response.json(); } catch { data = {}; }
  const credentialPresent = typeof data?.credential === 'string' && data.credential.length > 0;
  const details = {};
  if (!response.ok) {
    for (const key of ['userMessage', 'message', 'error_description', 'publisherName']) {
      if (typeof data?.[key] !== 'string') continue;
      details[key] = data[key].split(token).join('[REDACTED]').split(requestToken).join('[REDACTED]')
        .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, 512);
    }
  }
  emit('marketplace-response', { publisherName, status: response.status, credentialPresent, requestIds: ids, details });
  return response.ok && credentialPresent;
}

const results = [];
for (const publisherName of ['PRCooper', 'prcooper']) {
  try { results.push({ publisherName, authenticated: await probe(publisherName) }); }
  catch (error) {
    emit('probe-error', { publisherName, errorType: error?.name || 'Error', reason: safeErrors.has(error?.message) ? error.message : null, code: error?.cause?.code || null });
    results.push({ publisherName, authenticated: false });
  }
}
emit('summary', { results, uploadedExtension: false });
if (!results.some(result => result.authenticated)) process.exitCode = 1;
