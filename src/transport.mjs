export async function retrieveChain(entry, allowedOrigin, { maximumBytes = 16 * 1024 * 1024, maximumHops = 8 } = {}) {
  const hops = [];
  let url = new URL(entry);
  for (;;) {
    if (url.origin !== allowedOrigin || url.username || url.password) {
      throw Object.assign(new Error('source_not_allowed'), { status: 403 });
    }
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    const headers = Object.fromEntries(response.headers);
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > maximumBytes) throw Object.assign(new Error('source_too_large'), { status: 413 });
      chunks.push(chunk);
    }
    const hop = {
      url: url.toString(),
      status: response.status,
      headers,
      mediaType: headers['content-type'] || 'application/octet-stream',
      bytes: Buffer.concat(chunks)
    };
    hops.push(hop);
    const location = headers.location;
    if (response.status >= 300 && response.status < 400 && location) {
      if (hops.length > maximumHops) throw Object.assign(new Error('redirect_loop'), { status: 502 });
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) throw Object.assign(new Error('source_response_' + response.status), { status: 502 });
    return { hops, final: hop };
  }
}
