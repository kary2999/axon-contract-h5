// 展示格式化。接口里的金额 / 价格 / 数量都是字符串，这里只负责「显示」，不做业务计算。

export const num = (v) => (v === undefined || v === null || v === '' ? NaN : Number(v));

/** BTC-USDT-PERP → BTCUSDT */
export const symName = (s) => (s || '').replace(/-PERP$/, '').replace('-', '');
export const symBase = (s) => (s || '').split('-')[0];
export const symQuote = (s) => (s || '').split('-')[1] || 'USDT';

/** 步长 / tick 对应的小数位：0.1 → 1，0.00001 → 5，1 → 0 */
export function decimalsOf(step) {
  const s = String(step);
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

const group = (intStr) => intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** 数字格式化：千分位 + 固定小数位；sign=true 时带 +/− */
export function fmt(v, dp = 2, opt = {}) {
  const n = typeof v === 'number' ? v : num(v);
  if (!Number.isFinite(n)) return '--';
  const { sign = false, comma = true } = opt;
  const neg = n < 0 && Number(Math.abs(n).toFixed(dp)) !== 0;
  const s = Math.abs(n).toFixed(dp);
  const [i, d] = s.split('.');
  const body = (comma ? group(i) : i) + (d ? '.' + d : '');
  if (neg) return '-' + body;
  return (sign && n > 0 ? '+' : '') + body;
}

export const fmtSigned = (v, dp = 2) => fmt(v, dp, { sign: true });

/** 比率 → 百分比：0.0231 → 2.31% */
export function fmtPct(v, dp = 2, opt = {}) {
  const n = typeof v === 'number' ? v : num(v);
  if (!Number.isFinite(n)) return '--';
  return fmt(n * 100, dp, opt) + '%';
}

/** 价格：按 tick 的小数位 */
export const fmtPrice = (v, tick = '0.01') => fmt(v, decimalsOf(tick));

/** 大额缩写：2.1B / 980M / 64M */
export function fmtBig(v) {
  const n = num(v);
  if (!Number.isFinite(n)) return '--';
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e10 ? 1 : 2).replace(/\.?0+$/, '') + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e8 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(Math.round(n));
}

const p2 = (n) => String(n).padStart(2, '0');
/** 时间：fmt = 'full' | 'md' | 'hm' | 'hms' */
export function fmtTime(iso, kind = 'full') {
  if (!iso) return '--';
  const d = new Date(iso);
  if (isNaN(d)) return '--';
  const date = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  const md = `${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const hms = `${hm}:${p2(d.getSeconds())}`;
  return { full: `${date} ${hms}`, md: `${md} ${hm}`, hm, hms, date, md_only: md }[kind] || `${date} ${hms}`;
}

/** 倒计时 hh:mm:ss */
export function fmtCountdown(iso, now = Date.now()) {
  const s = Math.max(0, Math.floor((new Date(iso).getTime() - now) / 1000));
  return `${p2(Math.floor(s / 3600))}:${p2(Math.floor((s % 3600) / 60))}:${p2(s % 60)}`;
}

/** 涨跌色 class：涨绿跌红（与原型一致） */
export const pnlClass = (v) => {
  const n = typeof v === 'number' ? v : num(v);
  return n > 0 ? 'up' : n < 0 ? 'down' : '';
};

export const trimOid = (oid) => (oid ? '…' + String(oid).slice(-4).toUpperCase() : '--');

// ---------- 枚举 → 文案（未知值回退为原始值，不报错，见前端规范 §1.3） ----------
const dict = {
  order_type: { LIMIT: '限价', MARKET: '市价', TPSL: '止盈止损', TRAILING: '移动止盈止损', CONDITIONAL: '计划委托', ICEBERG: '冰山委托' },
  order_status: {
    SUBMITTED: '已提交', PENDING_TRIGGER: '等待触发', OPEN: '未成交', PARTIALLY_FILLED: '部分成交', FILLED: '完全成交',
    CANCELED: '已撤销', PARTIALLY_CANCELED: '部分成交已撤', TRIGGER_FAILED: '触发失败', SYSTEM_CANCELED: '系统撤单',
  },
  cancel_reason: { USER: '用户撤单', SYSTEM: '系统撤单', ADMIN: '后台撤单', POSITION_CLOSED: '仓位已平', LIQUIDATION: '强平清理', EXPIRED: '已过期', NO_COUNTERPARTY: '无对手盘' },
  close_type: { MANUAL: '已平仓', TAKE_PROFIT: '止盈触发', STOP_LOSS: '止损触发', LIQUIDATED: '已强平', ADMIN_FORCE: '后台强平', ADL: 'ADL 减仓' },
  risk_level: { SAFE: '安全', WARNING: '预警', DANGER: '危险' },
  ledger_type: {
    GRANT: '体验金发放', CLAIM: '体验金补充', REALIZED_PNL: '已实现盈亏', FEE: '手续费', FUNDING_FEE: '资金费用',
    LIQUIDATION: '强平清算', MARGIN_ADJUST: '保证金调整', ADJUST: '平账调整',
  },
  price_source: { COUNTER_1: '对手价 1', COUNTER_5: '对手价 5', SAME_1: '同向价 1', SAME_5: '同向价 5' },
};
export const label = (kind, v) => (dict[kind] && dict[kind][v]) || v || '--';

/** 开多 / 开空 / 平多 / 平空 */
export const sideText = (o) => (o.position_effect === 'OPEN' ? '开' : '平') + (o.position_side === 'LONG' ? '多' : '空');
export const sideClass = (o) => ((o.position_effect === 'OPEN') === (o.position_side === 'LONG') ? 'up' : 'down');
