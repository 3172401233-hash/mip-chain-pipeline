// 平均法线长度低于该阈值视为退化：8bit 量化残差约 0.006，
// 取 0.01 可过滤相互抵消的法线，又不会误伤正常合成结果
const NORMAL_ZERO_EPSILON = 1e-2;
const DEFAULT_ALPHA_CUTOFF = 0.5;
const COVERAGE_SEARCH_ITERATIONS = 48;
const COVERAGE_MAX_SCALE = 64;

export const Semantics = Object.freeze({
  COLOR: 'color',
  SRGB: 'srgb',
  NORMAL: 'normal',
  ALPHA_COVERAGE: 'alpha-coverage',
});

const KNOWN_SEMANTICS = new Set(Object.values(Semantics));

export function srgbToLinear(value) {
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(value) {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
}

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function clampNormal(value) {
  return value < -1 ? -1 : value > 1 ? 1 : value;
}

function decodeLevel(semantic, data, pixelCount) {
  const out = new Float64Array(pixelCount * 4);
  for (let i = 0, o = 0; o < out.length; i += 4, o += 4) {
    if (semantic === Semantics.SRGB) {
      out[o] = srgbToLinear(data[i] / 255);
      out[o + 1] = srgbToLinear(data[i + 1] / 255);
      out[o + 2] = srgbToLinear(data[i + 2] / 255);
      out[o + 3] = data[i + 3] / 255;
    } else if (semantic === Semantics.NORMAL) {
      out[o] = (data[i] / 255) * 2 - 1;
      out[o + 1] = (data[i + 1] / 255) * 2 - 1;
      out[o + 2] = (data[i + 2] / 255) * 2 - 1;
      out[o + 3] = data[i + 3] / 255;
    } else {
      out[o] = data[i] / 255;
      out[o + 1] = data[i + 1] / 255;
      out[o + 2] = data[i + 2] / 255;
      out[o + 3] = data[i + 3] / 255;
    }
  }
  return out;
}

function encodeLevel(semantic, floats, pixelCount) {
  const out = new Uint8Array(pixelCount * 4);
  for (let i = 0, o = 0; i < out.length; i += 4, o += 4) {
    if (semantic === Semantics.SRGB) {
      out[i] = Math.round(linearToSrgb(clamp01(floats[o])) * 255);
      out[i + 1] = Math.round(linearToSrgb(clamp01(floats[o + 1])) * 255);
      out[i + 2] = Math.round(linearToSrgb(clamp01(floats[o + 2])) * 255);
      out[i + 3] = Math.round(clamp01(floats[o + 3]) * 255);
    } else if (semantic === Semantics.NORMAL) {
      out[i] = Math.round((clampNormal(floats[o]) * 0.5 + 0.5) * 255);
      out[i + 1] = Math.round((clampNormal(floats[o + 1]) * 0.5 + 0.5) * 255);
      out[i + 2] = Math.round((clampNormal(floats[o + 2]) * 0.5 + 0.5) * 255);
      out[i + 3] = Math.round(clamp01(floats[o + 3]) * 255);
    } else {
      out[i] = Math.round(clamp01(floats[o]) * 255);
      out[i + 1] = Math.round(clamp01(floats[o + 1]) * 255);
      out[i + 2] = Math.round(clamp01(floats[o + 2]) * 255);
      out[i + 3] = Math.round(clamp01(floats[o + 3]) * 255);
    }
  }
  return out;
}

function downsampleFloat(semantic, src, srcWidth, srcHeight) {
  const dstWidth = Math.max(1, (srcWidth + 1) >> 1);
  const dstHeight = Math.max(1, (srcHeight + 1) >> 1);
  const out = new Float64Array(dstWidth * dstHeight * 4);
  for (let y = 0; y < dstHeight; y++) {
    const y0 = y * 2;
    const y1 = Math.min(y0 + 2, srcHeight);
    for (let x = 0; x < dstWidth; x++) {
      const x0 = x * 2;
      const x1 = Math.min(x0 + 2, srcWidth);
      let count = 0;
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumA = 0;
      let weightedR = 0;
      let weightedG = 0;
      let weightedB = 0;
      let weightSum = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * srcWidth + sx) * 4;
          const alpha = src[i + 3];
          sumR += src[i];
          sumG += src[i + 1];
          sumB += src[i + 2];
          sumA += alpha;
          weightedR += src[i] * alpha;
          weightedG += src[i + 1] * alpha;
          weightedB += src[i + 2] * alpha;
          weightSum += alpha;
          count++;
        }
      }
      const o = (y * dstWidth + x) * 4;
      if (semantic === Semantics.NORMAL) {
        const nx = sumR / count;
        const ny = sumG / count;
        const nz = sumB / count;
        const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (length < NORMAL_ZERO_EPSILON) {
          out[o] = 0;
          out[o + 1] = 0;
          out[o + 2] = 1;
        } else {
          out[o] = nx / length;
          out[o + 1] = ny / length;
          out[o + 2] = nz / length;
        }
        out[o + 3] = sumA / count;
      } else if (semantic === Semantics.ALPHA_COVERAGE) {
        if (weightSum > 0) {
          out[o] = weightedR / weightSum;
          out[o + 1] = weightedG / weightSum;
          out[o + 2] = weightedB / weightSum;
        } else {
          out[o] = sumR / count;
          out[o + 1] = sumG / count;
          out[o + 2] = sumB / count;
        }
        out[o + 3] = sumA / count;
      } else {
        out[o] = sumR / count;
        out[o + 1] = sumG / count;
        out[o + 2] = sumB / count;
        out[o + 3] = sumA / count;
      }
    }
  }
  return { data: out, width: dstWidth, height: dstHeight };
}

