export function summarize(bytes, mediaType) {
  if (mediaType.includes('application/json')) {
    try {
      const value = JSON.parse(bytes);
      if (value.deliveryId && Array.isArray(value.roots)) return { format: 'delivery-index', deliveryId: value.deliveryId, roots: value.roots.length };
    } catch {}
  }
  return { format: 'html', language: bytes.toString('utf8').match(/<html[^>]*lang="([^"]+)/)?.[1] || null, byteLength: bytes.length };
}
