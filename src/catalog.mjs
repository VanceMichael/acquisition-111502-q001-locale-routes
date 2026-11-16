import { createHash } from 'node:crypto';
import { retrieveDocument } from './transport.mjs';
import { summarize } from './summary.mjs';

const OBSERVATION_KIND = 'language-observation';
const OBSERVATION_HISTORY_KIND = 'language-observation-history';
const BODY_KIND = 'product-body';
const BODY_HISTORY_KIND = 'product-body-history';
const MANAGED_KINDS = new Set([OBSERVATION_KIND, OBSERVATION_HISTORY_KIND, BODY_KIND, BODY_HISTORY_KIND]);
const MANAGED_ISSUE_SOURCE = 'language-catalog';

export function normalizeLanguageTag(tag) {
  return typeof tag === 'string' ? tag.trim().toLowerCase() : '';
}

// 地区限定来自请求入口的语言标签（如 zh-HK 的地区子标签 HK），
// 与“正文实际是什么语言”是两条独立事实，不能互相代替。
export function regionOf(languageTag) {
  const parts = normalizeLanguageTag(languageTag).split('-');
  for (const part of parts.slice(1)) {
    if (/^[a-z]{2}$/.test(part)) return part.toUpperCase();
  }
  return null;
}

function byteOffset(text, index) {
  return Buffer.byteLength(text.slice(0, index), 'utf8');
}

function attribute(tag, name) {
  const match = tag.match(new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'));
  return match ? (match[1] ?? match[2] ?? match[3]) : null;
}

function decodeEntities(value) {
  return value.replace(/&(amp|lt|gt|quot|#39);/g, entity => ({
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  }[entity]));
}

function stripMarkup(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}

// 仅解析本来源契约用到的声明点：入口链接的 data-language、页面 html lang、
// Content-Language（由调用方从收件头传入）、data-product、canonical、alternate。
// 每个解析结果都带可复查的字节/行列位置，不引入第三方解析器。
export function parseLanguagePage(bytes, headerLanguage) {
  const text = bytes.toString('utf8');
  const htmlMatch = text.match(/<html\b[^>]*>/i);
  const htmlTag = htmlMatch ? htmlMatch[0] : null;
  const article = text.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  const articleTag = article ? text.slice(article.index, article.index + article[0].indexOf('>') + 1) : null;
  const anchors = [...text.matchAll(/<a\b[^>]*>/gi)].map(match => {
    const tag = match[0];
    const language = attribute(tag, 'data-language');
    if (!language) return null;
    const href = attribute(tag, 'href');
    return { language, href, location: `byte:${byteOffset(text, match.index)}` };
  }).filter(Boolean);
  const links = [...text.matchAll(/<link\b[^>]*>/gi)].map(match => {
    const tag = match[0];
    const rel = (attribute(tag, 'rel') || '').toLowerCase();
    const href = attribute(tag, 'href');
    const location = `byte:${byteOffset(text, match.index)}`;
    if (rel === 'canonical') return { type: 'canonical', href, location };
    if (rel === 'alternate') return { type: 'alternate', hreflang: attribute(tag, 'hreflang'), href, location };
    return null;
  }).filter(Boolean);
  const canonical = links.find(link => link.type === 'canonical') || null;
  const alternates = links.filter(link => link.type === 'alternate');
  const htmlLanguage = htmlTag ? attribute(htmlTag, 'lang') : null;
  const product = articleTag ? attribute(articleTag, 'data-product') : null;
  const textContent = article ? stripMarkup(article[1]) : null;
  const productLocation = articleTag
    ? `byte:${byteOffset(text, article.index)}`
    : null;
  return {
    entries: anchors,
    product,
    productLocation,
    htmlLanguage,
    htmlLanguageLocation: htmlMatch ? `byte:${byteOffset(text, htmlMatch.index)}` : null,
    headerLanguage: typeof headerLanguage === 'string' ? headerLanguage : null,
    canonical: canonical ? { href: canonical.href, location: canonical.location } : null,
    alternates: alternates.map(({ hreflang, href, location }) => ({ hreflang, href, location })),
    textContent,
  };
}

