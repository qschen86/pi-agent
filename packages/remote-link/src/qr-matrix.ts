/**
 * Zero-dependency ISO/IEC 18004 QR Code generator (Byte mode, ECC Level L, Versions 1..14, up to 458 bytes).
 * Produces a boolean module matrix and crisp inline SVG for Mac pairing screens (scannable by ZXing/iOS/Android).
 */

interface VersionSpec {
  version: number;
  totalCodewords: number;
  ecPerBlock: number;
  blocks: Array<{ count: number; dataCodewords: number }>;
  align: number[];
}

// Level L specifications for Versions 1..14 (ISO/IEC 18004 Table 9 & Annex E)
const VERSIONS_L: VersionSpec[] = [
  { version: 1, totalCodewords: 26, ecPerBlock: 7, blocks: [{ count: 1, dataCodewords: 19 }], align: [] },
  { version: 2, totalCodewords: 44, ecPerBlock: 10, blocks: [{ count: 1, dataCodewords: 34 }], align: [6, 18] },
  { version: 3, totalCodewords: 70, ecPerBlock: 15, blocks: [{ count: 1, dataCodewords: 55 }], align: [6, 22] },
  { version: 4, totalCodewords: 100, ecPerBlock: 20, blocks: [{ count: 1, dataCodewords: 80 }], align: [6, 26] },
  { version: 5, totalCodewords: 134, ecPerBlock: 26, blocks: [{ count: 1, dataCodewords: 108 }], align: [6, 30] },
  { version: 6, totalCodewords: 172, ecPerBlock: 18, blocks: [{ count: 2, dataCodewords: 68 }], align: [6, 34] },
  { version: 7, totalCodewords: 196, ecPerBlock: 20, blocks: [{ count: 2, dataCodewords: 78 }], align: [6, 22, 38] },
  { version: 8, totalCodewords: 242, ecPerBlock: 24, blocks: [{ count: 2, dataCodewords: 97 }], align: [6, 24, 42] },
  { version: 9, totalCodewords: 292, ecPerBlock: 30, blocks: [{ count: 2, dataCodewords: 116 }], align: [6, 26, 46] },
  { version: 10, totalCodewords: 346, ecPerBlock: 18, blocks: [{ count: 2, dataCodewords: 68 }, { count: 2, dataCodewords: 69 }], align: [6, 28, 50] },
  { version: 11, totalCodewords: 404, ecPerBlock: 20, blocks: [{ count: 4, dataCodewords: 81 }], align: [6, 30, 54] },
  { version: 12, totalCodewords: 466, ecPerBlock: 24, blocks: [{ count: 2, dataCodewords: 92 }, { count: 2, dataCodewords: 93 }], align: [6, 32, 58] },
  { version: 13, totalCodewords: 532, ecPerBlock: 26, blocks: [{ count: 4, dataCodewords: 107 }], align: [6, 34, 62] },
  { version: 14, totalCodewords: 581, ecPerBlock: 30, blocks: [{ count: 3, dataCodewords: 115 }, { count: 1, dataCodewords: 116 }], align: [6, 26, 46, 66] },
];

// GF(256) with primitive polynomial 0x11d
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

function rsGeneratorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const factor = GF_EXP[i]!;
    for (let j = 0; j < poly.length; j++) {
      next[j]! ^= poly[j]!;
      next[j + 1]! ^= gfMul(poly[j]!, factor);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = rsGeneratorPoly(ecCount);
  const rem = new Uint8Array(ecCount);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i]! ^ rem[0]!;
    rem.copyWithin(0, 1);
    rem[ecCount - 1] = 0;
    for (let j = 0; j < ecCount; j++) {
      rem[j]! ^= gfMul(gen[j + 1]!, factor);
    }
  }
  return rem;
}

function selectVersion(byteLen: number): VersionSpec {
  for (const spec of VERSIONS_L) {
    const capacity = spec.blocks.reduce((acc, b) => acc + b.count * b.dataCodewords, 0);
    const charCountBits = spec.version <= 9 ? 8 : 16;
    const neededBits = 4 + charCountBits + byteLen * 8;
    if (neededBits <= capacity * 8) return spec;
  }
  throw new Error(`QR payload too large (${byteLen} bytes)`);
}

