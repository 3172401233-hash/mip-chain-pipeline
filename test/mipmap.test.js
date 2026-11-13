import test from 'node:test';
import assert from 'node:assert/strict';
import { generateMipChain, Semantics } from '../src/index.js';

function makePixels(width, height, fn) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = fn(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return data;
}

function pixelAt(level, x, y) {
  const i = (y * level.width + x) * 4;
  return [level.data[i], level.data[i + 1], level.data[i + 2], level.data[i + 3]];
}

function decodeNormal(level, x, y) {
  const [r, g, b] = pixelAt(level, x, y);
  return [(r / 255) * 2 - 1, (g / 255) * 2 - 1, (b / 255) * 2 - 1];
}

function alphaCoverage(level, cutoff = 128) {
  let covered = 0;
  const pixelCount = level.width * level.height;
  for (let i = 3; i < level.data.length; i += 4) {
    if (level.data[i] >= cutoff) covered++;
  }
  return covered / pixelCount;
}

test('尺寸逐级减半直到 1x1（2 次幂）', () => {
  const data = makePixels(16, 16, () => [10, 20, 30, 255]);
  const { levels } = generateMipChain({ data, width: 16, height: 16 });
  assert.deepEqual(
    levels.map((l) => [l.width, l.height]),
    [[16, 16], [8, 8], [4, 4], [2, 2], [1, 1]],
  );
  for (const level of levels) {
    assert.equal(level.data.length, level.width * level.height * 4);
  }
});

test('非 2 次幂尺寸逐级 ceil 减半直到 1x1', () => {
  const data = makePixels(7, 5, () => [1, 2, 3, 255]);
  const { levels } = generateMipChain({ data, width: 7, height: 5 });
  assert.deepEqual(
    levels.map((l) => [l.width, l.height]),
    [[7, 5], [4, 3], [2, 2], [1, 1]],
  );
});

test('纯色贴图所有级别保持不变', () => {
  const data = makePixels(5, 3, () => [10, 20, 30, 40]);
  const { levels } = generateMipChain({ data, width: 5, height: 3 });
  for (const level of levels) {
    for (let i = 0; i < level.data.length; i += 4) {
      assert.deepEqual(
        [level.data[i], level.data[i + 1], level.data[i + 2], level.data[i + 3]],
        [10, 20, 30, 40],
      );
    }
  }
});

test('线性颜色棋盘格平均为中灰', () => {
  const data = makePixels(8, 8, (x, y) => {
    const v = (x + y) % 2 === 0 ? 0 : 255;
    return [v, v, v, 255];
  });
  const { levels } = generateMipChain({ data, width: 8, height: 8, semantic: Semantics.COLOR });
  const last = levels[levels.length - 1];
  assert.deepEqual([last.width, last.height], [1, 1]);
  assert.deepEqual(pixelAt(last, 0, 0), [128, 128, 128, 255]);
});

test('sRGB 棋盘格在线性空间下采样（结果偏亮而非 128）', () => {
  const data = makePixels(8, 8, (x, y) => {
    const v = (x + y) % 2 === 0 ? 0 : 255;
    return [v, v, v, 255];
  });
  const { levels } = generateMipChain({ data, width: 8, height: 8, semantic: Semantics.SRGB });
  const last = levels[levels.length - 1];
  const [r, g, b] = pixelAt(last, 0, 0);
  // 线性 0.5 转回 sRGB 约为 0.7354 * 255 ≈ 188
  assert.ok(r >= 186 && r <= 190, `r=${r} 应接近 188`);
  assert.equal(g, r);
  assert.equal(b, r);
  assert.ok(r > 135, '若错误地在 sRGB 空间直接平均会得到约 128');
});

test('sRGB 纯色往返无损', () => {
  const data = makePixels(4, 4, () => [200, 100, 50, 255]);
  const { levels } = generateMipChain({ data, width: 4, height: 4, semantic: Semantics.SRGB });
  for (const level of levels) {
    for (let i = 0; i < level.data.length; i += 4) {
      assert.deepEqual(
        [level.data[i], level.data[i + 1], level.data[i + 2], level.data[i + 3]],
        [200, 100, 50, 255],
      );
    }
  }
});