// 纯函数状态机：把“请求语言 / 页面声明 / 头声明 / 跳转事实”折成
// confirmed（真实译本）、fallback（自动回退）、unresolved（信号冲突或缺身份）。
// canonical 不参与判断——按站点契约它只标识产品，不是跨语言合并键。
export function decideObservation({ requestedLanguage, page, redirected, requestedUrl, finalUrl, hops }) {
  const requested = normalizeLanguageTag(requestedLanguage);
  const actual = normalizeLanguageTag(page.htmlLanguage);
  const header = normalizeLanguageTag(page.headerLanguage);
  const base = {
    product: page.product,
    requestedLanguage,
    actualLanguage: page.htmlLanguage || null,
    region: regionOf(requestedLanguage),
    canonical: page.canonical ? page.canonical.href : null,
    alternates: page.alternates,
    redirected,
    requestedUrl,
    finalUrl,
    hops,
  };
  if (!page.product) {
    return { value: { ...base, state: 'unresolved' }, conflict: 'missing_product_identity' };
  }
  const signals = [actual, header].filter(Boolean);
  const consistent = signals.length > 0 && signals.every(signal => signal === signals[0]);
  if (!consistent) {
    return { value: { ...base, state: 'unresolved' }, conflict: 'language_signal_conflict' };
  }
  if (!actual) {
    return { value: { ...base, state: 'unresolved' }, conflict: 'missing_language_signal' };
  }
  const state = actual === requested ? 'confirmed' : 'fallback';
  return { value: { ...base, state }, conflict: null };
}

export function observationKey(value) {
  return `${OBSERVATION_KIND}:${value.product || 'unidentified'}:${normalizeLanguageTag(value.requestedLanguage)}`;
}

export function bodyKey(value) {
  return `${BODY_KIND}:${value.product}:${normalizeLanguageTag(value.actualLanguage)}`;
}

function signature(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex').slice(0, 16);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== 'observedAt')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stable(item)]));
  }
  return value;
}

function traceOf(document) {
  return {
    requestedUrl: document.requestedUrl,
    finalUrl: document.finalUrl,
    redirected: document.redirected,
    hops: document.hops,
    headers: {
      ...(document.headers['content-language'] ? { 'content-language': document.headers['content-language'] } : {}),
      ...(document.headers['content-type'] ? { 'content-type': document.headers['content-type'] } : {}),
    },
  };
}

function hopLocations(document) {
  return document.hops.map((hop, index) =>
    `redirect:hop${index + 1}:${hop.status}:${hop.from}->${hop.to}`);
}

async function fetchAndArchive(archive, collectionId, url, stageLabel) {
  const document = await retrieveDocument(url, archive.allowedOrigin);
  const receipt = await archive.receive({
    collectionId,
    sourceKey: document.requestedUrl,
    revision: document.revision + (document.redirected ? '#final:' + document.finalUrl : ''),
    mediaType: document.mediaType,
    bytes: document.bytes,
    summary: summarize(document.bytes, document.mediaType),
    trace: traceOf(document),
  });
  return { document, receipt, stageLabel };
}

