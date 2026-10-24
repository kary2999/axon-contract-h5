// ⑭ 合约计算器：收益 / 目标价格 / 强平价格 / 可开数量（纯前端计算，不调用后端；公式见 lib/calc.js）
import { ui } from './_ui.js';
import { go, route } from '../router.js';
import { store, loadSymbols, loadTickers, loadSymbolDetail, refreshAccount, useTickers } from '../store.js';
import { fmt, fmtPct, fmtPrice, symName, symBase, num, pnlClass, decimalsOf } from '../lib/format.js';
import * as C from '../lib/calc.js';
import { getDefaultSymbol } from './_shared.js';

const { ref, reactive, computed, watch, onMounted } = Vue;

const TABS = [{ k: 'pnl', t: '收益' }, { k: 'target', t: '目标价格' }, { k: 'liq', t: '强平价格' }, { k: 'max', t: '可开数量' }];
const LEVS = [1, 25, 50, 75, 100, 125];

export const Calc = {
  components: ui,
  template: `
  <div class="page">
    <AppHeader title="合约计算器" fallback="/me">
      <template #right><button class="chip" @click="symSheet = true">{{ symName(symbol) }} 永续 ▾</button></template>
    </AppHeader>
    <div class="tabs"><button v-for="t in TABS" :key="t.k" :class="{ on: tab === t.k }" @click="tab = t.k">{{ t.t }}</button></div>
    <div class="scroll"><div class="form-page">
      <div class="seg" style="margin-bottom:14px"><button :class="{ on: side === 'LONG' }" @click="side = 'LONG'">做多</button><button :class="{ on: side === 'SHORT' }" @click="side = 'SHORT'">做空</button></div>
      <div class="field" v-if="tab !== 'max' || true">
        <label>杠杆</label>
        <div class="inp"><input v-model="lev" inputmode="numeric" :placeholder="'1 ~ ' + maxLev" @input="lev = lev.replace(/\\D/g, '')"><span class="suf">×</span></div>
        <div class="chips" style="padding:8px 0 0"><button class="chip" v-for="n in levs" :key="n" :class="{ on: num(lev) === n }" @click="lev = String(n)">{{ n }}×</button></div>
      </div>
      <div class="field" v-if="tab === 'max'"><label>可用余额</label><div class="inp"><input v-model="avail" inputmode="decimal"><span class="suf">USDT</span></div></div>
      <div class="field"><label>开仓价格</label><div class="inp"><input v-model="open" inputmode="decimal"><span class="suf">USDT</span></div></div>
      <div class="field" v-if="tab === 'pnl'"><label>平仓价格</label><div class="inp"><input v-model="close" inputmode="decimal"><span class="suf">USDT</span></div></div>
      <div class="field" v-if="tab === 'target'"><label>目标收益率</label><div class="inp"><input v-model="rate" inputmode="decimal"><span class="suf">%</span></div></div>
      <div class="field" v-if="tab !== 'max'"><label>数量</label><div class="inp" :class="{ err: touched && !num(qty) }"><input v-model="qty" inputmode="decimal"><span class="suf">{{ base }}</span></div></div>
      <div class="field" v-if="tab === 'liq'"><label>追加保证金（选填）</label><div class="inp"><input v-model="extra" inputmode="decimal"><span class="suf">USDT</span></div></div>
      <button class="btn primary block" @click="calc">计算</button>

      <div class="calc-res" v-if="touched && err"><span class="err-t" style="margin:0;font-size:12px">{{ err }}</span></div>
      <div class="calc-res" v-else-if="res">
        <small class="mute">计算结果</small>
        <template v-if="tab === 'pnl'">
          <div class="big num" :class="pnlClass(res.profit)">{{ fmt(res.profit, 2, { sign: true }) }} USDT</div>
          <div class="kv"><span>起始保证金</span><b class="num">{{ fmt(res.margin) }} USDT</b></div><div class="kv"><span>收益率</span><b class="num" :class="pnlClass(res.profit)">{{ fmtPct(res.roe, 2, { sign: true }) }}</b></div>
          <div class="kv"><span>预估手续费（Taker 双边）</span><b class="num">{{ fmt(res.fee) }} USDT</b></div><div class="kv"><span>扣费后净收益</span><b class="num" :class="pnlClass(res.net)">{{ fmt(res.net, 2, { sign: true }) }} USDT</b></div>
        </template>
        <template v-else-if="tab === 'target'">
          <div class="big num">{{ fmt(res.target, priceDp) }} USDT</div>
          <div class="kv"><span>需{{ res.move >= 0 ? '上涨' : '下跌' }}</span><b class="num" :class="pnlClass(res.move)">{{ fmtPct(res.move, 2, { sign: true }) }}</b></div><div class="kv"><span>目标收益</span><b class="num up">{{ fmt(res.profit, 2, { sign: true }) }} USDT</b></div><div class="kv"><span>起始保证金</span><b class="num">{{ fmt(res.margin) }} USDT</b></div>
        </template>
        <template v-else-if="tab === 'liq'">
          <div class="big num down">{{ fmt(res.liq, priceDp) }} USDT</div>
          <div class="kv"><span>仓位保证金</span><b class="num">{{ fmt(res.margin) }} USDT</b></div><div class="kv"><span>破产价</span><b class="num">{{ fmt(res.bk, priceDp) }} USDT</b></div>
          <div class="kv"><span>维持保证金率（档位 {{ res.tier.tier }}）</span><b class="num">{{ fmtPct(res.tier.maintenance_margin_rate, 2) }}</b></div><div class="kv"><span>距强平（按开仓价）</span><b class="num">{{ fmtPct(res.dist, 2, { sign: true }) }}</b></div>
        </template>
        <template v-else>
          <div class="big num">{{ res.qty.toFixed(qtyDp) }} {{ base }}</div>
          <div class="kv"><span>合约张数</span><b class="num">{{ res.lots }} 张</b></div><div class="kv"><span>所需起始保证金</span><b class="num">{{ fmt(res.margin) }} USDT</b></div><div class="kv"><span>名义价值</span><b class="num">{{ fmt(res.notional) }} USDT</b></div><div class="kv"><span>所在档位</span><b class="num">档位 {{ res.tier.tier }}（≤ {{ fmt(res.tier.position_value_upper, 0) }}）</b></div>
        </template>
        <div class="note" style="margin-top:10px;line-height:1.7">计算公式（PRD 6.3）<br>{{ formula }}</div>
        <p class="note" style="margin:8px 0 0">计算结果为估算，未计入资金费用；实际以 Axon 合约引擎结算为准。</p>
      </div>
      <p class="note" v-else-if="touched" style="margin-top:12px">参数不完整，无法计算</p>
      <p class="note" v-else style="margin-top:12px">结果仅供参考，切换页签不会清空已填参数</p>
    </div></div>

    <Sheet v-model="symSheet" title="选择合约">
      <div class="row between" v-for="s in store.symbolList" :key="s.symbol" style="padding:12px 0;border-bottom:1px solid var(--line2)" @click="pickSym(s.symbol)"><b :class="{ yellow: s.symbol === symbol }">{{ symName(s.symbol) }} 永续</b><span class="mute">最大 {{ s.max_leverage }}×</span></div>
    </Sheet>
  </div>`,
  setup() {
    const symbol = ref(route.query.symbol || getDefaultSymbol());
    const tab = ref('pnl'); const side = ref('LONG'); const lev = ref('20'); const open = ref(''); const close = ref(''); const qty = ref(''); const rate = ref('50'); const avail = ref(''); const extra = ref('');
    const touched = ref(false); const res = ref(null); const err = ref(''); const symSheet = ref(false);
    const sym = computed(() => store.symbols[symbol.value]);
    const base = computed(() => symBase(symbol.value));
    const priceDp = computed(() => (sym.value ? sym.value.price_scale : 2));
    const qtyDp = computed(() => (sym.value ? sym.value.qty_scale : 3));
    const maxLev = computed(() => (sym.value ? sym.value.max_leverage : 125));
    const levs = computed(() => LEVS.filter((n) => n <= maxLev.value));
    const tiers = computed(() => (sym.value && sym.value.tiers ? sym.value.tiers.map((t) => ({ ...t, position_value_upper: Number(t.position_value_upper) })) : []));
    const formula = computed(() => ({
      pnl: '起始保证金 = 数量 × 开仓价 / 杠杆 · 收益 = (平仓价 − 开仓价) × 数量 × 方向 · 收益率 = 收益 / 起始保证金',
      target: '目标价 = 开仓价 × (1 + 方向 × 目标收益率 / 杠杆)',
      liq: '破产价(多) = 均价 − 仓位保证金 / 数量 · 逐仓强平价 = (仓位保证金 + 速算额 − 方向×数量×均价) / (数量×MMR − 方向×数量) / (1 + 方向×Taker费率)',
      max: '可开数量 = 可用余额 × 杠杆 / 开仓价（按最小下单量向下取整） · 起始保证金 = 数量 × 开仓价 / 杠杆',
    }[tab.value]));

    onMounted(async () => {
      if (!store.symbolList.length) { await loadSymbols(); await loadTickers(); }
      await loadSymbolDetail(symbol.value);
      const t = store.tickers[symbol.value]; if (t) { open.value = t.last_price; close.value = (num(t.last_price) * 1.01).toFixed(priceDp.value); qty.value = String((num(sym.value.contract_size) * 20).toFixed(qtyDp.value)); }
      const a = await refreshAccount(); if (a) avail.value = a.available_balance;
    });
    watch(tab, () => { res.value = null; err.value = ''; touched.value = false; });
    const pickSym = async (s) => { symSheet.value = false; symbol.value = s; res.value = null; await loadSymbolDetail(s); const t = store.tickers[s]; if (t) { open.value = t.last_price; close.value = (num(t.last_price) * 1.01).toFixed(store.symbols[s].price_scale); qty.value = (num(store.symbols[s].contract_size) * 20).toFixed(store.symbols[s].qty_scale); } };

    const calc = () => {
      touched.value = true; err.value = ''; res.value = null;
      const L = num(lev.value); const o = num(open.value); const q = num(qty.value);
      if (!sym.value || !tiers.value.length) { err.value = '合约参数加载中，请稍后再试'; return; }
      if (!(L >= 1) || !(o > 0)) return;
      if (L > maxLev.value) { err.value = `该合约最大杠杆 ${maxLev.value}×`; return; }
      const csz = num(sym.value.contract_size); const taker = num(sym.value.taker_fee_rate);
      const checkTier = (notional) => { const t = C.tierOf(tiers.value, notional); if (L > t.max_leverage) { err.value = `名义价值 ${fmt(notional, 0)} USDT 处于档位 ${t.tier}，最大杠杆 ${t.max_leverage}×，请调低杠杆或数量`; return null; } return t; };
      if (tab.value === 'pnl') {
        const c = num(close.value); if (!(q > 0) || !(c > 0)) return;
        if (!checkTier(q * o)) return;
        const margin = C.initialMargin(q, o, L); const profit = C.pnl(side.value, q, o, c); const fee = q * (o + c) * taker;
        res.value = { profit, margin, roe: C.roe(profit, margin), fee, net: profit - fee };
      } else if (tab.value === 'target') {
        const r = num(rate.value) / 100; if (!(q > 0) || !(r > 0)) return;
        if (!checkTier(q * o)) return;
        const margin = C.initialMargin(q, o, L); const target = C.targetPrice(side.value, o, r, L);
        res.value = { target, move: (target - o) / o, profit: margin * r, margin };
      } else if (tab.value === 'liq') {
        if (!(q > 0)) return;
        const t = checkTier(q * o); if (!t) return;
        const margin = C.initialMargin(q, o, L) + (num(extra.value) || 0);
        const liq = C.liqPrice({ side: side.value, qty: q, entry: o, margin, mmr: num(t.maintenance_margin_rate), cum: num(t.maintenance_amount), takerFee: taker });
        res.value = { liq, margin, bk: C.bankruptcyPrice(side.value, q, o, margin), tier: t, dist: (liq - o) / o };
      } else {
        const a = num(avail.value); if (!(a > 0)) return;
        const maxQ = C.maxOpenQty(a, L, o, csz); if (!(maxQ > 0)) { err.value = '可用余额不足以开出最小下单量'; return; }
        const t = checkTier(maxQ * o); if (!t) return;
        res.value = { qty: maxQ, lots: Math.round(maxQ / csz), margin: C.initialMargin(maxQ, o, L), notional: maxQ * o, tier: t };
      }
    };
    return { TABS, symbol, tab, side, lev, open, close, qty, rate, avail, extra, touched, res, err, symSheet, sym, base, priceDp, qtyDp, maxLev, levs, formula, store, pickSym, calc, symName, fmt, fmtPct, num, pnlClass };
  },
};
