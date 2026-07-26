import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { crc32cBase64 } from '../../src/crc32c.js';
import { parsePlanUri } from '../../src/env.js';
import { LocalStorage, createStorage } from '../../src/storage.js';
import { tempDir } from '../helpers/fixtures.js';

test('gs:// разбирается в бакет и путь объекта', () => {
  const parsed = parsePlanUri('gs://reelio-render-eu/projects/proj_1/jobs/job_1/plan.json');
  assert.deepEqual(parsed, {
    mode: 'cloud',
    bucket: 'reelio-render-eu',
    objectPath: 'projects/proj_1/jobs/job_1/plan.json',
  });
});

test('file:// разбирается в корень и относительный путь (§10)', () => {
  const parsed = parsePlanUri('file:///srv/.render-local/projects/proj_1/jobs/job_1/plan.json');
  assert.equal(parsed.mode, 'local');
  assert.equal(parsed.root, '/srv/.render-local');
  assert.equal(parsed.objectPath, 'projects/proj_1/jobs/job_1/plan.json');
});

test('неподдерживаемая схема отклоняется', () => {
  assert.throws(() => parsePlanUri('http://example.com/plan.json'), /INVALID_REQUEST|адрес/);
  assert.throws(() => parsePlanUri('gs://bucket-only'), /адрес/);
});

test('режим выбирает бэкенд хранилища', () => {
  assert.equal(createStorage({ mode: 'local', localRoot: '/tmp/x' }).mode, 'local');
  assert.equal(createStorage({ mode: 'cloud', bucket: 'b' }).mode, 'cloud');
  assert.throws(() => createStorage({ mode: 'cloud', bucket: '' }), /хранилищ/i);
});

test('локальное хранилище читает план, копирует файлы и считает crc32c', async () => {
  const root = await tempDir();
  const storage = new LocalStorage(root);

  const planPath = path.join(root, 'projects/proj_1/jobs/job_1/plan.json');
  await mkdir(path.dirname(planPath), { recursive: true });
  await writeFile(planPath, JSON.stringify({ hello: 'мир' }));

  assert.deepEqual(await storage.readJson('projects/proj_1/jobs/job_1/plan.json'), { hello: 'мир' });

  const payload = Buffer.from('видеоданные');
  const srcPath = path.join(root, 'projects/proj_1/sources/asset_a.mp4');
  await mkdir(path.dirname(srcPath), { recursive: true });
  await writeFile(srcPath, payload);

  const dest = path.join(root, 'work/asset_a.mp4');
  const downloaded = await storage.download('projects/proj_1/sources/asset_a.mp4', dest);
  assert.equal(downloaded.sizeBytes, payload.length);
  assert.equal(downloaded.crc32c, crc32cBase64(payload));
  assert.deepEqual(await readFile(dest), payload);

  const uploaded = await storage.upload(dest, 'projects/proj_1/jobs/job_1/output/reel_1280p.mp4');
  assert.equal(uploaded.sizeBytes, payload.length);
  assert.deepEqual(
    await readFile(path.join(root, 'projects/proj_1/jobs/job_1/output/reel_1280p.mp4')),
    payload,
  );
});

test('битый план даёт PLAN_INVALID, а не падение разбора', async () => {
  const root = await tempDir();
  const storage = new LocalStorage(root);
  const planPath = path.join(root, 'projects/p/jobs/j/plan.json');
  await mkdir(path.dirname(planPath), { recursive: true });
  await writeFile(planPath, '{ это не json');

  await assert.rejects(
    () => storage.readJson('projects/p/jobs/j/plan.json'),
    (err) => err.code === 'PLAN_INVALID',
  );
});

test('отсутствующий исходник даёт SOURCE_UNREADABLE', async () => {
  const storage = new LocalStorage(await tempDir());
  await assert.rejects(
    () => storage.download('projects/p/sources/none.mp4', '/tmp/none.mp4'),
    (err) => err.code === 'SOURCE_UNREADABLE',
  );
});

test('путь за пределы корня отклоняется даже после проверок плана', async () => {
  const storage = new LocalStorage(await tempDir());
  await assert.rejects(
    () => storage.readJson('../../etc/passwd'),
    (err) => err.code === 'INVALID_OBJECT_PATH',
  );
});

test('удаление префикса убирает временные файлы', async () => {
  const root = await tempDir();
  const storage = new LocalStorage(root);
  await storage.writeText('projects/p/jobs/j/tmp/scratch.txt', 'мусор');

  await storage.removePrefix('projects/p/jobs/j/tmp/');
  await assert.rejects(() => readFile(path.join(root, 'projects/p/jobs/j/tmp/scratch.txt')));
});

test('удаление несуществующего префикса не считается ошибкой', async () => {
  const storage = new LocalStorage(await tempDir());
  await storage.removePrefix('projects/p/jobs/j/tmp/');
});