test('渐变贴图 1x1 均值与整体均值一致', () => {
  const data = makePixels(16, 16, (x, y) => [x * 17, y * 17, 0, 255]);
  const { levels } = generateMipChain({ data, width: 16, height: 16 });
  const last = levels[levels.length - 1];
  const [r, g, b, a] = pixelAt(last, 0, 0);
  // x*17 在 0..15 上均值为 127.5
  assert.ok(Math.abs(r - 127.5) <= 1, `r=${r}`);
  assert.ok(Math.abs(g - 127.5) <= 1, `g=${g}`);
  assert.equal(b, 0);
  assert.equal(a, 255);
});

test('法线半球每级长度保持约 1', () => {
  const size = 8;
  const data = makePixels(size, size, (x, y) => {
    const nx = (((x + 0.5) / size) * 2 - 1) * 0.7;
    const ny = (((y + 0.5) / size) * 2 - 1) * 0.7;
    const nz = Math.sqrt(1 - nx * nx - ny * ny);
    return [
      Math.round((nx * 0.5 + 0.5) * 255),
      Math.round((ny * 0.5 + 0.5) * 255),
      Math.round((nz * 0.5 + 0.5) * 255),
      255,
    ];
  });
  const { levels } = generateMipChain({ data, width: size, height: size, semantic: Semantics.NORMAL });
  assert.equal(levels.length, 4);
  for (const level of levels.slice(1)) {
    for (let y = 0; y < level.height; y++) {
      for (let x = 0; x < level.width; x++) {
        const [nx, ny, nz] = decodeNormal(level, x, y);
        const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
        assert.ok(length > 0.98 && length < 1.02, `level ${level.level} 长度 ${length}`);
      }
    }
  }
});

test('法线平均接近零向量时回退到稳定值 (0,0,1)', () => {
  // 左半 +X，右半 -X，平均后为零向量
  const data = makePixels(4, 4, (x) => (x < 2 ? [255, 128, 128, 255] : [0, 128, 128, 255]));
  const { levels } = generateMipChain({ data, width: 4, height: 4, semantic: Semantics.NORMAL });
  const last = levels[levels.length - 1];
  const pixel = pixelAt(last, 0, 0);
  assert.deepEqual(pixel, [128, 128, 255, 255]);
  for (const v of pixel) assert.ok(Number.isFinite(v));
});

test('alpha-coverage：透明像素颜色不污染不透明区域', () => {
  // 左半红色不透明，右半绿色全透明
  const data = makePixels(6, 6, (x) => (x < 3 ? [255, 0, 0, 255] : [0, 255, 0, 0]));
  const { levels } = generateMipChain({
    data,
    width: 6,
    height: 6,
    semantic: Semantics.ALPHA_COVERAGE,
    preserveCoverage: false,
  });
  const level1 = levels[1];
  assert.deepEqual([level1.width, level1.height], [3, 3]);
  // 边界列：一个不透明 + 一个透明，颜色应为纯红而非暗红/黑色
  const [r, g, b, a] = pixelAt(level1, 1, 0);
  assert.equal(r, 255);
  assert.equal(g, 0);
  assert.equal(b, 0);
  assert.equal(a, 128);
  // 全透明块回退到非加权平均，保留绿色以便边缘扩张
  const transparent = pixelAt(level1, 2, 0);
  assert.equal(transparent[3], 0);
  assert.equal(transparent[1], 255);
});

