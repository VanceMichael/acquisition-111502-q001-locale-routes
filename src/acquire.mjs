import { retrieveChain } from './transport.mjs';
import { summarize } from './summary.mjs';
import { parseCatalogLinks, parsePage, regionOf, canonicalProduct, byteLocator } from './catalog.mjs';

const MAXIMUM_PAGES = 32;

function sameLanguage(left, right) {
  return typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase();
}

function pageDeclarations(result) {
  const contentLanguage = result.final.headers['content-language'] || null;
  const htmlLang = result.page.lang?.value || null;
  const conflict = Boolean(contentLanguage && htmlLang && !sameLanguage(contentLanguage, htmlLang));
  const actual = conflict ? null : (htmlLang || contentLanguage);
  return { contentLanguage, htmlLang, conflict, actual };
}

// 领取入口并解释多语种目录：每一跳都登记真实收件，语言观察与正文记录均可回查出处。
export async function acquire({ entry, allowedOrigin, archive, collectionId }) {
  const receiptIds = [];
  const note = receipt => { if (!receiptIds.includes(receipt.receiptId)) receiptIds.push(receipt.receiptId); };

  async function archiveHop(hop) {
    const redirect = hop.status >= 300 && hop.status < 400;
    const revision = hop.headers.etag || (redirect ? `redirect:${hop.status}:${hop.headers.location || ''}` : 'unversioned');
    const summary = redirect
      ? { format: 'redirect', status: hop.status, location: hop.headers.location || null }
      : summarize(hop.bytes, hop.mediaType);
    const receipt = await archive.receive({
      collectionId, sourceKey: hop.url, revision, mediaType: hop.mediaType,
      bytes: hop.bytes, summary, headers: hop.headers
    });
    note(receipt);
    return receipt;
  }

  async function fetchArchived(url) {
    const { hops } = await retrieveChain(url, allowedOrigin);
    const archived = [];
    for (const hop of hops) archived.push({ ...hop, receipt: await archiveHop(hop) });
    return { hops: archived, final: archived[archived.length - 1] };
  }

  const entryResult = await fetchArchived(entry);
  const entryFinal = entryResult.final;
  if (!entryFinal.mediaType.includes('text/html')) return { receiptIds };
  const catalogText = entryFinal.bytes.toString('utf8');
  const links = parseCatalogLinks(catalogText);
  if (links.length === 0) return { receiptIds };

  const records = [];
  const issues = [];
  const queue = links.map(link => ({
    language: link.language,
    href: new URL(link.href, entryFinal.url).toString(),
    declared: { receiptId: entryFinal.receipt.receiptId, location: byteLocator(catalogText, link.span) }
  }));
  const fetched = new Map();
  const pageTexts = new Map();

  // 目录入口与页面声明的 alternate 链都允许跟随，但只限当前来源内部。
  for (let index = 0; index < queue.length && fetched.size < MAXIMUM_PAGES; index += 1) {
    const item = queue[index];
    if (fetched.has(item.href)) continue;
    let result;
    try {
      const chain = await fetchArchived(item.href);
      if (!chain.final.mediaType.includes('text/html')) {
        throw Object.assign(new Error('unexpected_media_type'), { status: 502 });
      }
      const text = chain.final.bytes.toString('utf8');
      pageTexts.set(item.href, text);
      result = { ok: true, ...chain, page: parsePage(text) };
    } catch (error) {
      result = { ok: false, error };
    }
    fetched.set(item.href, result);
    if (result.ok) {
      for (const alternate of result.page.alternates) {
        const href = new URL(alternate.href, item.href).toString();
        if (new URL(href).origin !== allowedOrigin) continue;
        const known = fetched.has(href) || queue.some(queued => queued.href === href);
        if (!known) {
          queue.push({
            language: alternate.language, href,
            declared: { receiptId: result.final.receipt.receiptId, location: byteLocator(pageTexts.get(item.href), alternate.span) }
          });
        }
      }
    }
  }

  // 每个入口一条语言观察：请求语言来自入口声明，实际语言来自落点页面，两者一致才算确认。
  for (const item of queue) {
    const path = new URL(item.href).pathname;
    const result = fetched.get(item.href);
    if (!result) {
      issues.push({ reason: 'entry_not_verified', location: path, requestedLanguage: item.language, receiptId: item.declared.receiptId });
      continue;
    }
    if (!result.ok) {
      issues.push({
        reason: result.error.status === 403 ? 'entry_out_of_scope' : 'entry_unreachable',
        location: path, requestedLanguage: item.language, detail: result.error.message, receiptId: item.declared.receiptId
      });
      continue;
    }
    const text = pageTexts.get(item.href);
    const { contentLanguage, htmlLang, conflict, actual } = pageDeclarations(result);
    const product = result.page.product?.value || null;
    const provenance = [item.declared];
    for (const hop of result.hops) {
      if (hop.status >= 300 && hop.status < 400) provenance.push({ receiptId: hop.receipt.receiptId, location: 'header:location' });
    }
    if (result.page.lang) provenance.push({ receiptId: result.final.receipt.receiptId, location: byteLocator(text, result.page.lang.span) });
    if (contentLanguage) provenance.push({ receiptId: result.final.receipt.receiptId, location: 'header:content-language' });
    let state = 'unresolved';
    if (conflict) {
      issues.push({
        reason: 'language_declaration_conflict', location: path + ' header:content-language',
        receiptId: result.final.receipt.receiptId, detail: { contentLanguage, htmlLang }
      });
    } else if (!actual) {
      issues.push({ reason: 'language_declaration_missing', location: path, receiptId: result.final.receipt.receiptId });
    } else {
      state = sameLanguage(actual, item.language) ? 'confirmed' : 'fallback';
    }
    records.push({
      kind: 'language-observation',
      key: (product || 'unknown') + '/' + item.language,
      value: { product, requestedLanguage: item.language, actualLanguage: actual, state },
      provenance
    });
    if (!product) {
      issues.push({ reason: 'product_identity_missing', location: path, receiptId: result.final.receipt.receiptId });
    }
  }

  // 正文记录按 产品+实际语言+地区 归身份；声明冲突的页面不出正文记录，保持未确认。
  const bodies = new Map();
  for (const [href, result] of fetched) {
    if (!result.ok) continue;
    const text = pageTexts.get(href);
    const path = new URL(href).pathname;
    const { conflict, actual } = pageDeclarations(result);
    if (conflict || !actual) continue;
    const product = result.page.product?.value || null;
    if (!product || !result.page.article) continue;
    if (result.page.canonical && canonicalProduct(result.page.canonical.href) !== product) {
      issues.push({
        reason: 'canonical_product_mismatch', location: path,
        receiptId: result.final.receipt.receiptId, detail: { canonical: result.page.canonical.href, product }
      });
    }
    const receiptId = result.final.receipt.receiptId;
    const provenance = [{ receiptId, location: byteLocator(text, result.page.article.span) }];
    if (result.page.lang) provenance.push({ receiptId, location: byteLocator(text, result.page.lang.span) });
    if (result.page.canonical) provenance.push({ receiptId, location: byteLocator(text, result.page.canonical.span) });
    for (const alternate of result.page.alternates) provenance.push({ receiptId, location: byteLocator(text, alternate.span) });
    const record = {
      kind: 'product-body',
      key: product + '/' + actual,
      value: {
        product,
        language: actual,
        region: regionOf(actual),
        title: result.page.article.title,
        text: result.page.article.text,
        canonical: result.page.canonical?.href || null,
        alternates: result.page.alternates.map(alternate => ({ language: alternate.language, href: alternate.href }))
      },
      provenance
    };
    const existing = bodies.get(record.key);
    if (existing) {
      if (JSON.stringify(existing.value) !== JSON.stringify(record.value)) {
        issues.push({ reason: 'body_declaration_conflict', location: path, receiptId, detail: { key: record.key } });
      }
      continue;
    }
    bodies.set(record.key, record);
  }
  records.push(...bodies.values());

  await archive.applyInterpretation(collectionId, { records, issues });
  return { receiptIds };
}
