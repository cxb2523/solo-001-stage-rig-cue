'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../src/server.js');

test('服务提供数据接口与页面', async (t) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const data = await (await fetch(base + '/api/data')).json();
  assert.ok(data.rig.battens.length >= 12);
  assert.ok(data.cues.length >= 8);

  const html = await (await fetch(base + '/')).text();
  assert.match(html, /舞台吊杆/);

  const model = await (await fetch(base + '/model.js')).text();
  assert.match(model, /simulate/);

  const notFound = await fetch(base + '/nope.js');
  assert.equal(notFound.status, 404);

  const escape = await fetch(base + '/..%2Fpackage.json');
  assert.ok(escape.status === 403 || escape.status === 404);
});
