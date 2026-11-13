# mip-chain-pipeline

纯 JavaScript（Node.js，无图片库依赖、无预览）的 RGBA8 纹理 Mip 链生成库。
调用方提供像素、宽高和纹理语义，库逐级生成到 1x1，并按语义处理色彩空间、
法线重归一化与 Alpha 覆盖率。

## 用法

```js
import { generateMipChain, Semantics } from 'mip-chain-pipeline';

const { levels, stats } = generateMipChain({
  data: rgba8,              // Uint8Array（或可转数组），长度 = width * height * 4
  width: 256,
  height: 128,
  semantic: Semantics.SRGB, // 'color' | 'srgb' | 'normal' | 'alpha-coverage'
});

// levels[i] = { level, width, height, data: Uint8Array }，levels[0] 为原图副本
// stats[i]  = { level, width, height, meanAbsError, maxAbsError }
```

可选参数：

- `alphaCutoff`（默认 `0.5`）：覆盖率统计使用的 alpha 阈值。
- `preserveCoverage`（默认仅 `alpha-coverage` 语义开启）：是否做覆盖率保持。

## 各级尺寸与边缘块

- 每级宽高按 `max(1, ceil(n / 2))` 递减，直到 1x1；非 2 次幂尺寸（如 7x5 → 4x3 → 2x2 → 1x1）
  不会丢行丢列。
- 边缘块按**实际覆盖的源像素数**加权：奇数尺寸下最后一列/行的块只覆盖 1 个像素，
  就除以 1，绝不把不存在的像素补黑再平均（否则边缘会整体变暗）。

## 各语义的算法差异

| 语义 | 工作空间 | 平均方式 | 输出处理 |
| --- | --- | --- | --- |
| `color` | 线性 0..1 | 四通道 box 平均 | 直接量化回 8bit |
| `srgb` | sRGB 解码到线性（IEC 61966-2-1） | 线性空间 box 平均（alpha 不做伽马，直接平均） | 转回 sRGB 再量化 |
| `normal` | 解码到 [-1, 1] 向量 | RGB 作为向量平均，alpha 单独平均 | **重新归一化**后编码 |
| `alpha-coverage` | 线性 0..1 | RGB 按 alpha 加权（预乘式）平均，alpha 普通平均 | 可选覆盖率保持 |

### sRGB 为什么必须在线性空间平均

直接在 sRGB 字节值上平均会把黑白棋盘算成 128 的中灰；物理正确的做法是
解码到线性空间平均（得 0.5）再编码回去（约 188）。远 mip 发灰、偏暗通常就是
少了这一步。

### 法线重归一化与零向量

平均会缩短向量（方向相反的法线甚至相互抵消），所以每级结果都重新归一化到
单位长度。当平均向量长度 < `0.01` 时视为退化（8bit 量化残差约 0.006，阈值高于
噪声、低于任何有效合成方向），输出稳定的 `(0, 0, 1)`（即字节 `128,128,255`），
不做除零。

### Alpha 覆盖率

针对树叶等 alpha-test 贴图：

- RGB 按 alpha 加权平均，透明像素的颜色不会把不透明边缘拉黑发灰；
  整块全透明时回退到非加权平均，保留颜色供边缘扩张使用。
- 开启 `preserveCoverage` 后，每级通过二分搜索一个 alpha 缩放系数，
  使 `alpha >= alphaCutoff` 的像素比例与第 0 级一致，避免远 mip 边缘提前消失。

## 误差统计

生成时并行维护一条**不量化**的浮点参考链（与主链同算法、同覆盖率处理）。
`stats` 中每级的 `meanAbsError` / `maxAbsError` 是该级 8bit 结果解码后与浮点
参考的绝对误差（在工作空间单位下：颜色/alpha 为 0..1，法线为 -1..1），
可用于监控量化与逐级累积误差。

## 确定性

全部为定点迭代次数的纯浮点运算，无随机数、无时间依赖；相同输入两次生成的
字节结果与统计完全一致。

## 测试

```sh
node --test
```

覆盖：棋盘格、纯色、渐变、法线半球、零向量回退、透明边缘、非 2 次幂尺寸、
1x1 输入、逐级尺寸、Alpha 覆盖率、法线长度、确定性与每级误差统计。
