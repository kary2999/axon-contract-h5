// ⑪ 持仓与强平：筛选 / 平仓（市价·限价）/ 一键全平 / 调整保证金 / 止盈止损 / 强平详情
import { ui } from './_ui.js';
import { PosTabs, FilterBar } from './_tabs.js';
import { go, route } from '../router.js';
import * as api from '../api/index.js';
import { newIdemKey } from '../api/client.js';
import { store, loadSymbols, loadTickers, loadSymbolDetail, useTickers, refreshAccount, livePosition, toast, coinQty, csizeOf } from '../store.js';
import { fmt, fmtPct, fmtPrice, fmtTime, symName, symBase, num, pnlClass, label, decimalsOf } from '../lib/format.js';
import * as C from '../lib/calc.js';
import { getDefaultSymbol } from './_shared.js';

const { ref, reactive, computed, watch, onMounted, onBeforeUnmount } = Vue;

const SORTS = [
  { k: 'dist', t: '距强平（近 → 远）', by: 'distance_to_liq_rate', order: 'asc' },
  { k: 'pnl_desc', t: '未实现盈亏（高 → 低）', by: 'unrealized_pnl_amount', order: 'desc' },
  { k: 'pnl_asc', t: '未实现盈亏（低 → 高）', by: 'unrealized_pnl_amount', order: 'asc' },
  { k: 'time', t: '开仓时间（新 → 旧）', by: 'opened_time', order: 'desc' },
];
const RISK_TEXT = { SAFE: '安全', WARNING: '预警', DANGER: '危险' };