// 多语种目录采集：领取入口表，按入口声明的 data-language 逐一领取地区页，
// 所有自动取得的原文（含跳转落地页）都登记真实收件，再产出语言观察与正文记录。
// seed 是调用方已完成的入口领取（同源跳转已手动跟随、收件已登记），避免重复抓取。
export async function acquireLanguageCatalog({ archive, collectionId, entry, seed = null }) {
  const receiptIds = [];
  const newIssues = [];
  const candidates = [];
  let catalogReceiptId = null;
  let catalogPage = null;

  if (seed) {
    catalogReceiptId = seed.receipt.receiptId;
    receiptIds.push(catalogReceiptId);
    catalogPage = parseLanguagePage(seed.document.bytes, seed.document.headers['content-language']);
  } else {
    try {
      const catalog = await fetchAndArchive(archive, collectionId, entry, 'catalog');
      catalogReceiptId = catalog.receipt.receiptId;
      receiptIds.push(catalogReceiptId);
      catalogPage = parseLanguagePage(catalog.document.bytes, catalog.document.headers['content-language']);
    } catch (error) {
      return { recognized: false, receiptIds, error };
    }
  }
  if (!catalogPage.entries.length) return { recognized: false, receiptIds, error: null };

  for (const anchor of catalogPage.entries) {
    const pageUrl = new URL(anchor.href, entry).href;
    let document;
    let receipt;
    try {
      const fetched = await fetchAndArchive(archive, collectionId, pageUrl, 'entry');
      document = fetched.document;
      receipt = fetched.receipt;
      receiptIds.push(receipt.receiptId);
    } catch (error) {
      // 入口尚未核实：明确登记 unresolved 与 issue，绝不静默跳过，也不等于来源删除。
      newIssues.push({
        source: MANAGED_ISSUE_SOURCE,
        reason: 'entry_unverified:' + (error.message || 'fetch_failed'),
        location: anchor.location,
        requestedLanguage: anchor.language,
        requestedUrl: pageUrl,
      });
      candidates.push({
        kind: OBSERVATION_KIND,
        value: {
          product: null,
          requestedLanguage: anchor.language,
          actualLanguage: null,
          state: 'unresolved',
          region: regionOf(anchor.language),
          canonical: null,
          alternates: [],
          redirected: false,
          requestedUrl: pageUrl,
          finalUrl: null,
          hops: [],
        },
        provenance: [{ receiptId: catalogReceiptId, location: anchor.location }],
      });
      continue;
    }

    const page = parseLanguagePage(document.bytes, document.headers['content-language']);
    const decision = decideObservation({
      requestedLanguage: anchor.language,
      page,
      redirected: document.redirected,
      requestedUrl: document.requestedUrl,
      finalUrl: document.finalUrl,
      hops: document.hops,
    });

    const provenance = [
      { receiptId: catalogReceiptId, location: anchor.location },
      { receiptId: receipt.receiptId, location: page.htmlLanguageLocation || 'byte:0' },
    ];
    for (const location of hopLocations(document)) {
      provenance.push({ receiptId: receipt.receiptId, location });
    }
    if (page.canonical) provenance.push({ receiptId: receipt.receiptId, location: page.canonical.location });
    if (page.productLocation) provenance.push({ receiptId: receipt.receiptId, location: page.productLocation });

    if (decision.conflict) {
      newIssues.push({
        source: MANAGED_ISSUE_SOURCE,
        reason: decision.conflict,
        location: page.htmlLanguageLocation || 'header:content-language',
        requestedLanguage: anchor.language,
        requestedUrl: document.requestedUrl,
        finalUrl: document.finalUrl,
        receiptId: receipt.receiptId,
      });
    }
    candidates.push({ kind: OBSERVATION_KIND, value: decision.value, provenance });

    if (decision.value.state !== 'unresolved' && page.textContent !== null) {
      candidates.push({
        kind: BODY_KIND,
        value: {
          product: page.product,
          actualLanguage: page.htmlLanguage,
          region: decision.value.region,
          text: page.textContent,
          observedAt: new Date().toISOString(),
        },
        provenance: [{ receiptId: receipt.receiptId, location: page.productLocation || 'byte:0' }],
      });
    }
  }

  await commit(archive, collectionId, candidates, newIssues);
  return { recognized: true, receiptIds, error: null };
}

async function commit(archive, collectionId, candidates, newIssues) {
  await archive.mutateCollection(collectionId, collection => {
    const now = new Date().toISOString();
    const supersede = (kind, historyKind, key, record) => {
      const index = collection.records.indexOf(record);
      if (index >= 0) collection.records.splice(index, 1);
      collection.records.push({
        kind: historyKind,
        key: `${key}:superseded:${now}`,
        value: { ...record.value, supersededAt: now },
        provenance: record.provenance,
      });
    };

    for (const candidate of candidates) {
      const key = candidate.kind === OBSERVATION_KIND ? observationKey(candidate.value) : bodyKey(candidate.value);
      const existing = collection.records.find(record => record.kind === candidate.kind && record.key === key);
      const record = { kind: candidate.kind, key, value: candidate.value, provenance: candidate.provenance };
      if (!existing) {
        collection.records.push(record);
      } else if (signature(existing.value) !== signature(candidate.value)) {
        // 站点补发某语言：替换该语言的当前观察/正文；其他语言的已确认记录键不同，原样保留。
        const historyKind = candidate.kind === OBSERVATION_KIND ? OBSERVATION_HISTORY_KIND : BODY_HISTORY_KIND;
        supersede(candidate.kind, historyKind, key, existing);
        collection.records.push(record);
      }
    }

    collection.issues = collection.issues.filter(issue => issue.source !== MANAGED_ISSUE_SOURCE);
    collection.issues.push(...newIssues);
  });
}

export const catalogKinds = {
  OBSERVATION_KIND,
  OBSERVATION_HISTORY_KIND,
  BODY_KIND,
  BODY_HISTORY_KIND,
  MANAGED_KINDS,
};
