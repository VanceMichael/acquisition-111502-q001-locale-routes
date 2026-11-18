import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import descriptor from '../fixtures/descriptor.json' with { type: 'json' };

const observation = (collection, language) =>
  collection.records.find(record => record.kind === 'language-observation' && record.value.requestedLanguage === language);
const body = (collection, key) =>
  collection.records.find(record => record.kind === 'product-body' && record.key === key);

test('目录采集分清请求语言、实际语言、地区与替代译本', async () => {
  const context = await harness();
  try {
    const acquired = await context.call('/acquisitions', { collectionId: 'locale', entry: context.source + descriptor.entry, options: descriptor.options || {} });
    assert.equal(acquired.status, 201);
    const collection = (await context.call('/collections/locale')).value;

    const thai = observation(collection, 'th');
    assert.equal(thai.value.product, 'p1');
    assert.equal(thai.value.actualLanguage, 'en');
    assert.equal(thai.value.state, 'fallback');
    assert.equal(observation(collection, 'en').value.state, 'confirmed');
    assert.equal(observation(collection, 'zh-HK').value.state, 'confirmed');

    // canonical 三页同为 /product/p1，但语言观察与正文各自独立，不按 canonical 合并
    const bodies = collection.records.filter(record => record.kind === 'product-body');
    assert.deepEqual(bodies.map(record => record.key).sort(), ['p1/en', 'p1/zh-HK']);
    for (const record of bodies) assert.equal(record.value.canonical, '/product/p1');
    const hk = body(collection, 'p1/zh-HK');
    assert.equal(hk.value.region, 'HK');
    assert.match(hk.value.text, /香港地區版本/);
    assert.deepEqual(hk.value.alternates, [{ language: 'en', href: '/pages/item/en' }]);
    assert.equal(body(collection, 'p1/en').value.region, null);

    // 回退观察可追到当时的跳转与页面声明
    const receipts = new Map();
    for (const origin of thai.provenance) {
      receipts.set(origin.receiptId, (await context.call('/receipts/' + origin.receiptId)).value);
    }
    const chain = thai.provenance.map(origin => receipts.get(origin.receiptId));
    assert.ok(chain.some(receipt => receipt.sourceKey.endsWith('/catalog')), '缺少入口声明出处');
    const hop = chain.find(receipt => receipt.summary?.format === 'redirect');
    assert.ok(hop, '缺少当时的跳转收件');
    assert.equal(hop.summary.location, '/pages/item/en');
    assert.ok(hop.sourceKey.endsWith('/pages/item/th'));
    const landing = chain.find(receipt => receipt.sourceKey.endsWith('/pages/item/en'));
    assert.equal(landing.headers['content-language'], 'en');
    assert.ok(thai.provenance.some(origin => origin.location === 'header:location'));
    assert.ok(thai.provenance.some(origin => origin.location.startsWith('byte:')));
  } finally { await context.close(); }
});

test('补译后替换该语言回退观察，不改写其他地区已确认正文', async () => {
  const context = await harness();
  try {
    await context.call('/acquisitions', { collectionId: 'locale', entry: context.source + descriptor.entry });
    const before = (await context.call('/collections/locale')).value;
    context.provider.setStage('translated');
    await context.call('/acquisitions', { collectionId: 'locale', entry: context.source + descriptor.entry });
    const after = (await context.call('/collections/locale')).value;

    const thai = observation(after, 'th');
    assert.equal(thai.value.state, 'confirmed');
    assert.equal(thai.value.actualLanguage, 'th');
    assert.ok(!after.records.some(record => record.kind === 'language-observation' && record.value.requestedLanguage === 'th' && record.value.state === 'fallback'),
      '当前视图不应保留回退观察');
    assert.ok(after.history.some(record => record.kind === 'language-observation' && record.value.requestedLanguage === 'th' && record.value.state === 'fallback'),
      '历史应保留回退观察');

    assert.deepEqual(observation(after, 'zh-HK'), observation(before, 'zh-HK'), '其他地区观察被改写');
    assert.deepEqual(body(after, 'p1/zh-HK'), body(before, 'p1/zh-HK'), '其他地区正文被改写');
    assert.deepEqual(body(after, 'p1/en'), body(before, 'p1/en'), '英语正文被改写');

    const translated = body(after, 'p1/th');
    assert.equal(translated.value.language, 'th');
    assert.match(translated.value.text, /ฉบับภาษาไทย/);
    assert.ok(!body(before, 'p1/th'), '补译前不应有泰语正文');
  } finally { await context.close(); }
});

test('HTTP 语言与页面语言冲突的入口保持未确认并说明问题', async () => {
  const context = await harness('partial');
  try {
    const result = await context.call('/acquisitions', { collectionId: 'locale', entry: context.source + descriptor.entry });
    assert.ok(result.status < 500);
    const collection = (await context.call('/collections/locale')).value;
    const hk = observation(collection, 'zh-HK');
    assert.equal(hk.value.state, 'unresolved');
    assert.equal(hk.value.actualLanguage, null);
    assert.ok(collection.issues.some(issue => issue.reason === 'language_declaration_conflict'));
    assert.ok(!body(collection, 'p1/zh-HK'), '冲突页面不应出正文记录');
    assert.equal(observation(collection, 'th').value.state, 'fallback');
  } finally { await context.close(); }
});
