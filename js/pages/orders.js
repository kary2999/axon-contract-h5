// ⑩ 当前委托：普通 / 止盈止损 / 移动止盈止损 / 计划委托 / 冰山委托；筛选 / 改单 / 撤单 / 撤销全部
import { ui } from './_ui.js';
import { PosTabs, FilterBar } from './_tabs.js';
import { go } from '../router.js';
import * as api from '../api/index.js';
import { store, loadSymbols, loadTickers, useTickers, refreshAccount, toast, coinQty, csizeOf } from '../store.js';
import { fmt, fmtPct, fmtPrice, fmtTime, symName, symBase, num, label, sideText, sideClass, pnlClass } from '../lib/format.js';
import { getDefaultSymbol } from './_shared.js';

const { ref, reactive, computed, watch, onMounted } = Vue;

const GROUPS = [
  { k: 'NORMAL', t: '普通', tip: (n) => `限价 / 市价挂单 · 真实订单簿排队 · ${n} 笔`, foot: '与实盘同一撮合：价格优先、时间优先，可部分成交；未成交部分冻结保证金，撤单后退回可用余额。' },
  { k: 'TPSL', t: '止盈止损', tip: (n) => `止盈止损 · 依附持仓，触发后市价平仓 · ${n} 笔`, foot: '止盈与止损任一触发后，另一个自动取消；全部仓位的止盈止损随仓位增减自动跟随。' },
  { k: 'TRAILING', t: '移动止盈止损', tip: (n) => `移动止盈止损 · 止损线跟随锚点移动 · ${n} 笔`, foot: '激活后以持仓期间最高价（空头为最低价）为锚点，创新高时止损线同步上移；从锚点回撤超过设定幅度即市价平仓。' },
  { k: 'CONDITIONAL', t: '计划委托', tip: (n) => `计划委托 · 触发前不进入盘口、不冻结保证金 · ${n} 笔`, foot: '达到触发价的瞬间才按预设参数提交限价或市价单；提交时再校验保证金，余额不足则触发失败并记入历史委托。' },
  { k: 'ICEBERG', t: '冰山委托', tip: (n) => `冰山委托 · 每次只挂出一小笔 · ${n} 笔`, foot: '按单次显示数量拆分，前一笔完全成交后才挂出下一笔；盘口只能看到当前这一笔。撤单时已成交部分保留。' },
];

