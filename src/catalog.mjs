function attribute(tag, name) {
  const pattern = new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')');
  const match = tag.match(pattern);
  return match ? (match[1] ?? match[2]) : null;
}

export function stripMarkup(markup) {
  return markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// 入口目录只认 data-language 明确声明语言的链接；目录本身不代表可用译本全集。
export function parseCatalogLinks(text) {
  const links = [];
  const pattern = /<a\b[^>]*>/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const language = attribute(match[0], 'data-language');
    const href = attribute(match[0], 'href');
    if (language && href) links.push({ language, href, span: [match.index, match.index + match[0].length] });
  }
  return links;
}

// 页面声明：html lang、canonical（仅标识产品）、alternate 替代译本链、data-product 与正文。
export function parsePage(text) {
  const htmlMatch = /<html\b[^>]*>/.exec(text);
  const htmlLang = htmlMatch ? attribute(htmlMatch[0], 'lang') : null;
  const lang = htmlLang ? { value: htmlLang, span: [htmlMatch.index, htmlMatch.index + htmlMatch[0].length] } : null;
  let canonical = null;
  const alternates = [];
  const linkPattern = /<link\b[^>]*>/g;
  let match;
  while ((match = linkPattern.exec(text)) !== null) {
    const rel = attribute(match[0], 'rel');
    const href = attribute(match[0], 'href');
    const span = [match.index, match.index + match[0].length];
    if (rel === 'canonical' && href) canonical = { href, span };
    if (rel === 'alternate' && href) {
      const hreflang = attribute(match[0], 'hreflang');
      if (hreflang) alternates.push({ language: hreflang, href, span });
    }
  }
  const articleMatch = /<article\b[^>]*>/.exec(text);
  let product = null;
  let article = null;
  if (articleMatch) {
    const productId = attribute(articleMatch[0], 'data-product');
    if (productId) product = { value: productId, span: [articleMatch.index, articleMatch.index + articleMatch[0].length] };
    const close = text.indexOf('</article>', articleMatch.index + articleMatch[0].length);
    if (close !== -1) {
      const inner = text.slice(articleMatch.index + articleMatch[0].length, close);
      const heading = /<h1\b[^>]*>([\s\S]*?)<\/h1>/.exec(inner);
      article = {
        span: [articleMatch.index, close + '</article>'.length],
        title: heading ? stripMarkup(heading[1]) : null,
        text: stripMarkup(inner)
      };
    }
  }
  return { lang, canonical, alternates, product, article };
}

// 地区限定来自实际语言标签的地区子标签（如 zh-HK → HK）；无地区子标签表示不限地区。
export function regionOf(language) {
  if (typeof language !== 'string') return null;
  const parts = language.split('-');
  for (let index = 1; index < parts.length; index += 1) {
    if (/^[a-zA-Z]{2}$/.test(parts[index]) || /^\d{3}$/.test(parts[index])) return parts[index].toUpperCase();
  }
  return null;
}

// canonical 只用于核对产品身份，不作为跨语言合并键。
export function canonicalProduct(href) {
  if (typeof href !== 'string') return null;
  const segments = href.split('/').filter(Boolean);
  return segments.length ? segments[segments.length - 1] : null;
}

// 定位以原始字节的 UTF-8 偏移表示，多语言正文的字符下标不等于字节下标。
export function byteLocator(text, span) {
  const start = Buffer.byteLength(text.slice(0, span[0]), 'utf8');
  const end = start + Buffer.byteLength(text.slice(span[0], span[1]), 'utf8');
  return 'byte:' + start + '-' + end;
}
