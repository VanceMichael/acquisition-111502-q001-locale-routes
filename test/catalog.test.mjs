import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProvider } from '../provider/server.mjs';
import { createService } from '../src/service.mjs';
import descriptor from '../fixtures/descriptor.json' with { type: 'json' };
import { decideObservation, parseLanguagePage, regionOf } from '../src/catalog.mjs';

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function context(stage) {
  const directory = await mkdtemp(join(tmpdir(), 'catalog-'));
  const provider = createProvider({ stage });
  const source = await listen(provider.server);
  const service = await createService({ directory, allowedOrigin: source });
  const base = await listen(service.server);
  return {
    directory, provider, source, base,
    async call(path, body) {
      const response = await fetch(base + path, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: response.status, value: await response.json() };
    },
    async get(path) {
      const response = await fetch(base + path);
      return { status: response.status, value: await response.json() };
    },
    async close() {
      service.server.closeAllConnections(); provider.server.closeAllConnections();
      await Promise.all([new Promise(resolve => service.server.close(resolve)), new Promise(resolve => provider.server.close(resolve))]);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const ENTRY = () => descriptor.entry;

test('完整来源：回退、确认与未核实入口被分清，canonical 不作合并键', async () => {
  const ctx = await context('complete');
  try {
    const acquired = await ctx.call('/acquisitions', { collectionId: 'c1', entry: ctx.source + ENTRY() });
    assert.equal(acquired.status, 201);
    const collection = (await ctx.get('/collections/c1')).value;
    const observations = collection.records.filter(record => record.kind === 'language-observation');
    const byLanguage = Object.fromEntries(observations.map(record => [record.value.requestedLanguage, record]));

    assert.equal(byLanguage.th.value.state, 'fallback');
    assert.equal(byLanguage.th.value.actualLanguage, 'en');
    assert.equal(byLanguage.th.value.redirected, true);
    assert.equal(byLanguage.th.value.hops[0].from, ctx.source + '/pages/item/th');
    assert.equal(byLanguage.th.value.hops[0].to, ctx.source + '/pages/item/en');

    assert.equal(byLanguage['zh-HK'].value.state, 'confirmed');
    assert.equal(byLanguage['zh-HK'].value.actualLanguage, 'zh-HK');
    assert.equal(byLanguage['zh-HK'].value.region, 'HK');
    assert.equal(byLanguage.en.value.state, 'confirmed');
    assert.equal(byLanguage.en.value.region, null);

    // 三种语言各有独立记录键；共享同一 canonical 也不能合并成一条。
    const keys = new Set(observations.map(record => record.key));
    assert.equal(keys.size, 3);
    assert.ok(observations.every(record => record.value.canonical === '/product/p1'));

    // 运营视角：哪些确认、哪些只是回退，一眼可分。
    assert.deepEqual(observations.map(record => record.value.state).sort(), ['confirmed', 'confirmed', 'fallback']);

    // 每条观察都能回到真实收件、入口位置、跳转记录与页面声明。
    for (const record of observations) {
      assert.ok(record.provenance.length >= 2);
      for (const origin of record.provenance) {
        const receipt = await ctx.get('/receipts/' + origin.receiptId);
        assert.equal(receipt.status, 200);
        assert.equal(receipt.value.collectionId, 'c1');
        assert.match(origin.location, /^(byte:|redirect:|header:)/);
      }
    }
    const thReceipt = await ctx.get('/receipts/' + byLanguage.th.provenance[1].receiptId);
    assert.equal(thReceipt.value.trace.redirected, true);
    assert.equal(thReceipt.value.trace.requestedUrl, ctx.source + '/pages/item/th');
    assert.equal(thReceipt.value.trace.finalUrl, ctx.source + '/pages/item/en');

    // 正文记录按产品+实际语言区分；回退拿到的英文正文不会被标成泰文。
    const bodies = collection.records.filter(record => record.kind === 'product-body');
    const bodyLanguages = bodies.map(record => record.value.actualLanguage).sort();
    assert.deepEqual(bodyLanguages, ['en', 'zh-HK']);
    assert.ok(bodies.every(record => record.value.text.length > 0));
  } finally { await ctx.close(); }
});

test('重复采集幂等：来源未变化时不产生新记录或历史', async () => {
  const ctx = await context('complete');
  try {
    await ctx.call('/acquisitions', { collectionId: 'idem', entry: ctx.source + ENTRY() });
    const first = (await ctx.get('/collections/idem')).value;
    await ctx.call('/acquisitions', { collectionId: 'idem', entry: ctx.source + ENTRY() });
    const second = (await ctx.get('/collections/idem')).value;
    assert.deepEqual(second.records, first.records);
    assert.deepEqual(second.issues, first.issues);
    assert.ok(second.records.every(record => !record.kind.endsWith('-history')));
  } finally { await ctx.close(); }
});

test('partial 来源：HTTP 语言与页面语言冲突时保持未确认并登记 issue', async () => {
  const ctx = await context('partial');
  try {
    const acquired = await ctx.call('/acquisitions', { collectionId: 'part', entry: ctx.source + ENTRY() });
    assert.ok(acquired.status < 500);
    const collection = (await ctx.get('/collections/part')).value;
    assert.ok(collection.receiptIds.length > 0, '已领取原文不能丢失');
    assert.ok(collection.issues.length > 0);
    const conflict = collection.issues.find(issue => issue.reason === 'language_signal_conflict');
    assert.ok(conflict, '应说明语言信号冲突');
    assert.ok(conflict.location);
    const observations = collection.records.filter(record => record.kind === 'language-observation');
    const hk = observations.find(record => record.value.requestedLanguage === 'zh-HK');
    assert.equal(hk.value.state, 'unresolved');
    // 冲突页不得当成已确认译本写入正文记录。
    assert.ok(!collection.records.some(record => record.kind === 'product-body'
      && record.value.actualLanguage === 'zh-HK' && record.value.region === 'HK'));
    // 泰语入口在 partial 仍回退英文，观察如实保留。
    const th = observations.find(record => record.value.requestedLanguage === 'th');
    assert.equal(th.value.state, 'fallback');
  } finally { await ctx.close(); }
});

test('站点补发泰语：替换该语言的回退观察并保留历史，其他地区已确认正文不变', async () => {
  const ctx = await context('complete');
  try {
    await ctx.call('/acquisitions', { collectionId: 'staged', entry: ctx.source + ENTRY() });
    const before = (await ctx.get('/collections/staged')).value;
    const fallbackTh = before.records.find(record => record.kind === 'language-observation'
      && record.value.requestedLanguage === 'th');
    assert.equal(fallbackTh.value.state, 'fallback');
    const hkBefore = JSON.stringify(before.records.find(record => record.kind === 'product-body'
      && record.value.actualLanguage === 'zh-HK'));
    const enObservationBefore = JSON.stringify(before.records.find(record => record.kind === 'language-observation'
      && record.value.requestedLanguage === 'en'));

    // 来源补发泰语：同一服务、同一收件目录，仅切换来源阶段。
    ctx.provider.setStage('translated');
    await ctx.call('/acquisitions', { collectionId: 'staged', entry: ctx.source + ENTRY() });
    const after = (await ctx.get('/collections/staged')).value;

    const currentTh = after.records.filter(record => record.kind === 'language-observation')
      .find(record => record.value.requestedLanguage === 'th');
    assert.equal(currentTh.value.state, 'confirmed');
    assert.equal(currentTh.value.actualLanguage, 'th');
    assert.equal(currentTh.value.redirected, false);
    assert.deepEqual(currentTh.value.hops, []);

    const history = after.records.filter(record => record.kind === 'language-observation-history');
    assert.equal(history.length, 1);
    assert.equal(history[0].value.state, 'fallback');
    assert.equal(history[0].value.actualLanguage, 'en');
    assert.ok(history[0].value.supersededAt);
    // 历史观察仍绑定回退时的真实收件。
    assert.ok(history[0].provenance.every(origin => origin.receiptId));

    // 泰文正文新登记；英文、香港已确认正文与英文观察原样保留。
    const thBody = after.records.find(record => record.kind === 'product-body'
      && record.value.actualLanguage === 'th');
    assert.ok(thBody);
    assert.match(thBody.value.text, /ชุดตรวจ/);
    const hkAfter = JSON.stringify(after.records.find(record => record.kind === 'product-body'
      && record.value.actualLanguage === 'zh-HK'));
    assert.equal(hkAfter, hkBefore);
    const enObservationAfter = JSON.stringify(after.records.find(record => record.kind === 'language-observation'
      && record.value.requestedLanguage === 'en'));
    assert.equal(enObservationAfter, enObservationBefore);

    // 回退时期的英文正文记录仍然存在，未被泰语补发改写。
    assert.ok(after.records.some(record => record.kind === 'product-body' && record.value.actualLanguage === 'en'));
  } finally { await ctx.close(); }
});

test('跳转与声明位置均可在收件中追溯', async () => {
  const ctx = await context('complete');
  try {
    await ctx.call('/acquisitions', { collectionId: 'trace', entry: ctx.source + ENTRY() });
    const collection = (await ctx.get('/collections/trace')).value;
    const th = collection.records.find(record => record.kind === 'language-observation'
      && record.value.requestedLanguage === 'th');
    const locations = th.provenance.map(origin => origin.location);
    assert.ok(locations.some(location => location.startsWith('redirect:hop1:302:')));
    assert.ok(locations.some(location => location.startsWith('byte:')));
    assert.equal(th.value.canonical, '/product/p1');
    const receipts = await Promise.all(th.provenance.map(origin => ctx.get('/receipts/' + origin.receiptId)));
    assert.ok(receipts.every(receipt => receipt.status === 200));
  } finally { await ctx.close(); }
});

test('非目录入口保持原始领取：只登记收件，不编造语言观察', async () => {
  const ctx = await context('complete');
  try {
    const acquired = await ctx.call('/acquisitions', { collectionId: 'raw', entry: ctx.source + '/deliveries' });
    assert.equal(acquired.status, 201);
    assert.equal(acquired.value.receiptIds.length, 1);
    const collection = (await ctx.get('/collections/raw')).value;
    assert.equal(collection.records.length, 0);
    assert.equal(collection.issues.length, 0);
    const receipt = await ctx.get('/receipts/' + acquired.value.receiptIds[0]);
    assert.equal(receipt.value.summary.format, 'delivery-index');
  } finally { await ctx.close(); }
});

test('授权来源之外的地址不发送目录请求', async () => {
  const ctx = await context('complete');
  try {
    const result = await ctx.call('/acquisitions', { collectionId: 'scope', entry: 'http://outside.invalid/catalog' });
    assert.equal(result.status, 403);
    assert.equal(ctx.provider.requests.length, 0);
  } finally { await ctx.close(); }
});

test('状态机纯函数：信号冲突 unresolved，回退与确认按实际语言判定', () => {
  const base = { redirected: false, requestedUrl: 'u', finalUrl: 'u', hops: [] };
  const confirmed = decideObservation({
    requestedLanguage: 'zh-HK',
    page: parseLanguagePage(Buffer.from('<html lang="zh-HK"><article data-product="p1">x</article></html>'), 'zh-HK'),
    ...base,
  });
  assert.equal(confirmed.value.state, 'confirmed');
  assert.equal(confirmed.value.region, 'HK');

  const conflict = decideObservation({
    requestedLanguage: 'zh-HK',
    page: parseLanguagePage(Buffer.from('<html lang="zh-HK"><article data-product="p1">x</article></html>'), 'en'),
    ...base,
  });
  assert.equal(conflict.value.state, 'unresolved');
  assert.equal(conflict.conflict, 'language_signal_conflict');

  const fallback = decideObservation({
    requestedLanguage: 'th',
    page: parseLanguagePage(Buffer.from('<html lang="en"><article data-product="p1">x</article></html>'), 'en'),
    ...base,
  });
  assert.equal(fallback.value.state, 'fallback');
  assert.equal(fallback.value.actualLanguage, 'en');

  const noProduct = decideObservation({
    requestedLanguage: 'th',
    page: parseLanguagePage(Buffer.from('<html lang="en">missing</html>'), 'en'),
    ...base,
  });
  assert.equal(noProduct.value.state, 'unresolved');
  assert.equal(noProduct.conflict, 'missing_product_identity');
  assert.equal(regionOf('en'), null);
  assert.equal(regionOf('zh-Hant-HK'), 'HK');
});
