// 合约计算（纯函数）。公式取自原型"合约计算器"页脚（PRD 6.3），仅作前端预估与即时提示，
// 最终以后端 `POST /contract/orders/preview` 与引擎结算为准（api-doc/03-trade.md §2）。
// 所有函数的 qty 都是「币数量」（= 张数 × contract_size）。

export const dirOf = (side) => (side === 'LONG' ? 1 : -1);

/** 按持仓名义价值找档位（tiers 按 position_value_upper 升序） */
export function tierOf(tiers, notional) {
  for (const t of tiers) if (notional <= Number(t.position_value_upper)) return t;
  return tiers[tiers.length - 1];
}

/** 起始保证金 = 数量 × 开仓价 / 杠杆 */
export const initialMargin = (qty, price, lev) => (qty * price) / lev;

/** 未实现盈亏 = (标记价 − 开仓价) × 数量 × 方向 */
export const pnl = (side, qty, entry, price) => (price - entry) * qty * dirOf(side);

/** 破产价（逐仓）：多 = 均价 − 保证金/数量；空 = 均价 + 保证金/数量 */
export const bankruptcyPrice = (side, qty, entry, margin) => entry - (dirOf(side) * margin) / qty;

/**
 * 逐仓强平价
 *   = (保证金 + 速算额 − 方向×数量×均价) / (数量×MMR − 方向×数量) / (1 + 方向×Taker 费率)
 */
export function liqPrice({ side, qty, entry, margin, mmr, cum = 0, takerFee = 0.0005 }) {
  const d = dirOf(side);
  const p = (margin + cum - d * qty * entry) / (qty * mmr - d * qty) / (1 + d * takerFee);
  return Number.isFinite(p) && p > 0 ? p : 0;
}

/** 距强平 = |标记价 − 强平价| / 标记价 */
export const distToLiq = (mark, liq) => (mark > 0 && liq > 0 ? Math.abs(mark - liq) / mark : 1);

/** 风险度：< 3% 危险，< 10% 预警，否则安全（阈值待后端评审，见 api-doc/04） */
export const riskLevel = (dist) => (dist < 0.03 ? 'DANGER' : dist < 0.1 ? 'WARNING' : 'SAFE');

/** 最大可开（币）= 可用 × 杠杆 / 价格，按最小下单量向下取整 */
export function maxOpenQty(available, lev, price, minQty) {
  if (!(price > 0) || !(available > 0)) return 0;
  const raw = (available * lev) / price;
  return Math.floor(raw / minQty + 1e-9) * minQty;
}

/** 收益率 = 收益 / 起始保证金 */
export const roe = (profit, margin) => (margin > 0 ? profit / margin : 0);

/** 目标价 = 开仓价 × (1 + 方向 × 目标收益率 / 杠杆) */
export const targetPrice = (side, entry, rate, lev) => entry * (1 + (dirOf(side) * rate) / lev);

/** 按币数量 / 步长向下取整并去浮点误差 */
export function floorTo(v, step) {
  const n = Math.floor(v / step + 1e-9) * step;
  const dp = String(step).includes('.') ? String(step).split('.')[1].length : 0;
  return Number(n.toFixed(dp));
}

/** 币数量 → 张 */
export const toLots = (coinQty, contractSize) => Math.round(coinQty / contractSize);
/** 张 → 币数量 */
export const toCoin = (lots, contractSize) => lots * contractSize;