test('alpha-coverage：Alpha 覆盖率跨级别保持', () => {
  const size = 16;
  const data = makePixels(size, size, (x, y) => [
    (x * 16) % 256,
    (y * 16) % 256,
    0,
    (x * 31 + y * 17 + x * y * 7) % 256,
  ]);
  const { levels } = generateMipChain({
    data,
    width: size,
    height: size,
    semantic: Semantics.ALPHA_COVERAGE,
  });
  const baseCoverage = alphaCoverage(levels[0]);
  assert.ok(baseCoverage > 0.3 && baseCoverage < 0.7, `base coverage=${baseCoverage}`);
  for (const level of levels.slice(1, 3)) {
    const coverage = alphaCoverage(level);
    assert.ok(
      Math.abs(coverage - baseCoverage) <= 0.1,
      `level ${level.level} coverage=${coverage}，期望接近 ${baseCoverage}`,
    );
  }
});

test('非 2 次幂边缘块按实际覆盖像素加权', () => {
  // 3x1：边缘块只覆盖 1 个像素，不能当成 2 个（补黑）平均
  const data = makePixels(3, 1, (x) => [[0, 100, 200][x], 0, 0, 255]);
  const { levels } = generateMipChain({ data, width: 3, height: 1 });
  assert.deepEqual(
    levels.map((l) => [l.width, l.height]),
    [[3, 1], [2, 1], [1, 1]],
  );
  assert.equal(pixelAt(levels[1], 0, 0)[0], 50);
  assert.equal(pixelAt(levels[1], 1, 0)[0], 200);
  assert.equal(pixelAt(levels[2], 0, 0)[0], 125);
});

test('1x1 输入直接返回单级', () => {
  const data = new Uint8Array([9, 8, 7, 6]);
  const { levels, stats } = generateMipChain({ data, width: 1, height: 1 });
  assert.equal(levels.length, 1);
  assert.deepEqual([...levels[0].data], [9, 8, 7, 6]);
  assert.equal(stats.length, 1);
  assert.equal(stats[0].meanAbsError, 0);
});

test('确定性：相同输入两次生成结果完全一致', () => {
  const data = makePixels(9, 7, (x, y) => [
    (x * 37 + y * 11) % 256,
    (x * 13 + y * 53) % 256,
    (x * 7 + y * 29) % 256,
    128 + ((x * y) % 128),
  ]);
  for (const semantic of Object.values(Semantics)) {
    const first = generateMipChain({ data, width: 9, height: 7, semantic });
    const second = generateMipChain({ data, width: 9, height: 7, semantic });
    assert.equal(first.levels.length, second.levels.length);
    for (let i = 0; i < first.levels.length; i++) {
      assert.deepEqual([...first.levels[i].data], [...second.levels[i].data], `${semantic} level ${i}`);
    }
    assert.deepEqual(first.stats, second.stats);
  }
});

test('每级记录平均误差统计', () => {
  const data = makePixels(8, 8, (x, y) => {
    const v = (x + y) % 2 === 0 ? 0 : 255;
    return [v, v, v, 255];
  });
  const { levels, stats } = generateMipChain({ data, width: 8, height: 8, semantic: Semantics.SRGB });
  assert.equal(stats.length, levels.length);
  for (let i = 0; i < stats.length; i++) {
    assert.equal(stats[i].level, i);
    assert.equal(stats[i].width, levels[i].width);
    assert.equal(stats[i].height, levels[i].height);
    assert.ok(Number.isFinite(stats[i].meanAbsError));
    assert.ok(Number.isFinite(stats[i].maxAbsError));
    assert.ok(stats[i].meanAbsError >= 0);
  }
  assert.equal(stats[0].meanAbsError, 0);
  // 8bit 量化误差应远小于 1 个色阶（1/255 ≈ 0.0039）的数倍
  assert.ok(stats[stats.length - 1].meanAbsError < 0.02);
});

test('非法输入抛出明确错误', () => {
  assert.throws(() => generateMipChain({ data: new Uint8Array(4), width: 0, height: 1 }), RangeError);
  assert.throws(() => generateMipChain({ data: new Uint8Array(8), width: 1, height: 1 }), RangeError);
  assert.throws(
    () => generateMipChain({ data: new Uint8Array(4), width: 1, height: 1, semantic: 'hdr' }),
    TypeError,
  );
});