export const Positions = {
  components: { ...ui, PosTabs, FilterBar },
  template: `
  <div class="page">
    <AppHeader noBack title="持仓">
      <template #right><button class="btn sm ghost" :disabled="!list.length || busyAll" @click="allModal = true">一键全平</button></template>
    </AppHeader>
    <PosTabs active="pos" :posCount="total" :orderCount="orderCount"/>
    <FilterBar :symbolText="symText" :sideText="sideText" extraText="距强平" :hideOthers="hide" @open="filterSheet = true" @toggle-hide="toggleHide"/>
    <div class="scroll">
      <template v-if="state === 'loading'"><div class="item" v-for="n in 2" :key="n"><div class="skel" style="height:150px"></div></div></template>
      <div class="empty" v-else-if="state === 'error'"><div class="ei">!</div><b>加载失败</b><span>持仓暂时无法加载</span><button class="btn sm primary" @click="load">重试</button></div>
      <div class="empty" v-else-if="!list.length && filtered"><div class="ei">⌕</div><b>没有符合条件的持仓</b><button class="btn sm ghost" @click="resetFilter">重置筛选</button></div>
      <div class="empty" v-else-if="!list.length"><div class="ei">▭</div><b>当前没有持仓</b><span>去交易页开一笔仓位吧</span><button class="btn sm primary" @click="go('/trade')">去交易</button></div>
      <template v-else>
        <div class="item" v-for="p in list" :key="p.position_oid">
          <div class="it-h">
            <SideTag :side="p.position_side"/><b>{{ symName(p.symbol) }}</b><span class="pill">逐仓 {{ p.leverage }}×</span>
            <span class="pill warn" v-if="p.has_trailing">移动止盈止损</span><span class="pill yellow" v-else-if="p.tp_trigger_price || p.sl_trigger_price">止盈止损</span>
            <span class="pill" :title="'ADL ' + p.adl_level">ADL <span style="letter-spacing:1px" :class="p.adl_level >= 4 ? 'down' : p.adl_level >= 3 ? 'warn' : 'up'">{{ '▮'.repeat(p.adl_level) }}<span class="dim">{{ '▮'.repeat(5 - p.adl_level) }}</span></span></span>
            <div class="r"><small class="mute" style="display:block">未实现盈亏</small><b class="num" :class="pnlClass(p.unrealized_pnl_amount)">{{ fmt(p.unrealized_pnl_amount, 2, { sign: true }) }}</b> <small class="num" :class="pnlClass(p.unrealized_pnl_amount)">{{ fmtPct(p.unrealized_pnl_rate, 2, { sign: true }) }}</small></div>
          </div>
          <div class="it-g num">
            <div><small>数量({{ symBase(p.symbol) }})</small>{{ coinQty(p.symbol, p.position_qty) }}</div><div><small>开仓均价</small>{{ fmtPrice(p.avg_price, tk(p.symbol)) }}</div><div><small>标记价</small>{{ fmtPrice(p.mark_price, tk(p.symbol)) }}</div>
            <div><small>保证金</small>{{ fmt(p.position_margin_amount) }}</div><div><small>强平价</small><span class="down">{{ fmtPrice(p.liquidation_price, tk(p.symbol)) }}</span></div><div><small>止盈 / 止损</small>{{ p.tp_trigger_price ? fmtPrice(p.tp_trigger_price, tk(p.symbol)) : '--' }} / {{ p.sl_trigger_price ? fmtPrice(p.sl_trigger_price, tk(p.symbol)) : '--' }}</div>
          </div>
          <div class="row between" style="margin-top:8px"><span class="note">风险度 <b :class="'risk-' + p.risk_level">{{ RISK_TEXT[p.risk_level] }}</b> · 距强平 <b class="num" :class="'risk-' + p.risk_level">{{ fmtPct(p.distance_to_liq_rate, 1) }}</b></span></div>
          <div class="bar"><i :style="{ width: Math.min(100, num(p.distance_to_liq_rate) * 100 * 2.5) + '%', background: p.risk_level === 'DANGER' ? 'var(--down)' : p.risk_level === 'WARNING' ? 'var(--warn)' : 'var(--up)' }"></i></div>
          <div class="banner err" v-if="p.liq_state === 2" style="margin:8px 0 0">强平处理中 · 仓位已锁定，暂不可调整或平仓</div>
          <div class="it-f">
            <button class="btn sm" :disabled="p.liq_state === 2" @click="openMargin(p)">调整保证金</button>
            <button class="btn sm" :disabled="p.liq_state === 2" @click="openTpsl(p)">止盈止损</button>
            <button class="btn sm primary" :disabled="p.liq_state === 2" @click="openClose(p)">平仓</button>
          </div>
        </div>
        <div class="more">没有更多了</div>
      </template>
      <div style="height:16px"></div>
    </div>

    <!-- 筛选 -->
    <Sheet v-model="filterSheet" title="筛选持仓">
      <div class="h-sec" style="padding:0 0 6px;font-size:13px">交易对</div>
      <div class="chips" style="padding:0 0 8px;flex-wrap:wrap"><button class="chip" :class="{ on: !fl.symbol }" @click="fl.symbol = ''">全部</button><button class="chip" v-for="s in symOptions" :key="s" :class="{ on: fl.symbol === s }" @click="fl.symbol = s">{{ symName(s) }}</button></div>
      <div class="h-sec" style="padding:8px 0 6px;font-size:13px">方向</div>
      <div class="chips" style="padding:0 0 8px"><button class="chip" :class="{ on: !fl.side }" @click="fl.side = ''">全部</button><button class="chip" :class="{ on: fl.side === 'LONG' }" @click="fl.side = 'LONG'">多仓</button><button class="chip" :class="{ on: fl.side === 'SHORT' }" @click="fl.side = 'SHORT'">空仓</button></div>
      <div class="h-sec" style="padding:8px 0 6px;font-size:13px">排序</div>
      <div class="chips" style="padding:0;flex-wrap:wrap"><button class="chip" v-for="s in SORTS" :key="s.k" :class="{ on: fl.sort === s.k }" @click="fl.sort = s.k">{{ s.t }}</button></div>
      <template #footer><button class="btn grow" @click="resetFilter(); filterSheet = false">重置</button><button class="btn primary grow" @click="applyFilter">确定（{{ previewCount }} 个仓位）</button></template>
    </Sheet>

    <!-- 平仓 -->
    <Sheet v-model="closeSheet" title="平仓">
      <template v-if="cp">
        <p class="note" style="margin:0 0 10px">{{ symName(cp.symbol) }} · {{ cp.position_side === 'LONG' ? '多' : '空' }} · 逐仓 {{ cp.leverage }}×</p>
        <div class="seg" style="margin-bottom:10px"><button :class="{ on: cl.mode === 'MARKET' }" @click="cl.mode = 'MARKET'; cl.err = ''">市价平仓</button><button :class="{ on: cl.mode === 'LIMIT' }" @click="cl.mode = 'LIMIT'; cl.err = ''">限价平仓</button></div>
        <p class="note" v-if="cl.mode === 'MARKET'" style="margin:0 0 10px">以市场最优价立即成交，可能产生滑点</p>
        <div class="field" v-else><label>平仓价格</label><div class="inp" :class="{ err: !!cl.perr }"><input v-model="cl.price" inputmode="decimal" :placeholder="'当前标记价 ' + fmtPrice(cp.mark_price, tk(cp.symbol))" @input="cl.perr = ''"><span class="suf">USDT</span></div><span class="err-t" v-if="cl.perr">{{ cl.perr }}</span></div>
        <div class="field"><label>平仓数量 · 可平 {{ coinQty(cp.symbol, cp.position_qty) }} {{ symBase(cp.symbol) }}</label>
          <div class="inp" :class="{ err: !!cl.err }"><input v-model="cl.qty" inputmode="decimal" @input="cl.pct = 0; cl.err = ''"><span class="suf">{{ symBase(cp.symbol) }}</span></div><span class="err-t" v-if="cl.err">{{ cl.err }}</span></div>
        <div class="pct-row" style="margin-bottom:12px"><button v-for="p in [25, 50, 75, 100]" :key="p" :class="{ on: cl.pct === p }" @click="closePct(p)">{{ p }}%</button></div>
        <div class="kv"><span>预计盈亏</span><b class="num" :class="pnlClass(closePnl)">{{ fmt(closePnl, 2, { sign: true }) }} USDT</b></div>
        <div class="kv"><span>预估手续费</span><b class="num">≈ {{ fmt(closeFee, 2) }} USDT（{{ cl.mode === 'MARKET' ? 'Taker' : 'Maker' }}）</b></div>
      </template>
      <template #footer><button class="btn primary block" :disabled="cl.busy" @click="doClose"><span class="spin" v-if="cl.busy"></span>{{ cl.mode === 'MARKET' ? '确认市价平仓' : '确认限价平仓' }}</button></template>
    </Sheet>

    <!-- 一键全平 -->
    <Modal v-model="allModal" title="确认平掉全部仓位？">
      <p class="note" style="margin:0 0 10px">将以市价平掉以下 {{ list.length }} 个仓位，并同时撤销这些仓位的止盈止损委托。市价成交可能产生滑点。</p>
      <div class="kv" v-for="p in list" :key="p.position_oid"><span><b :class="p.position_side === 'LONG' ? 'up' : 'down'">{{ p.position_side === 'LONG' ? '多' : '空' }}</b> {{ symName(p.symbol) }} <small class="mute">{{ coinQty(p.symbol, p.position_qty) }} {{ symBase(p.symbol) }}</small></span><b class="num" :class="pnlClass(p.unrealized_pnl_amount)">{{ fmt(p.unrealized_pnl_amount, 2, { sign: true }) }}</b></div>
      <div class="kv" style="border-top:1px solid var(--line);margin-top:6px;padding-top:8px"><span>预计合计盈亏</span><b class="num" :class="pnlClass(sumPnl)">{{ fmt(sumPnl, 2, { sign: true }) }} USDT</b></div>
      <template #footer><button class="btn" @click="allModal = false">取消</button><button class="btn down" :disabled="busyAll" @click="doCloseAll"><span class="spin" v-if="busyAll"></span>确认全平</button></template>
    </Modal>

    <!-- 调整保证金 -->
    <Sheet v-model="marginSheet" title="调整保证金">
      <template v-if="mp">
        <p class="note" style="margin:0 0 10px">{{ symName(mp.symbol) }} · {{ mp.position_side === 'LONG' ? '多' : '空' }} · 逐仓 {{ mp.leverage }}×</p>
        <div class="seg" style="margin-bottom:12px"><button :class="{ on: mg.mode === 'ADD' }" @click="setMode('ADD')">增加</button><button :class="{ on: mg.mode === 'REDUCE' }" @click="setMode('REDUCE')">减少</button></div>
        <div class="field"><label>数量</label><div class="inp" :class="{ err: !!mg.err }"><input v-model="mg.amount" inputmode="decimal" placeholder="0.00" @input="mgChange"><span class="suf">USDT</span><button class="link" @click="mgMax">最大</button></div>
          <span class="err-t" v-if="mg.err">{{ mg.err }}</span><span class="tip-t" v-else>{{ mg.mode === 'ADD' ? '最多可增加 ' + fmt(mp.max_add_margin_amount) + ' USDT' : '最多可减少 ' + fmt(mp.max_reduce_margin_amount) + ' USDT' }}</span></div>
        <div class="kv"><span>仓位保证金</span><span class="num"><span class="mute">{{ fmt(mp.position_margin_amount) }} →</span> <b>{{ mg.pv ? fmt(mg.pv.position_margin_amount) : '--' }}</b></span></div>
        <div class="kv"><span>预估强平价</span><span class="num"><span class="mute">{{ fmtPrice(mp.liquidation_price, tk(mp.symbol)) }} →</span> <b>{{ mg.pv ? fmtPrice(mg.pv.liquidation_price, tk(mp.symbol)) : '--' }}</b></span></div>
        <div class="kv"><span>距强平</span><span class="num"><span class="mute">{{ fmtPct(mp.distance_to_liq_rate, 1) }} →</span> <b :class="mg.pv ? 'risk-' + mg.pv.risk_level : ''">{{ mg.pv ? fmtPct(mg.pv.distance_to_liq_rate, 1) : '--' }}</b></span></div>
        <div class="kv"><span>调整后风险度</span><b :class="mg.pv ? 'risk-' + mg.pv.risk_level : ''">{{ mg.pv ? RISK_TEXT[mg.pv.risk_level] : '--' }}</b></div>
        <p class="note" style="margin-top:8px">{{ mg.mode === 'ADD' ? '逐仓模式下，增加保证金只影响这一笔仓位，强平价随之远离标记价。' : '减少保证金会让强平价更靠近标记价；可减少金额 = 仓位保证金 − 维持仓位所需的最低保证金。' }}</p>
      </template>
      <template #footer><button class="btn primary block" :disabled="mg.busy || !num(mg.amount) || !!mg.err" @click="doMargin"><span class="spin" v-if="mg.busy"></span>{{ mg.mode === 'ADD' ? '确认增加' : '确认减少' }}</button></template>
    </Sheet>

    <!-- 止盈止损 -->
    <Sheet v-model="tpslSheet" title="仓位止盈止损">
      <template v-if="tp">
        <div class="seg" style="margin-bottom:10px"><button :class="{ on: ts.tab === 'TPSL' }" @click="ts.tab = 'TPSL'">止盈止损</button><button :class="{ on: ts.tab === 'TRAILING' }" @click="ts.tab = 'TRAILING'">移动止盈止损</button></div>
        <div class="card row between" style="margin-bottom:10px"><div><small class="mute">仓位</small><div><b :class="tp.position_side === 'LONG' ? 'up' : 'down'">{{ tp.position_side === 'LONG' ? '多' : '空' }}</b> <span class="num">{{ coinQty(tp.symbol, tp.position_qty) }} {{ symBase(tp.symbol) }}</span></div></div><div style="text-align:right" class="num"><small class="mute" style="display:block">开仓均价 / 标记价</small>{{ fmtPrice(tp.avg_price, tk(tp.symbol)) }} / {{ fmtPrice(tp.mark_price, tk(tp.symbol)) }}</div></div>
        <template v-if="ts.tab === 'TPSL'">
          <div class="seg" style="margin-bottom:10px"><button :class="{ on: !ts.partial }" @click="ts.partial = false">全部仓位</button><button :class="{ on: ts.partial }" @click="ts.partial = true">部分仓位</button></div>
          <div class="field" v-if="ts.partial"><label>平仓数量</label><div class="inp" :class="{ err: !!ts.errQty }"><input v-model="ts.qty" inputmode="decimal" @input="ts.errQty = ''"><span class="suf">{{ symBase(tp.symbol) }}</span></div><span class="err-t" v-if="ts.errQty">{{ ts.errQty }}</span></div>
          <div class="field"><label>止盈触发价 <small class="mute">标记价触发 · 市价平仓</small></label><div class="inp" :class="{ err: !!ts.errTp }"><input v-model="ts.tp" inputmode="decimal" @input="ts.errTp = ''"><span class="suf">USDT</span></div><span class="err-t" v-if="ts.errTp">{{ ts.errTp }}</span><span class="tip-t" v-else-if="tpPnl !== null">预计盈利 <b class="up">{{ fmt(tpPnl, 2, { sign: true }) }} USDT（{{ fmtPct(tpPnl / num(tp.position_margin_amount), 1, { sign: true }) }}）</b></span></div>
          <div class="field"><label>止损触发价 <small class="mute">标记价触发 · 市价平仓</small></label><div class="inp" :class="{ err: !!ts.errSl }"><input v-model="ts.sl" inputmode="decimal" @input="ts.errSl = ''"><span class="suf">USDT</span></div><span class="err-t" v-if="ts.errSl">{{ ts.errSl }}</span><span class="tip-t" v-else-if="slPnl !== null">预计亏损 <b class="down">{{ fmt(slPnl, 2, { sign: true }) }} USDT（{{ fmtPct(slPnl / num(tp.position_margin_amount), 1, { sign: true }) }}）</b></span></div>
          <span class="warn-t" v-if="ts.warn">{{ ts.warn }}</span>
          <p class="note">{{ ts.partial ? '部分仓位：只平掉设定数量，剩余仓位继续持有；同一仓位可设置多组部分止盈止损，合计不超过持仓数量。' : '全部仓位：触发时平掉整个仓位，仓位加仓或减仓后数量自动跟随。' }}止盈与止损互斥，一个触发另一个自动失效。</p>
        </template>
        <template v-else>
          <div class="seg" style="margin-bottom:10px"><button :class="{ on: ts.trMode === 'RATE' }" @click="ts.trMode = 'RATE'">回撤比例</button><button :class="{ on: ts.trMode === 'VALUE' }" @click="ts.trMode = 'VALUE'">固定价差</button></div>
          <div class="field"><label>激活价（选填，默认立即激活）</label><div class="inp"><input v-model="ts.trAct" inputmode="decimal"><span class="suf">USDT</span></div></div>
          <div class="field"><label>回撤{{ ts.trMode === 'RATE' ? '比例' : '价差' }}</label><div class="inp" :class="{ err: !!ts.errTr }"><input v-model="ts.trCb" inputmode="decimal" :placeholder="ts.trMode === 'RATE' ? '0.1 ~ 10' : '价差'" @input="ts.errTr = ''"><span class="suf">{{ ts.trMode === 'RATE' ? '%' : 'USDT' }}</span></div><span class="err-t" v-if="ts.errTr">{{ ts.errTr }}</span><span class="warn-t" v-else-if="ts.trMode === 'RATE' && num(ts.trCb) > 0 && num(ts.trCb) < 0.1">回撤幅度最小 0.1%，过小会被正常波动频繁触发</span></div>
          <p class="note">激活后以持仓期间最高价（空头为最低价）为锚点，创新高时止损线同步上移；从锚点回撤超过设定幅度即市价平仓。</p>
        </template>
      </template>
      <template #footer><button class="btn primary block" :disabled="ts.busy" @click="doTpsl"><span class="spin" v-if="ts.busy"></span>确认</button></template>
    </Sheet>
  </div>`,

  setup() {
    const state = ref('loading'); const all = ref([]); const total = ref(0); const orderCount = ref(0);
    const fl = reactive({ symbol: '', side: '', sort: 'dist' });
    const applied = reactive({ symbol: '', side: '', sort: 'dist' });
    const hide = ref(false);
    const filterSheet = ref(false); const closeSheet = ref(false); const marginSheet = ref(false); const tpslSheet = ref(false); const allModal = ref(false);
    const busyAll = ref(false);
    const cp = ref(null); const mp = ref(null); const tp = ref(null);
    const cl = reactive({ mode: 'MARKET', qty: '', pct: 100, price: '', err: '', perr: '', busy: false, key: '' });
    const mg = reactive({ mode: 'ADD', amount: '', err: '', pv: null, busy: false, key: '' });
    const ts = reactive({ tab: 'TPSL', partial: false, qty: '', tp: '', sl: '', errTp: '', errSl: '', errQty: '', errTr: '', warn: '', trMode: 'RATE', trAct: '', trCb: '', busy: false });
    const tk = (s) => (store.symbols[s] ? store.symbols[s].price_tick : '0.01');

    const symOptions = computed(() => [...new Set(all.value.map((p) => p.symbol))]);
    const symText = computed(() => (applied.symbol ? symName(applied.symbol) : '全部交易对'));
    const sideText = computed(() => (applied.side === 'LONG' ? '多仓' : applied.side === 'SHORT' ? '空仓' : '全部方向'));
    const filtered = computed(() => !!(applied.symbol || applied.side || hide.value));
    const sortObj = computed(() => SORTS.find((s) => s.k === applied.sort));
    const list = computed(() => {
      let l = all.value.filter((p) => (!applied.symbol || p.symbol === applied.symbol) && (!applied.side || p.position_side === applied.side) && (!hide.value || p.symbol === getDefaultSymbol()));
      const by = sortObj.value;
      const key = { distance_to_liq_rate: (p) => num(p.distance_to_liq_rate), unrealized_pnl_amount: (p) => num(p.unrealized_pnl_amount), opened_time: (p) => new Date(p.opened_time).getTime() }[by.by];
      return [...l].sort((a, b) => (key(a) - key(b)) * (by.order === 'asc' ? 1 : -1));
    });
    const previewCount = computed(() => all.value.filter((p) => (!fl.symbol || p.symbol === fl.symbol) && (!fl.side || p.position_side === fl.side)).length);
    const sumPnl = computed(() => list.value.reduce((s, p) => s + num(p.unrealized_pnl_amount), 0));

    const load = async () => {
      if (!all.value.length) state.value = 'loading';
      try {
        const r = await api.position.list({ filters: { position_status: 'OPEN' }, pagination: { page: 1, size: 100 }, sort_by: 'opened_time', order: 'desc' });
        all.value = r.list.map(livePosition); total.value = r.summary.count; orderCount.value = r.summary.order_count; state.value = 'ok';
      } catch (e) { if (!all.value.length) state.value = 'error'; }
    };
    onMounted(async () => { if (!store.symbolList.length) { await loadSymbols(); await loadTickers(); } load(); });
    useTickers(() => store.symbolList.map((s) => s.symbol));
    watch(() => store.rev.positions, load); watch(() => store.rev.orders, load);
    // 行情推送 → 本地重算盈亏 / 距强平
    watch(() => Object.values(store.tickers).map((t) => t.mark_price).join(','), () => { all.value = all.value.map(livePosition); });

    const toggleHide = () => { hide.value = !hide.value; };
    const applyFilter = () => { Object.assign(applied, fl); filterSheet.value = false; };
    const resetFilter = () => { Object.assign(fl, { symbol: '', side: '', sort: 'dist' }); Object.assign(applied, fl); hide.value = false; };

    // ----- 平仓 -----
    const openClose = (p) => { cp.value = p; Object.assign(cl, { mode: 'MARKET', pct: 100, price: '', err: '', perr: '', busy: false, key: newIdemKey() }); cl.qty = coinQty(p.symbol, p.position_qty); closeSheet.value = true; };
    const closePct = (pc) => { cl.pct = pc; cl.err = ''; const csz = csizeOf(cp.value.symbol); const lots = Math.max(1, Math.floor((num(cp.value.position_qty) * pc) / 100)); cl.qty = (lots * csz).toFixed(store.symbols[cp.value.symbol].qty_scale); };
    const closeQtyCoin = computed(() => num(cl.qty));
    const closePx = computed(() => (cp.value ? (cl.mode === 'LIMIT' && num(cl.price) > 0 ? num(cl.price) : num(cp.value.mark_price)) : 0));
    const closePnl = computed(() => (cp.value ? C.pnl(cp.value.position_side, closeQtyCoin.value, num(cp.value.avg_price), closePx.value) : 0));
    const closeFee = computed(() => closeQtyCoin.value * closePx.value * (cl.mode === 'MARKET' ? 0.0005 : 0.0002));
    const doClose = async () => {
      const p = cp.value; const csz = csizeOf(p.symbol);
      const lots = Math.floor(num(cl.qty) / csz + 1e-9);
      const maxCoin = num(coinQty(p.symbol, p.position_qty));
      if (!(lots > 0)) { cl.err = '请输入平仓数量'; return; }
      if (num(cl.qty) > maxCoin + 1e-9) { cl.err = `超过可平数量，最多可平 ${maxCoin} ${symBase(p.symbol)}`; return; }
      if (cl.mode === 'LIMIT' && !(num(cl.price) > 0)) { cl.perr = '请输入平仓价格'; return; }
      cl.busy = true;
      try {
        const body = { idempotency_key: cl.key, order_type: cl.mode, quantity: String(lots) };
        if (cl.mode === 'LIMIT') body.price = cl.price;
        const r = await api.position.close(p.position_oid, body);
        closeSheet.value = false;
        toast(cl.mode === 'MARKET' ? `已平仓，已实现 ${fmt(r.realized_pnl_amount, 2, { sign: true })} USDT` : r.order_status === 'FILLED' ? '限价平仓已成交' : '限价平仓委托已提交，已进入当前委托', 'ok', { title: '平仓成功' });
        refreshAccount(); load();
      } catch (e) {
        if (e.code === 'CONTRACT_ORDER_013') cl.err = e.msg;
        else if (e.code === 'CONTRACT_ORDER_018') cl.perr = e.msg;
        else if (['CONTRACT_POSITION_301', 'CONTRACT_POSITION_201'].includes(e.code)) { toast(e.msg, 'err'); closeSheet.value = false; load(); }
        else if (e.code === 'NETWORK_ERROR') toast('网络异常，请到持仓确认结果后再操作', 'err');
        else toast(e.msg, 'err');
      } finally { cl.busy = false; }
    };
    const doCloseAll = async () => {
      busyAll.value = true;
      try {
        const r = await api.position.closeAll(list.value.length === all.value.length ? undefined : list.value.map((p) => p.position_oid));
        allModal.value = false;
        toast(`已平 ${r.success_oids.length} 个仓位，合计 ${fmt(r.realized_pnl_total, 2, { sign: true })} USDT${r.failures.length ? `；${r.failures.length} 个失败` : ''}`, r.failures.length ? 'warn' : 'ok', { title: '一键全平' });
        refreshAccount(); load();
      } catch (e) { toast(e.msg, 'err'); } finally { busyAll.value = false; }
    };

    // ----- 调整保证金 -----
    let mgTimer = null; let mgSeq = 0;
    const openMargin = (p) => { mp.value = p; Object.assign(mg, { mode: 'ADD', amount: '', err: '', pv: null, busy: false, key: newIdemKey() }); marginSheet.value = true; };
    const setMode = (m) => { mg.mode = m; mg.amount = ''; mg.err = ''; mg.pv = null; };
    const mgMax = () => { mg.amount = mg.mode === 'ADD' ? mp.value.max_add_margin_amount : mp.value.max_reduce_margin_amount; mgChange(); };
    const mgChange = () => {
      mg.amount = String(mg.amount).replace(/[^\d.]/g, ''); mg.err = '';
      clearTimeout(mgTimer);
      if (!(num(mg.amount) > 0)) { mg.pv = null; return; }
      mgTimer = setTimeout(async () => {
        const seq = ++mgSeq;
        try {
          const body = mg.mode === 'ADD' ? { margin_add_amount: mg.amount, dry_run: true } : { margin_reduce_amount: mg.amount, dry_run: true };
          const r = await (mg.mode === 'ADD' ? api.position.marginAdd : api.position.marginReduce)(mp.value.position_oid, body);
          if (seq === mgSeq) mg.pv = r;
        } catch (e) { if (seq === mgSeq) { mg.pv = null; mg.err = e.msg; } }
      }, 300);
    };
    const doMargin = async () => {
      mg.busy = true;
      try {
        const body = mg.mode === 'ADD' ? { idempotency_key: mg.key, margin_add_amount: mg.amount } : { idempotency_key: mg.key, margin_reduce_amount: mg.amount };
        const r = await (mg.mode === 'ADD' ? api.position.marginAdd : api.position.marginReduce)(mp.value.position_oid, body);
        marginSheet.value = false; toast(`保证金已${mg.mode === 'ADD' ? '增加' : '减少'}，强平价 ${fmtPrice(r.liquidation_price, tk(mp.value.symbol))}`, 'ok', { title: '调整成功' });
        refreshAccount(); load();
      } catch (e) { mg.err = e.msg; if (['CONTRACT_POSITION_301', 'CONTRACT_POSITION_302'].includes(e.code)) load(); } finally { mg.busy = false; }
    };

    // ----- 止盈止损 -----
    const openTpsl = (p) => {
      tp.value = p;
      Object.assign(ts, { tab: 'TPSL', partial: false, qty: '', tp: p.tp_trigger_price || '', sl: p.sl_trigger_price || '', errTp: '', errSl: '', errQty: '', errTr: '', warn: '', trMode: 'RATE', trAct: '', trCb: '', busy: false });
      tpslSheet.value = true;
    };
    const pnlAt = (price) => { const p = tp.value; const qty = ts.partial && num(ts.qty) > 0 ? num(ts.qty) : num(coinQty(p.symbol, p.position_qty)); return C.pnl(p.position_side, qty, num(p.avg_price), price); };
    const tpPnl = computed(() => (tp.value && num(ts.tp) > 0 ? pnlAt(num(ts.tp)) : null));
    const slPnl = computed(() => (tp.value && num(ts.sl) > 0 ? pnlAt(num(ts.sl)) : null));
    const doTpsl = async () => {
      const p = tp.value; ts.errTp = ts.errSl = ts.errQty = ts.errTr = ts.warn = '';
      ts.busy = true;
      try {
        if (ts.tab === 'TPSL') {
          const had = { tp: p.tp_trigger_price, sl: p.sl_trigger_price };
          if (!ts.tp && !ts.sl && !had.tp && !had.sl) { ts.errTp = '请至少设置止盈或止损价'; return; }
          const body = {};
          if (ts.tp) body.tp_trigger_price = ts.tp; else if (had.tp) body.tp_trigger_price = null;   // 清空 = 传 null
          if (ts.sl) body.sl_trigger_price = ts.sl; else if (had.sl) body.sl_trigger_price = null;
          if (ts.partial) { const lots = Math.floor(num(ts.qty) / csizeOf(p.symbol) + 1e-9); if (!(lots > 0)) { ts.errQty = '请输入平仓数量'; return; } body.quantity = String(lots); }
          const r = await api.position.tpsl(p.position_oid, body);
          (r.warnings || []).forEach((w) => toast(w.msg, 'warn'));
          tpslSheet.value = false; toast(ts.tp || ts.sl ? '止盈止损已设置，触发后市价平仓' : '止盈止损已清除', 'ok', { title: '设置成功' }); load();
        } else {
          if (!(num(ts.trCb) > 0)) { ts.errTr = '请输入回撤幅度'; return; }
          await api.order.create({ symbol: p.symbol, order_type: 'TRAILING', position_side: p.position_side, position_effect: 'CLOSE', position_oid: p.position_oid, trailing_mode: ts.trMode, trailing_callback_value: ts.trMode === 'RATE' ? String(num(ts.trCb) / 100) : ts.trCb, trailing_activation_price: ts.trAct || undefined });
          tpslSheet.value = false; toast('移动止盈止损已设置', 'ok', { title: '设置成功', action: '查看', onAction: () => go('/orders') }); load();
        }
      } catch (e) {
        if (e.code === 'CONTRACT_ORDER_014') { const m = (e.data.errors && e.data.errors[0] && e.data.errors[0].message) || e.msg; if (/止损/.test(m)) ts.errSl = m; else ts.errTp = m; }
        else if (e.code === 'CONTRACT_ORDER_022' || e.code === 'CONTRACT_ORDER_013') ts.errQty = e.msg;
        else if (e.code === 'CONTRACT_ORDER_021') ts.errTr = e.msg;
        else if (e.code === 'CONTRACT_POSITION_201') { toast(e.msg, 'err'); tpslSheet.value = false; load(); }
        else toast(e.msg, 'err');
      } finally { ts.busy = false; }
    };

    return {
      state, list, total, orderCount, fl, hide, filterSheet, closeSheet, marginSheet, tpslSheet, allModal, busyAll, cp, mp, tp, cl, mg, ts, SORTS, RISK_TEXT,
      symOptions, symText, sideText, filtered, previewCount, sumPnl, closePnl, closeFee, tpPnl, slPnl,
      load, toggleHide, applyFilter, resetFilter, openClose, closePct, doClose, doCloseAll, openMargin, setMode, mgMax, mgChange, doMargin, openTpsl, doTpsl, tk,
      go, fmt, fmtPct, fmtPrice, symName, symBase, num, pnlClass, coinQty,
    };
  },
};

