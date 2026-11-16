const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAXIMUM_HOPS = 5;

function assertSameOrigin(url, allowedOrigin) {
  if (url.origin !== allowedOrigin || url.username || url.password) {
    throw Object.assign(new Error('source_not_allowed'), { status: 403 });
  }
}

async function readBody(response, maximumBytes) {
  let length = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maximumBytes) throw Object.assign(new Error('source_too_large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// 手动跟随来源内跳转：每一跳都留下记录，绝不把跳转交给 fetch 自动合并，
// 否则“请求的是泰文、落地的是英文”这一事实会在客户端层丢失。
export async function retrieveDocument(entry, allowedOrigin, maximumBytes = 16 * 1024 * 1024) {
  const first = new URL(entry);
  assertSameOrigin(first, allowedOrigin);
  const hops = [];
  const seen = new Set();
  let current = first;
  for (let attempt = 0; attempt <= MAXIMUM_HOPS; attempt++) {
    if (seen.has(current.href)) throw Object.assign(new Error('source_redirect_loop'), { status: 502 });
    seen.add(current.href);
    const response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw Object.assign(new Error('source_redirect_without_location'), { status: 502 });
      const next = new URL(location, current);
      assertSameOrigin(next, allowedOrigin);
      hops.push({ status: response.status, from: current.href, to: next.href });
      response.body?.cancel?.().catch(() => {});
      current = next;
      continue;
    }
    if (!response.ok) throw Object.assign(new Error('source_response_' + response.status), { status: 502 });
    const bytes = await readBody(response, maximumBytes);
    return {
      bytes,
      mediaType: response.headers.get('content-type') || 'application/octet-stream',
      revision: response.headers.get('etag') || 'unversioned',
      headers: Object.fromEntries(response.headers),
      requestedUrl: first.href,
      finalUrl: current.href,
      hops,
      redirected: hops.length > 0,
    };
  }
  throw Object.assign(new Error('source_redirect_limit'), { status: 502 });
}
