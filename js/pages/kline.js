// ② 行情详情：K 线 + 盘口 / 最新成交 / 合约信息（三个路由共用一个页面壳）
import { ui } from './_ui.js';
import { go, route } from '../router.js';
import * as api from '../api/index.js';
import { ws } from '../api/ws.js';
import { store, loadSymbols, loadTickers, loadSymbolDetail, toast, coinQty } from '../store.js';
import { fmt, fmtPct, fmtPrice, fmtBig, fmtCountdown, fmtTime, symName, symBase, num, pnlClass } from '../lib/format.js';
import { setDefaultSymbol } from './_shared.js';

const { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } = Vue;

const PERIODS = [
  { k: 'line', t: '分时', iv: '1m' }, { k: '15m', t: '15分', iv: '15m' }, { k: '1h', t: '1小时', iv: '1h' }, { k: '4h', t: '4小时', iv: '4h' }, { k: '1d', t: '1日', iv: '1d' },
];
const MORE = [{ k: '1m', t: '1分钟', iv: '1m' }, { k: '5m', t: '5分钟', iv: '5m' }, { k: '30m', t: '30分钟', iv: '30m' }];

function makePage(initialTab) {
  return {
    components: ui,
    template: `
    <div class="page">
      <AppHeader :fallback="'/markets'">
        <template #title><span class="row gap8">{{ symName(symbol) }} <span class="pill">永续</span></span></template>
        <template #right>
          <button class="icon-btn" aria-label="自选" @click="toggleFav" :style="sym && sym.is_favorite ? 'color:var(--yellow)' : ''"><Icon :name="sym && sym.is_favorite ? 'starOn' : 'star'"/></button>
          <button class="icon-btn" aria-label="计算器" @click="go('/calc')"><Icon name="calc"/></button>
        </template>
      </AppHeader>
      <div class="scroll">
        <div class="pad row between" style="align-items:flex-end">
          <div><div class="num" :class="chgCls" style="font-size:28px;font-weight:800">{{ t ? fmtPrice(t.last_price, tick) : '--' }}</div>
            <small class="num" :class="chgCls" v-if="t">{{ fmt(t.price_change, priceDp, { sign: true }) }} {{ fmtPct(t.price_change_rate, 2, { sign: true }) }}</small></div>
          <div class="note num" style="text-align:right;line-height:1.7" v-if="t">标记价 <b class="sub">{{ fmtPrice(t.mark_price, tick) }}</b><br>指数价 <b class="sub">{{ fmtPrice(t.index_price, tick) }}</b></div>
        </div>
        <div class="stat8 num" v-if="t">
          <div><small>24h 最高</small>{{ fmtPrice(t.high_24h, tick) }}</div><div><small>24h 最低</small>{{ fmtPrice(t.low_24h, tick) }}</div><div><small>资金费率</small>{{ fmtPct(t.funding_rate, 4) }}</div>
          <div><small>24h 量({{ base }})</small>{{ fmtBig(t.volume_24h) }}</div><div><small>24h 额(USDT)</small>{{ fmtBig(t.turnover_24h) }}</div><div><small>距结算</small>{{ countdown }}</div>
        </div>

        <div class="periods">
          <button v-for="p in PERIODS" :key="p.k" :class="{ on: period === p.k }" @click="setPeriod(p.k)">{{ p.t }}</button>
          <button :class="{ on: MORE.some(m => m.k === period) }" @click="moreSheet = true">{{ MORE.find(m => m.k === period) ? MORE.find(m => m.k === period).t : '更多' }} ▾</button>
          <span class="grow"></span>
          <button :class="{ on: kind === 'LAST' }" @click="setKind('LAST')">最新价</button><button :class="{ on: kind === 'MARK' }" @click="setKind('MARK')">标记价</button>
        </div>
        <div class="kl-wrap" style="height:300px;flex:none">
          <div id="kline-chart"></div>
          <div class="loading" v-if="chartState === 'loading'" style="position:absolute;inset:0;background:rgba(11,14,17,.6)"><span class="spin"></span>K 线加载中…</div>
          <div class="empty" v-if="chartState === 'error'" style="position:absolute;inset:0;background:var(--bg)"><div class="ei">!</div><b>K 线加载失败</b><button class="btn sm primary" @click="loadChart">重试</button></div>
        </div>
        <p class="note pad" style="margin:4px 0 0" v-if="myPos">图上标注了你的开仓价与强平价，持仓时随 K 线一起显示。</p>

        <div class="sub-tabs">
          <button :class="{ on: tab === 'depth' }" @click="switchTab('depth')">盘口</button>
          <button :class="{ on: tab === 'trades' }" @click="switchTab('trades')">最新成交</button>
          <button :class="{ on: tab === 'info' }" @click="switchTab('info')">合约信息</button>
        </div>

        <!-- 盘口 -->
        <template v-if="tab === 'depth'">
          <div class="ratio" v-if="depth"><div class="b" :style="{ width: buyPct + '%' }">买 {{ buyPct }}%</div><div class="a" :style="{ width: (100 - buyPct) + '%' }">{{ 100 - buyPct }}% 卖</div></div>
          <div class="depth-grid" style="color:var(--mute);font-family:var(--font);font-size:11px;margin-bottom:2px"><span>数量({{ base }}) 买盘</span><span style="text-align:right">卖盘 数量({{ base }})</span></div>
          <div class="depth-grid" v-if="depth">
            <div><div class="cl b" v-for="(r, i) in bidRows" :key="'b' + i"><i :style="{ width: r.w + '%' }"></i><span>{{ r.q }}</span><span class="up">{{ fmtPrice(r.price, tick) }}</span></div></div>
            <div><div class="cl a" v-for="(r, i) in askRows" :key="'a' + i"><i :style="{ width: r.w + '%' }"></i><span class="down">{{ fmtPrice(r.price, tick) }}</span><span>{{ r.q }}</span></div></div>
          </div>
          <div class="loading" v-else><span class="spin"></span>盘口加载中…</div>
        </template>
        <!-- 最新成交 -->
        <template v-else-if="tab === 'trades'">
          <p class="note pad" style="margin:0 0 6px">与实盘同一成交流</p>
          <div class="trade-row mute" style="font-family:var(--font);font-size:11px"><span>时间</span><span>价格(USDT)</span><span>数量({{ base }})</span></div>
          <div class="trade-row" v-for="(r, i) in trades" :key="r.trade_time + i"><span class="mute">{{ fmtTime(r.trade_time, 'hms') }}</span><span :class="r.side === 'BUY' ? 'up' : 'down'">{{ fmtPrice(r.price, tick) }}</span><span>{{ r.quantity }}</span></div>
          <div class="loading" v-if="!trades.length"><span class="spin"></span>加载中…</div>
        </template>
        <!-- 合约信息 -->
        <template v-else>
          <div class="pad" v-if="sym && sym.tiers">
            <div class="card" style="margin-bottom:10px">
              <div class="row between"><b>资金费率</b><span class="note">每 {{ sym.funding_interval_hours }} 小时结算</span></div>
              <div class="grid3" style="margin-top:8px"><div class="cell"><small>当期</small><span class="num">{{ t ? fmtPct(t.funding_rate, 4) : '--' }}</span></div><div class="cell"><small>预测下期</small><span class="num">{{ t ? fmtPct(t.predicted_funding_rate, 4) : '--' }}</span></div><div class="cell"><small>距结算</small><span class="num">{{ countdown }}</span></div></div>
              <p class="note" style="margin:8px 0 0">Demo 账户仅展示资金费率，不扣收资金费用</p>
            </div>
            <div class="card" style="margin-bottom:10px">
              <div class="kv"><span>合约类型</span><b>USDT 本位永续</b></div>
              <div class="kv"><span>单张合约价值</span><b class="num">{{ sym.contract_size }} {{ base }}</b></div>
              <div class="kv"><span>最小下单量</span><b class="num">{{ (num(sym.min_qty) * num(sym.contract_size)).toFixed(sym.qty_scale) }} {{ base }}</b></div>
              <div class="kv"><span>价格精度</span><b class="num">{{ sym.price_tick }} USDT</b></div>
              <div class="kv"><span>最大杠杆</span><b class="num">{{ sym.max_leverage }}×</b></div>
              <div class="kv"><span>保证金模式</span><b>仅逐仓</b></div>
              <div class="kv"><span>手续费率 Maker / Taker</span><b class="num">{{ fmtPct(sym.maker_fee_rate, 2) }} / {{ fmtPct(sym.taker_fee_rate, 2) }}</b></div>
              <div class="kv"><span>标记价格来源</span><b>{{ sym.mark_price_source }}</b></div>
            </div>
            <div class="card">
              <div class="row between"><b>维持保证金率阶梯</b><span class="note">复用 Axon 真实分档</span></div>
              <table style="width:100%;border-collapse:collapse;margin-top:8px;font-size:12px" class="num">
                <tr class="mute" style="text-align:right"><th style="text-align:left;font-weight:400;padding:4px 0">持仓价值上限</th><th style="font-weight:400">最大杠杆</th><th style="font-weight:400">维持保证金率</th><th style="font-weight:400">速算额</th></tr>
                <tr v-for="r in sym.tiers" :key="r.tier" style="text-align:right;border-top:1px solid var(--line2)"><td style="text-align:left;padding:7px 0">{{ fmt(r.position_value_upper, 0) }}</td><td>{{ r.max_leverage }}×</td><td>{{ fmtPct(r.maintenance_margin_rate, 1) }}</td><td>{{ fmt(r.maintenance_amount, 0) }}</td></tr>
              </table>
              <p class="note" style="margin:8px 0 0">速算额 = 前级上限 ×（本级 − 前级维持保证金率）+ 前级速算额。仓位越大，维持保证金率越高，强平价越靠近开仓价。</p>
            </div>
            <button class="btn ghost block" style="margin:12px 0" @click="go('/calc')">打开合约计算器</button>
          </div>
          <div class="loading" v-else><span class="spin"></span>加载中…</div>
        </template>
        <div style="height:12px"></div>
      </div>
      <div class="bottom-cta"><button class="btn up" @click="trade('LONG')">开多</button><button class="btn down" @click="trade('SHORT')">开空</button></div>

      <Sheet v-model="moreSheet" title="更多周期">
        <div class="grid3"><button class="chip" v-for="m in MORE" :key="m.k" :class="{ on: period === m.k }" style="justify-content:center;height:36px" @click="setPeriod(m.k); moreSheet = false">{{ m.t }}</button></div>
      </Sheet>
    </div>`,

    setup() {
      const symbol = ref(route.params.symbol);
      setDefaultSymbol(symbol.value);
      const tab = ref(initialTab);
      const period = ref('15m'); const kind = ref('LAST'); const moreSheet = ref(false); const chartState = ref('loading');
      const depth = ref(null); const trades = ref([]); const myPos = ref(null);
      const now = ref(Date.now());

      const sym = computed(() => store.symbols[symbol.value]);
      const t = computed(() => store.tickers[symbol.value]);
      const base = computed(() => symBase(symbol.value));
      const tick = computed(() => (sym.value ? sym.value.price_tick : '0.01'));
      const priceDp = computed(() => (sym.value ? sym.value.price_scale : 2));
      const chgCls = computed(() => (t.value ? (num(t.value.price_change_rate) >= 0 ? 'up' : 'down') : ''));
      const countdown = computed(() => (t.value ? fmtCountdown(t.value.next_funding_time, now.value) : '--:--:--'));
      const ivOf = (k) => (PERIODS.concat(MORE).find((p) => p.k === k) || {}).iv || '15m';

      const rows = (arr) => { const list = arr.slice(0, 12).map((x) => ({ price: x.price, qty: num(x.quantity) })); const max = Math.max(...list.map((r) => r.qty), 1e-9); return list.map((r) => ({ price: r.price, q: r.qty.toFixed(sym.value ? sym.value.qty_scale : 3), w: Math.round((r.qty / max) * 100) })); };
      const bidRows = computed(() => (depth.value ? rows(depth.value.bids) : []));
      const askRows = computed(() => (depth.value ? rows(depth.value.asks) : []));
      const buyPct = computed(() => { if (!depth.value) return 50; const s = (a) => a.reduce((x, r) => x + num(r.quantity), 0); const b = s(depth.value.bids); const a = s(depth.value.asks); return Math.round((b / (a + b)) * 100); });

      // ---------- 图表 ----------
      let chart = null; let offKline = null; let pollTimer = null; let lines = [];
      const toBar = (b) => ({ timestamp: Date.parse(b.open_time), open: num(b.open), high: num(b.high), low: num(b.low), close: num(b.close), volume: num(b.volume) });
      const initChart = () => {
        const el = document.getElementById('kline-chart');
        if (!el || !window.klinecharts) return;
        chart = window.klinecharts.init(el);
        chart.setStyles({
          grid: { horizontal: { color: '#1E2026' }, vertical: { show: false } },
          candle: { bar: { upColor: '#0ECB81', downColor: '#F6465D', noChangeColor: '#848E9C', upBorderColor: '#0ECB81', downBorderColor: '#F6465D', upWickColor: '#0ECB81', downWickColor: '#F6465D' },
            area: { lineColor: '#F0B90B', backgroundColor: [{ offset: 0, color: 'rgba(240,185,11,0.25)' }, { offset: 1, color: 'rgba(240,185,11,0.01)' }] },
            priceMark: { last: { upColor: '#0ECB81', downColor: '#F6465D' } }, tooltip: { showRule: 'follow_cross', text: { color: '#848E9C', size: 10 } } },
          xAxis: { axisLine: { color: '#2B3139' }, tickText: { color: '#848E9C' }, tickLine: { color: '#2B3139' } },
          yAxis: { axisLine: { color: '#2B3139' }, tickText: { color: '#848E9C' }, tickLine: { color: '#2B3139' } },
          separator: { color: '#2B3139' },
          crosshair: { horizontal: { line: { color: '#5E6673' }, text: { backgroundColor: '#2B3139' } }, vertical: { line: { color: '#5E6673' }, text: { backgroundColor: '#2B3139' } } },
          indicator: { tooltip: { text: { color: '#848E9C', size: 10 } } },
        });
        chart.setPriceVolumePrecision(priceDp.value || 2, 3);
        try { chart.createIndicator('MA', false, { id: 'candle_pane' }); chart.createIndicator('VOL', false, { height: 60 }); } catch (e) { /* 指标可选 */ }
      };
      const drawLines = () => {
        if (!chart) return;
        lines.forEach((id) => { try { chart.removeOverlay(id); } catch (e) { /* 忽略 */ } }); lines = [];
        if (!myPos.value || !chart.getDataList().length) return;
        const ts = chart.getDataList()[chart.getDataList().length - 1].timestamp;
        const add = (value, color) => { try { const id = chart.createOverlay({ name: 'priceLine', points: [{ timestamp: ts, value }], lock: true, styles: { line: { color, style: 'dashed', dashedValue: [4, 4] }, text: { color } } }); if (id) lines.push(id); } catch (e) { /* 忽略 */ } };
        add(num(myPos.value.avg_price), '#F0B90B');
        add(num(myPos.value.liquidation_price), '#F6465D');
      };
      const loadChart = async () => {
        chartState.value = 'loading';
        try {
          const r = await api.market.klines({ symbol: symbol.value, interval: ivOf(period.value), kind: kind.value, limit: 300 });
          if (!chart) initChart();
          if (!chart) { chartState.value = 'error'; return; }
          chart.setStyles({ candle: { type: period.value === 'line' ? 'area' : 'candle_solid' } });
          chart.applyNewData(r.list.map(toBar));
          chartState.value = 'ok';
          drawLines();
          subKline();
        } catch (e) { chartState.value = 'error'; }
      };
      const subKline = () => {
        if (offKline) offKline(); offKline = null; clearInterval(pollTimer);
        if (kind.value === 'LAST') {
          offKline = ws.subscribe(`kline.${symbol.value}.${ivOf(period.value)}`, (m) => { if (chart) chart.updateData(toBar(m.data)); });
        } else {
          // 标记价 K 线：Mock 不推 kline_mark，这里用轮询兜底
          pollTimer = setInterval(async () => { try { const r = await api.market.klines({ symbol: symbol.value, interval: ivOf(period.value), kind: 'MARK', limit: 2 }); r.list.forEach((b) => chart && chart.updateData(toBar(b))); } catch (e) { /* 忽略 */ } }, 5000);
        }
      };
      const setPeriod = (k) => { period.value = k; loadChart(); };
      const setKind = (k) => { kind.value = k; loadChart(); };

      // ---------- 其他 ----------
      let offs = [];
      const loadTab = async () => {
        if (tab.value === 'trades') { try { trades.value = (await api.market.trades(symbol.value)).list.slice(0, 20); } catch (e) { /* 忽略 */ } }
        if (tab.value === 'info') loadSymbolDetail(symbol.value);
        if (tab.value === 'depth') { try { depth.value = await api.market.depth(symbol.value); } catch (e) { /* 忽略 */ } }
      };
      const switchTab = (k) => { tab.value = k; loadTab(); };
      const loadMyPos = async () => { try { const r = await api.position.list({ filters: { position_status: 'OPEN', symbol: [symbol.value] } }); myPos.value = r.list[0] || null; drawLines(); } catch (e) { /* 未登录等 */ } };
      const toggleFav = async () => {
        const next = !(sym.value && sym.value.is_favorite);
        try { await api.market.setFavorite(symbol.value, next); store.symbols[symbol.value].is_favorite = next; toast(next ? '已加入自选' : '已取消自选', 'ok'); } catch (e) { toast(e.msg, 'err'); }
      };
      const trade = (side) => { go('/trade/' + symbol.value); };

      onMounted(async () => {
        if (!store.symbolList.length) { await loadSymbols(); await loadTickers(); }
        loadSymbolDetail(symbol.value);
        await nextTick();
        initChart(); loadChart(); loadMyPos(); loadTab();
        offs.push(ws.subscribe(`ticker.${symbol.value}`, (m) => { store.tickers[symbol.value] = m.data; }));
        offs.push(ws.subscribe(`depth.${symbol.value}`, (m) => { if (tab.value === 'depth') depth.value = m.data; }));
        offs.push(ws.subscribe(`trade.${symbol.value}`, (m) => { if (tab.value === 'trades') { trades.value.unshift(m.data); trades.value.length = Math.min(trades.value.length, 20); } }));
      });
      const clock = setInterval(() => { now.value = Date.now(); }, 1000);
      onBeforeUnmount(() => { offs.forEach((f) => f()); if (offKline) offKline(); clearInterval(pollTimer); clearInterval(clock); if (window.klinecharts) { try { window.klinecharts.dispose('kline-chart'); } catch (e) { /* 忽略 */ } } });
      watch(() => store.rev.positions, loadMyPos);

      return { symbol, tab, period, kind, moreSheet, chartState, depth, trades, myPos, sym, t, base, tick, priceDp, chgCls, countdown, bidRows, askRows, buyPct, PERIODS, MORE, setPeriod, setKind, loadChart, switchTab, toggleFav, trade, go, symName, fmt, fmtPct, fmtPrice, fmtBig, fmtTime, num };
    },
  };
}

export const Kline = makePage('depth');
export const Depth = makePage('depth');
export const ContractInfo = makePage('info');
