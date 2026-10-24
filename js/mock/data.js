// Mock 数据源加载器：读取 mock-data/*.json（来自 ../api-doc/mock，格式见该目录 README）。
// 用顶层 await：其它 mock 模块 import 本文件时，数据一定已就绪。

const MIN = 60000; const HOUR = 3600000; const DAY = 86400000;

async function load(name) {
  const url = new URL(`../../mock-data/${name}`, import.meta.url);
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Mock 数据源加载失败：${name}（${res.status}）。请先运行 scripts/sync-mock.sh`);
  return res.json();
}

export const fixtures = {
  symbols: (await load('symbols.json')).symbols,
  demo: await load('demo-account.json'),
};

const REL = /^([+-])(?:(\d+(?:\.\d+)?)d)?(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?$/;

/** 时间字段：相对时间（-3h / -2d4h30m / +7d，相对「现在」）或 ISO 8601 → 毫秒时间戳；空值返回 null */
export function toMs(v, now = Date.now()) {
  if (v === undefined || v === null || v === '') return null;
  const m = typeof v === 'string' ? REL.exec(v) : null;
  if (m) return now + (m[1] === '-' ? -1 : 1) * ((Number(m[2] || 0) * DAY) + (Number(m[3] || 0) * HOUR) + (Number(m[4] || 0) * MIN));
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}