export const LiqDetail = {
  components: ui,
  template: `
  <div class="page">
    <AppHeader title="强平详情" fallback="/history/pos"/>
    <div class="scroll">
      <div class="loading" v-if="state === 'loading'"><span class="spin"></span>加载中…</div>
      <div class="empty" v-else-if="state === 'error'"><div class="ei">!</div><b>{{ errMsg }}</b><button class="btn sm primary" @click="load">重试</button></div>
      <div class="pad" v-else-if="d">
        <div class="row gap8" style="margin:6px 0 10px"><SideTag :side="d.position_side"/><b style="font-size:17px">{{ symName(d.symbol) }}</b><span class="pill">逐仓 {{ d.leverage }}×</span><span class="pill down">已强平</span></div>
        <div class="card" style="margin-bottom:10px"><small class="mute">最终亏损（= 全部仓位保证金）</small><div class="num down" style="font-size:26px;font-weight:800">{{ fmt(d.loss_amount, 2) }} USDT</div>
          <div class="grid2" style="margin-top:10px"><div class="cell"><small>开仓均价</small><span class="num">{{ fmtPrice(d.avg_price, tk) }}</span></div><div class="cell"><small>数量</small><span class="num">{{ coinQty(d.symbol, d.position_qty) }} {{ symBase(d.symbol) }}</span></div><div class="cell"><small>强平价</small><span class="num">{{ fmtPrice(d.liquidation_price, tk) }}</span></div><div class="cell"><small>破产价</small><span class="num">{{ fmtPrice(d.bankruptcy_price, tk) }}</span></div></div></div>
        <div class="h-sec" style="padding:8px 0 6px">发生了什么</div>
        <div v-for="(e, i) in d.timeline" :key="i" class="row" style="gap:12px;align-items:flex-start;padding-bottom:14px;position:relative">
          <div style="width:10px;height:10px;border-radius:50%;margin-top:4px;flex:none" :style="{ background: e.event === 'LIQUIDATION_TRIGGERED' || e.event === 'LIQUIDATION_SETTLED' ? 'var(--down)' : e.event === 'RISK_WARNING' ? 'var(--warn)' : 'var(--yellow)' }"></div>
          <div><b>{{ evLabel[e.event] || e.event }}</b> <small class="mute num">{{ fmtTime(e.time, 'hms') }}</small><div class="note">{{ e.text }}</div></div>
        </div>
        <div class="h-sec" style="padding:8px 0 6px">下次可以这样避免</div>
        <div class="card note" style="line-height:1.8">· {{ d.leverage }}× 杠杆下，价格反向约 {{ (100 / d.leverage).toFixed(1) }}% 就会强平，试试 5–10×<br>· 开仓同时设置止损，主动控制亏损<br>· 收到预警后追加保证金，拉远强平价</div>
        <button class="btn primary block" style="margin:16px 0" @click="go('/trade/' + d.symbol)">重新开仓</button>
      </div>
    </div>
  </div>`,
  setup() {
    const d = ref(null); const state = ref('loading'); const errMsg = ref('');
    const evLabel = { OPEN: '开仓', RISK_WARNING: '风险预警', LIQUIDATION_TRIGGERED: '触发强平', LIQUIDATION_SETTLED: '强平结算' };
    const load = async () => {
      state.value = 'loading';
      try { if (!store.symbolList.length) await loadSymbols(); d.value = await api.position.liquidation(route.params.oid); state.value = 'ok'; }
      catch (e) { errMsg.value = e.code === 'CONTRACT_POSITION_307' ? '该仓位不是被强平，没有强平详情' : e.msg || '加载失败'; state.value = 'error'; }
    };
    onMounted(load);
    const tk = computed(() => (d.value && store.symbols[d.value.symbol] ? store.symbols[d.value.symbol].price_tick : '0.01'));
    return { d, state, errMsg, evLabel, load, tk, go, fmt, fmtPrice, fmtTime, symName, symBase, coinQty };
  },
};