function encodeDataCodewords(bytes: Uint8Array, spec: VersionSpec): Uint8Array {
  const totalData = spec.blocks.reduce((acc, b) => acc + b.count * b.dataCodewords, 0);
  const bits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  pushBits(0b0100, 4); // Byte mode
  pushBits(bytes.length, spec.version <= 9 ? 8 : 16);
  for (let i = 0; i < bytes.length; i++) pushBits(bytes[i]!, 8);
  const maxBits = totalData * 8;
  const term = Math.min(4, maxBits - bits.length);
  for (let i = 0; i < term; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = new Uint8Array(totalData);
  let byteIdx = 0;
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let b = 0; b < 8; b++) v = (v << 1) | bits[i + b]!;
    codewords[byteIdx++] = v;
  }
  let padToggle = 0;
  while (byteIdx < totalData) {
    codewords[byteIdx++] = padToggle === 0 ? 0xec : 0x11;
    padToggle ^= 1;
  }
  return codewords;
}

function interleaveBlocks(data: Uint8Array, spec: VersionSpec): Uint8Array {
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (const group of spec.blocks) {
    for (let i = 0; i < group.count; i++) {
      const slice = data.subarray(offset, offset + group.dataCodewords);
      offset += group.dataCodewords;
      dataBlocks.push(slice);
      ecBlocks.push(rsRemainder(slice, spec.ecPerBlock));
    }
  }
  const maxDataLen = Math.max(...dataBlocks.map((b) => b.length));
  const out = new Uint8Array(spec.totalCodewords);
  let pos = 0;
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of dataBlocks) {
      if (i < block.length) out[pos++] = block[i]!;
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const ec of ecBlocks) out[pos++] = ec[i]!;
  }
  return out;
}

function buildFunctionModules(size: number, spec: VersionSpec): { modules: Uint8Array; isFunc: Uint8Array } {
  const modules = new Uint8Array(size * size);
  const isFunc = new Uint8Array(size * size);
  const setFunc = (r: number, c: number, dark: boolean) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    modules[r * size + c] = dark ? 1 : 0;
    isFunc[r * size + c] = 1;
  };

  // Finder patterns + separators
  const drawFinder = (top: number, left: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = top + dr;
        const c = left + dc;
        if (r < 0 || c < 0 || r >= size || c >= size) continue;
        const dist = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
        setFunc(r, c, dist !== 2 && dist !== 4);
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    setFunc(6, i, i % 2 === 0);
    setFunc(i, 6, i % 2 === 0);
  }

  // Alignment patterns
  const centers = spec.align;
  for (let i = 0; i < centers.length; i++) {
    for (let j = 0; j < centers.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === centers.length - 1) || (i === centers.length - 1 && j === 0)) {
        continue;
      }
      const cr = centers[i]!;
      const cc = centers[j]!;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          setFunc(cr + dr, cc + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  // Reserve format info areas + dark module
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      setFunc(8, i, false);
      setFunc(i, 8, false);
    }
  }
  for (let i = size - 8; i < size; i++) {
    setFunc(8, i, false);
    setFunc(i, 8, false);
  }
  setFunc(size - 8, 8, true); // dark module

  // Version info for version >= 7
  if (spec.version >= 7) {
    let rem = spec.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (spec.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunc(a, b, dark);
      setFunc(b, a, dark);
    }
  }

  return { modules, isFunc };
}