export const Orders = {
  components: { ...ui, PosTabs, FilterBar },
  template: `
  <div class="page">
    <AppHeader noBack title="当前委托"/>
    <PosTabs active="ord" :posCount="posCount" :orderCount="counts.current_total"/>
    <div class="chips" style="padding-bottom:0"><button class="chip" v-for="g in GROUPS" :key="g.k" :class="{ on: group === g.k }" @click="group = g.k">{{ g.t }} {{ (counts.type_counts && counts.type_counts[g.k]) || 0 }}</button></div>
    <FilterBar :symbolText="symText" :sideText="sideLabel" :hideOthers="hide" @open="filterSheet = true" @toggle-hide="hide = !hide"/>
    <div class="scroll">
      <div class="row between pad" style="padding-top:2px;padding-bottom:4px" v-if="state === 'ok' && (list.length || filtered)">
        <span class="note">{{ gobj.tip(list.length) }}</span><button class="link" :disabled="!list.length" @click="cancelAllModal = true" :style="!list.length ? 'opacity:.4' : ''">撤销全部</button>
      </div>
      <p class="note pad" v-if="filtered" style="margin:0 0 4px">已筛选 · 当前委托无时间筛选；已结束的委托请到「历史 · 历史委托」查看</p>
      <template v-if="state === 'loading'"><div class="item" v-for="n in 2" :key="n"><div class="skel" style="height:130px"></div></div></template>
      <div class="empty" v-else-if="state === 'error'"><div class="ei">!</div><b>加载失败</b><span>委托暂时无法加载</span><button class="btn sm primary" @click="load">重试</button></div>
      <div class="empty" v-else-if="!list.length && filtered"><div class="ei">⌕</div><b>没有符合条件的委托</b><button class="btn sm ghost" @click="resetFilter">重置筛选</button></div>
      <div class="empty" v-else-if="!list.length"><div class="ei">▭</div><b>当前没有{{ gobj.t }}委托</b><span>去交易页下一笔单吧</span><button class="btn sm primary" @click="go('/trade')">去交易</button></div>
      <template v-else>
        <div class="item" v-for="o in list" :key="o.order_oid">
          <div class="it-h">
            <b :class="sideClass(o)" style="font-size:15px">{{ sideText(o) }}</b><b>{{ symName(o.symbol) }}</b>
            <span class="note">{{ subTitle(o) }}</span>
            <span class="pill r" :class="statusCls(o)" style="margin-left:auto">{{ statusText(o) }}</span>
          </div>

          <!-- 普通 / 冰山 / 触发后的计划委托 -->
          <div class="it-g num" v-if="o.order_type === 'LIMIT' || o.order_type === 'MARKET' || (o.order_type === 'CONDITIONAL' && o.is_triggered)">
            <div><small>委托价</small>{{ o.price ? fmtPrice(o.price, tk(o.symbol)) : '市价' }}</div><div><small>委托量</small>{{ coinQty(o.symbol, o.quantity) }} {{ symBase(o.symbol) }}</div><div><small>冻结保证金</small>{{ fmt(o.frozen_margin_amount) }}</div>
            <div><small>只减仓</small>{{ o.reduce_only ? '是' : '否' }}</div><div><small>有效方式</small>{{ o.time_in_force }}</div>
            <div v-if="o.position_effect === 'CLOSE'"><small>关联仓位</small>{{ o.position_side === 'LONG' ? '多' : '空' }} {{ coinQty(o.symbol, o.quantity) }}</div><div v-else><small>附带止盈/止损</small>{{ o.tp_trigger_price ? fmtPrice(o.tp_trigger_price, tk(o.symbol)) : '--' }} / {{ o.sl_trigger_price ? fmtPrice(o.sl_trigger_price, tk(o.symbol)) : '--' }}</div>
          </div>
          <div class="it-g num" v-else-if="o.order_type === 'ICEBERG'">
            <div><small>委托价</small>{{ fmtPrice(o.price, tk(o.symbol)) }}</div><div><small>总数量</small>{{ coinQty(o.symbol, o.quantity) }} {{ symBase(o.symbol) }}</div><div><small>单次显示</small>{{ coinQty(o.symbol, o.iceberg_visible_qty) }}</div>
            <div><small>当前挂出</small>第 {{ o.iceberg_slice_index }} 笔 {{ coinQty(o.symbol, o.iceberg_slice_qty) }}</div><div><small>冻结保证金</small>{{ fmt(o.frozen_margin_amount) }}</div><div><small>剩余未挂出</small>{{ coinQty(o.symbol, o.iceberg_remaining_qty) }} {{ symBase(o.symbol) }}</div>
          </div>
          <div class="it-g num" v-else-if="o.order_type === 'TPSL'">
            <div><small>止盈触发价</small><span class="up">{{ o.tp_trigger_price ? fmtPrice(o.tp_trigger_price, tk(o.symbol)) : '--' }}</span></div><div><small>止损触发价</small><span class="down">{{ o.sl_trigger_price ? fmtPrice(o.sl_trigger_price, tk(o.symbol)) : '--' }}</span></div><div><small>平仓数量</small>{{ num(o.quantity) ? coinQty(o.symbol, o.quantity) + ' ' + symBase(o.symbol) : '全部仓位' }}</div>
            <div><small>触发依据</small>标记价</div><div><small>执行</small>市价平仓</div><div><small>关联仓位</small>{{ o.position_side === 'LONG' ? '多' : '空' }}</div>
          </div>
          <div class="it-g num" v-else-if="o.order_type === 'TRAILING'">
            <div><small>激活价</small>{{ o.trailing_activation_price ? fmtPrice(o.trailing_activation_price, tk(o.symbol)) : '立即' }} <span class="up" v-if="o.trailing_activated">✓</span></div><div><small>{{ o.position_side === 'LONG' ? '锚点最高价' : '锚点最低价' }}</small>{{ o.trailing_anchor_price ? fmtPrice(o.trailing_anchor_price, tk(o.symbol)) : '--' }}</div><div><small>当前止损线</small>{{ o.trailing_stop_price ? fmtPrice(o.trailing_stop_price, tk(o.symbol)) : '--' }}</div>
            <div><small>回撤幅度</small>{{ o.trailing_mode === 'RATE' ? fmtPct(o.trailing_callback_value, 2) : o.trailing_callback_value + ' USDT' }}</div><div><small>平仓数量</small>{{ num(o.quantity) ? coinQty(o.symbol, o.quantity) + ' ' + symBase(o.symbol) : '全部仓位' }}</div><div><small>关联仓位</small>{{ o.position_side === 'LONG' ? '多' : '空' }}</div>
          </div>
          <div class="it-g num" v-else-if="o.order_type === 'CONDITIONAL'">
            <div><small>触发条件</small>{{ o.trigger_condition === 'LTE' ? '≤' : '≥' }} {{ fmtPrice(o.trigger_price, tk(o.symbol)) }}</div><div><small>执行类型</small>{{ o.triggered_order_type === 'LIMIT' ? '限价' : '市价' }}</div><div><small>执行价格</small>{{ o.price ? fmtPrice(o.price, tk(o.symbol)) : '市价' }}</div>
            <div><small>数量</small>{{ coinQty(o.symbol, o.quantity) }} {{ symBase(o.symbol) }}</div><div><small>杠杆</small>{{ o.leverage }}×</div><div><small>距触发</small><span :class="pnlClass(distTrig(o))">{{ fmtPct(distTrig(o), 2, { sign: true }) }}</span></div>
          </div>

          <div class="it-n" v-if="note(o)">{{ note(o) }}</div>
          <div class="row between note" style="margin-top:8px"><span>{{ fmtTime(o.create_time) }}</span><span v-if="o.price_source && o.price_source !== 'MANUAL'" class="pill">{{ label('price_source', o.price_source) }}</span></div>
          <div class="it-f">
            <button class="btn sm" @click="openAmend(o)">{{ o.order_type === 'TRAILING' ? '修改' : o.order_type === 'TPSL' ? '修改' : '改单' }}</button>
            <button class="btn sm" :disabled="busyOid === o.order_oid" @click="cancelTarget = o; cancelModal = true"><span class="spin" v-if="busyOid === o.order_oid"></span>{{ busyOid === o.order_oid ? '撤单中…' : '撤单' }}</button>
          </div>
        </div>
        <div class="more">{{ gobj.foot }}</div>
      </template>
      <div style="height:16px"></div>
    </div>

    <!-- 筛选 -->
    <Sheet v-model="filterSheet" title="筛选委托">
      <div class="h-sec" style="padding:0 0 6px;font-size:13px">交易对</div>
      <div class="chips" style="padding:0 0 8px;flex-wrap:wrap"><button class="chip" :class="{ on: !fl.symbol }" @click="fl.symbol = ''">全部</button><button class="chip" v-for="s in store.symbolList" :key="s.symbol" :class="{ on: fl.symbol === s.symbol }" @click="fl.symbol = s.symbol">{{ symName(s.symbol) }}</button></div>
      <div class="h-sec" style="padding:8px 0 6px;font-size:13px">方向</div>
      <div class="chips" style="padding:0 0 8px"><button class="chip" v-for="s in SIDES" :key="s.k" :class="{ on: fl.side === s.k }" @click="fl.side = s.k">{{ s.t }}</button></div>
      <template #footer><button class="btn grow" @click="resetFilter(); filterSheet = false">重置</button><button class="btn primary grow" @click="Object.assign(applied, fl); filterSheet = false">确定</button></template>
    </Sheet>

    <!-- 撤单确认 -->
    <Modal v-model="cancelModal" title="撤销委托？">
      <template v-if="cancelTarget">
        <p class="note" style="margin:0 0 8px">{{ symName(cancelTarget.symbol) }} · {{ sideText(cancelTarget) }} · {{ label('order_type', cancelTarget.order_type) }}</p>
        <div class="kv"><span>未成交数量</span><b class="num">{{ coinQty(cancelTarget.symbol, num(cancelTarget.quantity) - num(cancelTarget.filled_qty)) }} {{ symBase(cancelTarget.symbol) }}</b></div>
        <div class="kv"><span>退回保证金</span><b class="num">{{ fmt(cancelTarget.frozen_margin_amount) }} USDT</b></div>
        <p class="note" style="margin-top:8px">撤单后未成交部分立即取消，冻结的保证金退回可用余额；已成交部分不受影响。</p>
      </template>
      <template #footer><button class="btn" @click="cancelModal = false">暂不撤单</button><button class="btn primary" @click="doCancel">确认撤单</button></template>
    </Modal>
    <!-- 撤销全部 -->
    <Modal v-model="cancelAllModal" :title="'撤销全部' + gobj.t + '委托'">
      <p class="note" style="margin:0 0 8px">按当前筛选范围撤销：{{ symText }} · {{ sideLabel }} · {{ gobj.t }}委托</p>
      <div class="kv"><span>撤销笔数</span><b class="num">{{ list.length }} 笔</b></div>
      <div class="kv"><span>涉及交易对</span><b>{{ [...new Set(list.map(o => symName(o.symbol)))].join(' / ') }}</b></div>
      <div class="kv"><span>将退回保证金</span><b class="num">{{ fmt(list.reduce((s, o) => s + num(o.frozen_margin_amount), 0)) }} USDT</b></div>
      <p class="note" style="margin-top:8px">已部分成交的委托只撤销未成交部分；撤单过程中刚好成交的委托会保留成交结果，并在结果中提示。</p>
      <template #footer><button class="btn" @click="cancelAllModal = false">取消</button><button class="btn primary" :disabled="busyAll" @click="doCancelAll"><span class="spin" v-if="busyAll"></span>确认撤销 {{ list.length }} 笔</button></template>
    </Modal>

    <!-- 改单 -->
    <Sheet v-model="amendSheet" :title="am.o && (am.o.order_type === 'TRAILING' || am.o.order_type === 'TPSL') ? '修改委托' : '改单'">
      <template v-if="am.o">
        <p class="note" style="margin:0 0 10px"><b :class="sideClass(am.o)">{{ sideText(am.o) }}</b> {{ symName(am.o.symbol) }} · {{ label('order_type', am.o.order_type) }}</p>
        <div class="field" v-if="am.o.order_type === 'LIMIT' || am.o.order_type === 'ICEBERG' || (am.o.order_type === 'CONDITIONAL' && am.o.triggered_order_type === 'LIMIT')"><label>委托价格</label><div class="inp" :class="{ err: !!am.perr }"><input v-model="am.price" inputmode="decimal" @input="am.perr = ''"><span class="suf">USDT</span></div><span class="err-t" v-if="am.perr">{{ am.perr }}</span><span class="tip-t" v-else-if="am.dev !== null">与{{ buyOf(am.o) ? '买一价' : '卖一价' }} {{ am.best }} 偏离 {{ am.dev }}%</span></div>
        <div class="field" v-if="am.o.order_type === 'CONDITIONAL'"><label>触发价</label><div class="inp" :class="{ err: !!am.terr }"><input v-model="am.trigger" inputmode="decimal" @input="am.terr = ''"><span class="suf">USDT</span></div><span class="err-t" v-if="am.terr">{{ am.terr }}</span></div>
        <div class="field" v-if="am.o.order_type === 'TRAILING'"><label>回撤{{ am.o.trailing_mode === 'RATE' ? '比例' : '价差' }}</label><div class="inp" :class="{ err: !!am.cerr }"><input v-model="am.cb" inputmode="decimal" @input="am.cerr = ''"><span class="suf">{{ am.o.trailing_mode === 'RATE' ? '%' : 'USDT' }}</span></div><span class="err-t" v-if="am.cerr">{{ am.cerr }}</span></div>
        <div class="field" v-if="am.o.order_type !== 'TPSL'"><label>委托数量</label><div class="inp" :class="{ err: !!am.qerr }"><input v-model="am.qty" inputmode="decimal" @input="am.qerr = ''"><span class="suf">{{ symBase(am.o.symbol) }}</span></div><span class="err-t" v-if="am.qerr">{{ am.qerr }}</span><span class="tip-t" v-else-if="num(am.o.filled_qty) > 0">不能小于已成交数量 {{ coinQty(am.o.symbol, am.o.filled_qty) }} {{ symBase(am.o.symbol) }}</span></div>
        <template v-if="am.o.order_type === 'TPSL'"><div class="field"><label>止盈触发价</label><div class="inp"><input v-model="am.tp" inputmode="decimal"><span class="suf">USDT</span></div></div><div class="field"><label>止损触发价</label><div class="inp"><input v-model="am.sl" inputmode="decimal"><span class="suf">USDT</span></div></div><span class="err-t" v-if="am.perr">{{ am.perr }}</span></template>
        <div class="kv" v-if="num(am.o.frozen_margin_amount) > 0"><span>原委托</span><span class="num">{{ am.o.price ? fmtPrice(am.o.price, tk(am.o.symbol)) : '' }} × {{ coinQty(am.o.symbol, am.o.quantity) }}</span></div>
        <div class="kv" v-if="num(am.o.frozen_margin_amount) > 0"><span>冻结保证金变化</span><span class="num">{{ fmt(am.o.frozen_margin_amount) }} → <b>{{ newFrozen }}</b></span></div>
        <p class="note" style="margin-top:8px">改单 = 撤销原单未成交部分 + 按新价格 / 数量重新挂单，排队顺序将重新计算。</p>
      </template>
      <template #footer><button class="btn grow" @click="amendSheet = false">取消</button><button class="btn primary grow" :disabled="am.busy" @click="doAmend"><span class="spin" v-if="am.busy"></span>确认修改</button></template>
    </Sheet>
  </div>`,

  setup() {
    const state = ref('loading'); const rows = ref([]); const counts = reactive({ current_total: 0, type_counts: {} }); const posCount = ref(0);
    const group = ref('NORMAL');
    const fl = reactive({ symbol: '', side: '' }); const applied = reactive({ symbol: '', side: '' }); const hide = ref(false);
    const filterSheet = ref(false); const cancelModal = ref(false); const cancelAllModal = ref(false); const amendSheet = ref(false);
    const cancelTarget = ref(null); const busyOid = ref(''); const busyAll = ref(false);
    const am = reactive({ o: null, price: '', qty: '', trigger: '', cb: '', tp: '', sl: '', perr: '', qerr: '', terr: '', cerr: '', busy: false, key: '', dev: null, best: '' });
    const SIDES = [{ k: '', t: '全部' }, { k: 'LONG|OPEN', t: '开多' }, { k: 'SHORT|OPEN', t: '开空' }, { k: 'LONG|CLOSE', t: '平多' }, { k: 'SHORT|CLOSE', t: '平空' }];
    const gobj = computed(() => GROUPS.find((g) => g.k === group.value));
    const tk = (s) => (store.symbols[s] ? store.symbols[s].price_tick : '0.01');
    const symText = computed(() => (applied.symbol ? symName(applied.symbol) : '全部交易对'));
    const sideLabel = computed(() => (SIDES.find((s) => s.k === applied.side) || SIDES[0]).t === '全部' ? '全部方向' : SIDES.find((s) => s.k === applied.side).t);
    const filtered = computed(() => !!(applied.symbol || applied.side || hide.value));

    const load = async () => {
      if (!rows.value.length) state.value = 'loading';
      try {
        const r = await api.order.list({ filters: { scope: 'CURRENT' }, pagination: { page: 1, size: 100 }, sort_by: 'create_time', order: 'desc' });
        rows.value = r.list; Object.assign(counts, r.summary);
        api.position.list({ filters: { position_status: 'OPEN' }, pagination: { page: 1, size: 1 } }).then((p) => { posCount.value = p.summary.count; }).catch(() => {});
        state.value = 'ok';
      } catch (e) { if (!rows.value.length) state.value = 'error'; }
    };
    onMounted(async () => { if (!store.symbolList.length) { await loadSymbols(); await loadTickers(); } load(); });
    useTickers(() => store.symbolList.map((s) => s.symbol));
    watch(() => store.rev.orders, load);

    const groupOf = (o) => (o.order_type === 'LIMIT' || o.order_type === 'MARKET' ? 'NORMAL' : o.order_type === 'CONDITIONAL' ? (o.is_triggered ? 'NORMAL' : 'CONDITIONAL') : o.order_type);
    const list = computed(() => rows.value.filter((o) => groupOf(o) === group.value
      && (!applied.symbol || o.symbol === applied.symbol)
      && (!applied.side || `${o.position_side}|${o.position_effect}` === applied.side)
      && (!hide.value || o.symbol === getDefaultSymbol())));
    const resetFilter = () => { Object.assign(fl, { symbol: '', side: '' }); Object.assign(applied, fl); hide.value = false; };

    const buyOf = (o) => (o.position_side === 'LONG') === (o.position_effect === 'OPEN');
    const subTitle = (o) => {
      if (o.order_type === 'LIMIT') return `限价 · ${o.position_effect === 'CLOSE' ? '只减仓' : '逐仓 ' + o.leverage + '×'}`;
      if (o.order_type === 'MARKET') return '市价';
      if (o.order_type === 'ICEBERG') return `逐仓 ${o.leverage}×`;
      if (o.order_type === 'TRAILING') return `回撤 ${o.trailing_mode === 'RATE' ? fmtPct(o.trailing_callback_value, 2) : o.trailing_callback_value + ' USDT'}`;
      if (o.order_type === 'CONDITIONAL') return o.is_triggered ? '计划委托 · 已触发' : `计划 · ${o.leverage}×`;
      return '';
    };
    const statusText = (o) => {
      if (o.order_type === 'ICEBERG' && o.order_status !== 'PENDING_TRIGGER') return `挂单中 · 第 ${o.iceberg_slice_index}/${o.iceberg_slice_total} 笔`;
      if (o.order_type === 'TRAILING') return o.trailing_activated ? '已激活 · 跟踪中' : '待激活';
      if (o.order_status === 'PENDING_TRIGGER') return '等待触发';
      return label('order_status', o.order_status);
    };
    const statusCls = (o) => (o.order_type === 'TRAILING' && o.trailing_activated ? 'up' : o.order_status === 'PARTIALLY_FILLED' ? 'yellow' : 'warn');
    const distTrig = (o) => { const t = store.tickers[o.symbol]; return t ? (num(o.trigger_price) - num(t.mark_price)) / num(t.mark_price) : 0; };
    const note = (o) => {
      const t = store.tickers[o.symbol]; const d = tk(o.symbol);
      const filled = num(o.filled_qty); const q = num(o.quantity);
      if (o.order_type === 'ICEBERG') return `已成交 ${o.iceberg_slice_index - 1} / ${o.iceberg_slice_total} 笔 · ${coinQty(o.symbol, filled)} / ${coinQty(o.symbol, q)} ${symBase(o.symbol)}（${Math.round((filled / q) * 100)}%）${filled ? ' · 均价 ' + fmtPrice(o.avg_fill_price, d) : ''}`;
      if (o.order_type === 'LIMIT' || o.order_type === 'MARKET' || (o.order_type === 'CONDITIONAL' && o.is_triggered)) {
        let s = `已成交 ${coinQty(o.symbol, filled)} / ${coinQty(o.symbol, q)} ${symBase(o.symbol)}（${Math.round((filled / q) * 100)}%）${filled ? ' · 成交均价 ' + fmtPrice(o.avg_fill_price, d) : ''}`;
        if (o.price_source && o.price_source !== 'MANUAL') s += `\n以「${label('price_source', o.price_source)}」下单：提交瞬间取盘口价作为委托价`;
        if (o.order_type === 'CONDITIONAL') s += '\n该计划委托已触发并提交为限价单，原计划委托不可再撤，请对该限价单撤单';
        return s;
      }
      if (o.order_type === 'TRAILING') {
        if (!t) return '';
        if (o.trailing_activated && o.trailing_stop_price) { const gap = Math.abs(num(t.mark_price) - num(o.trailing_stop_price)) / num(t.mark_price); return `标记价 ${fmtPrice(t.mark_price, d)} · 距触发还差 ${fmtPct(gap, 2)}（止损线 ${fmtPrice(o.trailing_stop_price, d)}）`; }
        const act = num(o.trailing_activation_price);
        return `标记价 ${fmtPrice(t.mark_price, d)} · 距激活价还差 ${fmtPct(Math.abs(num(t.mark_price) - act) / num(t.mark_price), 2)}\n未激活：标记价 ${o.position_side === 'LONG' ? '≥' : '≤'} ${fmtPrice(act, d)} 后开始以${o.position_side === 'LONG' ? '最高' : '最低'}价为锚点跟踪`;
      }
      if (o.order_type === 'CONDITIONAL' && t) return `标记价 ${fmtPrice(t.mark_price, d)} → 触发价 ${fmtPrice(o.trigger_price, d)} · 还差 ${fmtPct(distTrig(o), 2, { sign: true })}\n标记价 ${o.trigger_condition === 'LTE' ? '≤' : '≥'} ${fmtPrice(o.trigger_price, d)} 时，以${o.triggered_order_type === 'LIMIT' ? '限价 ' + fmtPrice(o.price, d) : '市价'}${sideText(o)} ${coinQty(o.symbol, q)} ${symBase(o.symbol)}`;
      return '';
    };

    // ----- 撤单 -----
    const doCancel = async () => {
      const o = cancelTarget.value; cancelModal.value = false; busyOid.value = o.order_oid;
      try {
        const r = await api.order.cancel(o.order_oid);
        toast(`已撤销，退回保证金 ${fmt(r.released_margin_amount)} USDT`, 'ok', { title: '撤单成功' });
        refreshAccount();
      } catch (e) {
        if (e.code === 'CONTRACT_ORDER_301') toast('该委托已完全成交，无法撤销。成交记录可在「历史 · 成交明细」查看', 'err', { title: '撤单失败', action: '查看成交', onAction: () => go('/history/fills'), duration: 4500 });
        else if (e.code === 'CONTRACT_ORDER_503') toast('撮合服务暂不可用，撤单失败，请稍后重试', 'err', { title: '撤单失败' });
        else toast(e.msg, 'err', { title: '撤单失败' });
      } finally { busyOid.value = ''; load(); }
    };
    const doCancelAll = async () => {
      busyAll.value = true;
      try {
        const [sd, ef] = applied.side ? applied.side.split('|') : [];
        const r = await api.order.cancelAll({ order_group: group.value, ...(applied.symbol ? { symbol: applied.symbol } : {}), ...(sd ? { position_side: sd } : {}) });
        cancelAllModal.value = false;
        toast(`已撤销 ${r.success_oids.length} 笔，退回保证金 ${fmt(r.released_margin_amount)} USDT${r.failures.length ? `；${r.failures.length} 笔刚好成交已保留` : ''}`, r.failures.length ? 'warn' : 'ok', { title: '撤销全部' });
        refreshAccount();
      } catch (e) { toast(e.msg, 'err'); } finally { busyAll.value = false; load(); }
    };

    // ----- 改单 -----
    const openAmend = (o) => {
      Object.assign(am, { o, price: o.price ? o.price : '', qty: o.quantity ? coinQty(o.symbol, o.quantity) : '', trigger: o.trigger_price || '', cb: o.trailing_mode === 'RATE' ? String(num(o.trailing_callback_value) * 100) : o.trailing_callback_value, tp: o.tp_trigger_price || '', sl: o.sl_trigger_price || '', perr: '', qerr: '', terr: '', cerr: '', busy: false, key: '' });
      amendSheet.value = true;
    };
    const bestOf = (o) => { const t = store.tickers[o.symbol]; return t ? num(t.last_price) : 0; };
    watch(() => am.price, () => {
      if (!am.o || !num(am.price)) { am.dev = null; return; }
      const best = bestOf(am.o); am.best = fmtPrice(best, tk(am.o.symbol)); am.dev = (Math.abs(num(am.price) - best) / best * 100).toFixed(2);
    });
    const newFrozen = computed(() => {
      if (!am.o) return '--';
      const price = num(am.price) || num(am.o.price); const coin = num(am.qty) - 0;
      return fmt((price * coin) / am.o.leverage, 2);
    });
    const doAmend = async () => {
      const o = am.o; const csz = csizeOf(o.symbol);
      const body = {};
      if (o.order_type === 'TPSL') { toast('止盈止损请在持仓页修改', 'info'); amendSheet.value = false; return; }
      if (o.order_type !== 'TRAILING' && o.order_type !== 'TPSL') {
        const lots = Math.floor(num(am.qty) / csz + 1e-9);
        if (!(lots > 0)) { am.qerr = '请输入委托数量'; return; }
        body.quantity = String(lots);
      }
      if (['LIMIT', 'ICEBERG'].includes(o.order_type) || (o.order_type === 'CONDITIONAL' && o.triggered_order_type === 'LIMIT')) { if (!num(am.price)) { am.perr = '请输入委托价格'; return; } body.price = am.price; }
      if (o.order_type === 'CONDITIONAL') body.trigger_price = am.trigger;
      if (o.order_type === 'TRAILING') { if (!num(am.cb)) { am.cerr = '请输入回撤幅度'; return; } body.trailing_callback_value = o.trailing_mode === 'RATE' ? String(num(am.cb) / 100) : am.cb; }
      am.busy = true;
      try {
        await api.order.amend(o.order_oid, body);
        amendSheet.value = false; toast('已按新价格 / 数量重新挂单，排队顺序重新计算', 'ok', { title: '改单成功' }); refreshAccount();
      } catch (e) {
        if (e.code === 'CONTRACT_ORDER_019') am.qerr = e.msg;
        else if (e.code === 'CONTRACT_ORDER_018') am.perr = e.msg;
        else if (e.code === 'CONTRACT_ORDER_016') am.terr = e.msg;
        else if (e.code === 'CONTRACT_ORDER_301') { toast(e.msg, 'err'); amendSheet.value = false; }
        else if (e.code === 'CONTRACT_ORDER_011') am.qerr = `保证金不足，还差 ${fmt(e.data.shortfall_amount)} USDT`;
        else if (e.code === 'CONTRACT_ORDER_013' || e.code === 'CONTRACT_ORDER_015') am.qerr = e.msg;
        else toast(e.msg, 'err');
      } finally { am.busy = false; load(); }
    };

    return { GROUPS, SIDES, state, list, counts, posCount, group, gobj, fl, applied, hide, filterSheet, cancelModal, cancelAllModal, amendSheet, cancelTarget, busyOid, busyAll, am, symText, sideLabel, filtered,
      load, resetFilter, buyOf, subTitle, statusText, statusCls, distTrig, note, doCancel, doCancelAll, openAmend, doAmend, newFrozen, tk, store,
      go, fmt, fmtPct, fmtPrice, fmtTime, symName, symBase, num, label, sideText, sideClass, pnlClass, coinQty };
  },
};