function computeCoverage(floats, cutoff) {
  let covered = 0;
  const pixelCount = floats.length / 4;
  for (let i = 3; i < floats.length; i += 4) {
    if (floats[i] >= cutoff) covered++;
  }
  return covered / pixelCount;
}

function coverageAtScale(floats, scale, cutoff) {
  let covered = 0;
  const pixelCount = floats.length / 4;
  for (let i = 3; i < floats.length; i += 4) {
    if (clamp01(floats[i] * scale) >= cutoff) covered++;
  }
  return covered / pixelCount;
}

function applyCoveragePreservation(floats, cutoff, targetCoverage) {
  const current = computeCoverage(floats, cutoff);
  if (current === 0 || targetCoverage === 0 || current === targetCoverage) return;
  let lo = 0;
  let hi = COVERAGE_MAX_SCALE;
  for (let iteration = 0; iteration < COVERAGE_SEARCH_ITERATIONS; iteration++) {
    const mid = (lo + hi) / 2;
    if (coverageAtScale(floats, mid, cutoff) < targetCoverage) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const scale = (lo + hi) / 2;
  for (let i = 3; i < floats.length; i += 4) {
    floats[i] = clamp01(floats[i] * scale);
  }
}

export function generateMipChain(options = {}) {
  const {
    width,
    height,
    semantic = Semantics.COLOR,
    alphaCutoff = DEFAULT_ALPHA_CUTOFF,
    preserveCoverage,
  } = options;
  let { data } = options;

  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new RangeError(`width/height 必须是 >= 1 的整数，收到 ${width}x${height}`);
  }
  if (!KNOWN_SEMANTICS.has(semantic)) {
    throw new TypeError(`未知纹理语义: ${semantic}`);
  }
  if (data == null) {
    throw new TypeError('缺少 RGBA8 像素数据 data');
  }
  if (!(data instanceof Uint8Array)) {
    data = Uint8Array.from(data);
  }
  if (data.length !== width * height * 4) {
    throw new RangeError(`像素数据长度 ${data.length} 与 ${width}x${height} RGBA 不符`);
  }
  if (!(alphaCutoff > 0 && alphaCutoff < 1)) {
    throw new RangeError(`alphaCutoff 必须在 (0, 1) 区间内，收到 ${alphaCutoff}`);
  }

  const shouldPreserveCoverage =
    preserveCoverage !== undefined
      ? Boolean(preserveCoverage)
      : semantic === Semantics.ALPHA_COVERAGE;

  const levels = [{ level: 0, width, height, data: Uint8Array.from(data) }];
  const stats = [{ level: 0, width, height, meanAbsError: 0, maxAbsError: 0 }];

  let current = levels[0].data;
  let ideal = decodeLevel(semantic, current, width * height);
  const targetCoverage = shouldPreserveCoverage ? computeCoverage(ideal, alphaCutoff) : 0;

  let levelWidth = width;
  let levelHeight = height;
  let level = 0;
  while (levelWidth > 1 || levelHeight > 1) {
    level++;
    const decoded = decodeLevel(semantic, current, levelWidth * levelHeight);
    const nextFloat = downsampleFloat(semantic, decoded, levelWidth, levelHeight);
    const nextIdeal = downsampleFloat(semantic, ideal, levelWidth, levelHeight);
    if (shouldPreserveCoverage) {
      applyCoveragePreservation(nextFloat.data, alphaCutoff, targetCoverage);
      applyCoveragePreservation(nextIdeal.data, alphaCutoff, targetCoverage);
    }
    const nextData = encodeLevel(semantic, nextFloat.data, nextFloat.width * nextFloat.height);

    const decodedActual = decodeLevel(semantic, nextData, nextFloat.width * nextFloat.height);
    let errorSum = 0;
    let errorMax = 0;
    for (let i = 0; i < nextIdeal.data.length; i++) {
      const diff = Math.abs(decodedActual[i] - nextIdeal.data[i]);
      errorSum += diff;
      if (diff > errorMax) errorMax = diff;
    }

    levels.push({ level, width: nextFloat.width, height: nextFloat.height, data: nextData });
    stats.push({
      level,
      width: nextFloat.width,
      height: nextFloat.height,
      meanAbsError: errorSum / nextIdeal.data.length,
      maxAbsError: errorMax,
    });

    current = nextData;
    ideal = nextIdeal.data;
    levelWidth = nextFloat.width;
    levelHeight = nextFloat.height;
  }

  return { levels, stats };
}