function writeFormatBits(modules: Uint8Array, size: number, mask: number): void {
  // ECC Level L format indicator = 01
  const data = (0b01 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;

  const bit = (i: number) => ((bits >>> i) & 1);
  for (let i = 0; i <= 5; i++) modules[8 * size + i] = bit(14 - i);
  modules[8 * size + 7] = bit(8);
  modules[8 * size + 8] = bit(7);
  modules[7 * size + 8] = bit(6);
  for (let i = 0; i <= 5; i++) modules[(5 - i) * size + 8] = bit(5 - i);

  for (let i = 0; i <= 7; i++) modules[8 * size + (size - 1 - i)] = bit(i);
  for (let i = 0; i <= 6; i++) modules[(size - 7 + i) * size + 8] = bit(14 - i);
}

function placeDataBits(modules: Uint8Array, isFunc: Uint8Array, size: number, codewords: Uint8Array): void {
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        if (isFunc[r * size + c]) continue;
        let dark = 0;
        if (bitIndex < totalBits) {
          dark = (codewords[bitIndex >>> 3]! >>> (7 - (bitIndex & 7))) & 1;
          bitIndex++;
        }
        modules[r * size + c] = dark;
      }
    }
    upward = !upward;
  }
}

function applyMask(base: Uint8Array, isFunc: Uint8Array, size: number, mask: number): Uint8Array {
  const out = new Uint8Array(base);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (isFunc[r * size + c]) continue;
      let invert = false;
      switch (mask) {
        case 0: invert = (r + c) % 2 === 0; break;
        case 1: invert = r % 2 === 0; break;
        case 2: invert = c % 3 === 0; break;
        case 3: invert = (r + c) % 3 === 0; break;
        case 4: invert = (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; break;
        case 5: invert = ((r * c) % 2) + ((r * c) % 3) === 0; break;
        case 6: invert = (((r * c) % 2) + ((r * c) % 3)) % 2 === 0; break;
        case 7: invert = (((r + c) % 2) + ((r * c) % 3)) % 2 === 0; break;
      }
      if (invert) out[r * size + c] ^= 1;
    }
  }
  writeFormatBits(out, size, mask);
  return out;
}

function penaltyScore(m: Uint8Array, size: number): number {
  let score = 0;
  // Rule 1: adjacent modules in row/col
  for (let r = 0; r < size; r++) {
    let runColor = m[r * size]!;
    let runLen = 1;
    for (let c = 1; c < size; c++) {
      const v = m[r * size + c]!;
      if (v === runColor) {
        runLen++;
        if (runLen === 5) score += 3;
        else if (runLen > 5) score += 1;
      } else {
        runColor = v;
        runLen = 1;
      }
    }
  }
  for (let c = 0; c < size; c++) {
    let runColor = m[c]!;
    let runLen = 1;
    for (let r = 1; r < size; r++) {
      const v = m[r * size + c]!;
      if (v === runColor) {
        runLen++;
        if (runLen === 5) score += 3;
        else if (runLen > 5) score += 1;
      } else {
        runColor = v;
        runLen = 1;
      }
    }
  }
  // Rule 2: 2x2 blocks
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r * size + c]!;
      if (v === m[r * size + c + 1] && v === m[(r + 1) * size + c] && v === m[(r + 1) * size + c + 1]) {
        score += 3;
      }
    }
  }
  return score;
}

export interface QrMatrix {
  size: number;
  version: number;
  modules: Uint8Array;
}

export function generateQrMatrix(text: string): QrMatrix {
  const bytes = Buffer.from(text, "utf8");
  const spec = selectVersion(bytes.length);
  const size = spec.version * 4 + 17;
  const data = encodeDataCodewords(bytes, spec);
  const codewords = interleaveBlocks(data, spec);
  const { modules, isFunc } = buildFunctionModules(size, spec);
  placeDataBits(modules, isFunc, size, codewords);

  let bestMask = 0;
  let bestScore = Infinity;
  let bestModules = modules;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = applyMask(modules, isFunc, size, mask);
    const score = penaltyScore(candidate, size);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
      bestModules = candidate;
    }
  }
  void bestMask;
  return { size, version: spec.version, modules: bestModules };
}

export function renderQrSvg(text: string, quietZone = 4): string {
  const { size, modules } = generateQrMatrix(text);
  const full = size + quietZone * 2;
  const parts: string[] = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r * size + c]) {
        parts.push(`M${c + quietZone},${r + quietZone}h1v1h-1z`);
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${full} ${full}" shape-rendering="crispEdges" role="img" aria-label="配对二维码"><rect width="${full}" height="${full}" fill="#ffffff"/><path d="${parts.join("")}" fill="#111111"/></svg>`;
}
