// ⑫⑬ 历史：历史持仓 / 历史委托 / 成交明细 / 资金流水（筛选、加载更多、详情）
import { ui } from './_ui.js';
import { go, route, replace } from '../router.js';
import * as api from '../api/index.js';
import { store, loadSymbols, loadTickers, toast, coinQty } from '../store.js';
import { fmt, fmtPct, fmtPrice, fmtTime, symName, symBase, num, label, sideText, sideClass, pnlClass, trimOid } from '../lib/format.js';
import { rangeOf } from './_shared.js';

const { ref, reactive, computed, watch, onMounted } = Vue;

const TABS = [{ k: 'cur', t: '当前持仓' }, { k: 'pos', t: '历史持仓' }, { k: 'orders', t: '历史委托' }, { k: 'fills', t: '成交明细' }, { k: 'ledger', t: '资金流水' }];
const RANGES = [{ d: 7, t: '近 7 天' }, { d: 30, t: '近 30 天' }, { d: 90, t: '近 90 天' }, { d: 0, t: '自定义' }];
const CLOSE_TYPES = [{ k: 'MANUAL', t: '手动平仓' }, { k: 'TAKE_PROFIT', t: '止盈' }, { k: 'STOP_LOSS', t: '止损' }, { k: 'LIQUIDATED', t: '强平' }, { k: 'ADL', t: 'ADL' }];
const ORDER_TYPES = [{ k: 'LIMIT', t: '限价' }, { k: 'MARKET', t: '市价' }, { k: 'TPSL', t: '止盈止损' }, { k: 'TRAILING', t: '移动止盈止损' }, { k: 'CONDITIONAL', t: '计划委托' }, { k: 'ICEBERG', t: '冰山委托' }];
const ORDER_STATES = [
  { k: 'FILLED', t: '完全成交', f: { order_status: ['FILLED'] } }, { k: 'PARTIALLY_CANCELED', t: '部分成交已撤', f: { order_status: ['PARTIALLY_CANCELED'] } },
  { k: 'CANCELED', t: '已撤销', f: { order_status: ['CANCELED'] } }, { k: 'TRIGGERED', t: '已触发', f: { is_triggered: true } },
  { k: 'TRIGGER_FAILED', t: '触发失败', f: { order_status: ['TRIGGER_FAILED'] } }, { k: 'EXPIRED', t: '已过期', f: { cancel_reason: 'EXPIRED' } },
];
const SIDES = [{ k: '', t: '全部' }, { k: 'LONG|OPEN', t: '开多' }, { k: 'SHORT|OPEN', t: '开空' }, { k: 'LONG|CLOSE', t: '平多' }, { k: 'SHORT|CLOSE', t: '平空' }];
const LEDGER_TYPES = [{ k: 'GRANT', t: '体验金发放' }, { k: 'CLAIM', t: '体验金补充' }, { k: 'REALIZED_PNL', t: '已实现盈亏' }, { k: 'FEE', t: '手续费' }, { k: 'FUNDING_FEE', t: '资金费用' }, { k: 'LIQUIDATION', t: '强平清算' }, { k: 'MARGIN_ADJUST', t: '保证金调整' }];
const LEDGER_ICON = { GRANT: '赠', CLAIM: '补', REALIZED_PNL: '盈', FEE: '费', FUNDING_FEE: '资', LIQUIDATION: '强', MARGIN_ADJUST: '调', ADJUST: '平' };
const defaults = () => ({ symbol: '', side: '', closeType: '', orderType: '', state: '', role: '', effect: '', ledgerType: '', days: 7, start: '', end: '' });

export const History = {
  components: ui,
  template: `
  <div class="page">
    <AppHeader title="历史记录" fallback="/positions"/>
    <div class="tabs"><button v-for="x in TABS" :key="x.k" :class="{ on: tab === x.k }" @click="switchTab(x.k)">{{ x.t }}</button></div>
    <div class="chips" style="align-items:center">
      <button class="chip" :class="{ on: !!af.symbol }" @click="openFilter">{{ af.symbol ? symName(af.symbol) : '全部交易对' }} ▾</button>
      <button class="chip" v-if="tab === 'pos'" :class="{ on: !!af.side }" @click="openFilter">{{ af.side ? (af.side === 'LONG' ? '多' : '空') : '方向' }} ▾</button>
      <button class="chip" v-if="tab === 'pos'" :class="{ on: !!af.closeType }" @click="openFilter">{{ af.closeType ? CLOSE_TYPES.find(c => c.k === af.closeType).t : '平仓方式' }} ▾</button>
      <button class="chip" v-if="tab === 'orders'" :class="{ on: !!af.orderType }" @click="openFilter">{{ af.orderType ? label('order_type', af.orderType) : '委托类型' }} ▾</button>
      <button class="chip" v-if="tab === 'orders'" :class="{ on: !!af.state }" @click="openFilter">{{ af.state ? ORDER_STATES.find(c => c.k === af.state).t : '状态' }} ▾</button>
      <button class="chip" v-if="tab === 'fills'" :class="{ on: !!af.role }" @click="openFilter">{{ af.role || 'Maker / Taker' }} ▾</button>
      <button class="chip" v-if="tab === 'ledger'" :class="{ on: !!af.ledgerType }" @click="openFilter">{{ af.ledgerType ? label('ledger_type', af.ledgerType) : '全部类型' }} ▾</button>
      <button class="chip" v-if="tab === 'ledger'" @click="openFilter">币种 USDT ▾</button>
      <button class="chip" :class="{ on: af.days !== 7 }" @click="openFilter">{{ rangeText }} ▾</button>
    </div>

    <div class="scroll" ref="scroller">
      <template v-if="state === 'loading'"><div class="item" v-for="n in 3" :key="n"><div class="skel" style="height:96px"></div></div></template>
      <div class="empty" v-else-if="state === 'error'"><div class="ei">!</div><b>加载失败</b><span>{{ errMsg }}</span><button class="btn sm primary" @click="reload">重试</button></div>
      <template v-else>
        <div class="banner info" v-if="isFiltered && list.length"><span>筛选结果 · {{ summaryCount }} 条</span><a class="link" style="margin-left:auto" @click="clearFilter">清除筛选</a></div>
        <!-- 汇总条 -->
        <div class="stat-bar" v-if="summary && tab === 'pos'"><div><small>已实现盈亏 · {{ rangeShort }}</small><b class="num" :class="pnlClass(summary.realized_pnl_total)">{{ fmt(summary.realized_pnl_total, 2, { sign: true }) }}</b></div><div><small>胜率</small><b class="num">{{ fmtPct(summary.win_rate, 0) }}</b></div><div><small>平仓笔数</small><b class="num">{{ summary.close_count }}</b></div></div>
        <div class="stat-bar" v-if="summary && tab === 'orders' && summary.history_stats"><div><small>委托 · {{ rangeShort }}</small><b class="num">{{ summary.history_stats.total }} 笔</b></div><div><small>有成交</small><b class="num">{{ summary.history_stats.filled_count }} 笔</b></div><div><small>撤销 / 失败 / 过期</small><b class="num">{{ summary.history_stats.ended_count }} 笔</b></div></div>
        <div class="stat-bar" v-if="summary && tab === 'fills'"><div><small>成交额 · {{ rangeShort }}</small><b class="num">{{ fmt(summary.turnover_total) }}</b></div><div><small>手续费合计</small><b class="num">{{ fmt(summary.fee_total) }}</b></div><div><small>Maker / Taker</small><b class="num">{{ summary.maker_count }} / {{ summary.taker_count }}</b></div></div>
        <div class="stat-bar" v-if="summary && tab === 'ledger'"><div><small>收入 · {{ rangeShort }}</small><b class="num up">{{ fmt(summary.income_total, 2, { sign: true }) }}</b></div><div><small>支出</small><b class="num down">{{ fmt(summary.expense_total) }}</b></div><div><small>当前可用</small><b class="num">{{ fmt(summary.available_balance) }}</b></div></div>

        <div class="empty" v-if="!list.length"><div class="ei">▭</div><b>{{ isFiltered ? '没有符合条件的记录' : emptyText }}</b><button class="btn sm ghost" v-if="isFiltered" @click="clearFilter">清除筛选</button></div>

        <!-- 历史持仓 -->
        <template v-if="tab === 'pos'">
          <div class="item" v-for="p in list" :key="p.position_oid">
            <div class="it-h"><SideTag :side="p.position_side"/><b>{{ symName(p.symbol) }}</b><span class="pill">逐仓 {{ p.leverage }}×</span><span class="pill" :class="p.close_type === 'LIQUIDATED' ? 'down' : p.close_type === 'TAKE_PROFIT' ? 'up' : p.close_type === 'STOP_LOSS' ? 'warn' : ''">{{ label('close_type', p.close_type) }}</span>
              <div class="r"><small class="mute" style="display:block">已实现盈亏</small><b class="num" :class="pnlClass(p.realized_pnl_amount)">{{ fmt(p.realized_pnl_amount, 2, { sign: true }) }}</b></div></div>
            <div class="it-g num"><div><small>开仓均价</small>{{ fmtPrice(p.avg_price, tk(p.symbol)) }}</div><div><small>{{ p.close_type === 'LIQUIDATED' ? '强平价' : p.close_type === 'ADL' ? '减仓成交价' : '平仓均价' }}</small>{{ fmtPrice(p.close_type === 'LIQUIDATED' ? p.liq_price_at_close : p.close_avg_price, tk(p.symbol)) }}</div><div><small>时间</small>{{ fmtTime(p.closed_time, 'md') }}</div></div>
            <div class="row between" style="margin-top:8px"><span></span><a class="link" @click="p.close_type === 'LIQUIDATED' ? go('/liq/' + p.position_oid) : openDetail(p)">{{ p.close_type === 'LIQUIDATED' ? '为什么被强平 ›' : '详情 ›' }}</a></div>
          </div>
        </template>
        <!-- 历史委托 -->
        <template v-else-if="tab === 'orders'">
          <div class="item" v-for="o in list" :key="o.order_oid">
            <div class="it-h"><b :class="sideClass(o)" style="font-size:15px">{{ sideText(o) }}</b><b>{{ symName(o.symbol) }}</b><span class="note">{{ label('order_type', o.order_type) }}{{ o.order_type === 'LIMIT' || o.order_type === 'ICEBERG' ? ' · ' + o.leverage + '×' : o.order_type === 'CONDITIONAL' ? ' · ' + o.leverage + '×' : '' }}</span>
              <span class="pill r" :class="stCls(o)">{{ stText(o) }}</span></div>
            <div class="it-g num" v-if="o.order_type === 'CONDITIONAL'">
              <div><small>触发条件</small>{{ o.trigger_condition === 'LTE' ? '≤' : '≥' }} {{ fmtPrice(o.trigger_price, tk(o.symbol)) }}</div><div><small>执行</small>{{ o.triggered_order_type === 'LIMIT' ? '限价 ' + fmtPrice(o.price, tk(o.symbol)) : '市价' }}</div><div><small>数量</small>{{ coinQty(o.symbol, o.quantity) }} {{ symBase(o.symbol) }}</div>
              <div v-if="o.order_status === 'TRIGGER_FAILED'" style="grid-column: span 3;text-align:left"><small>失败原因</small><span class="down">保证金不足</span> · 所需 {{ o.fail_detail && o.fail_detail.required_margin_amount }} / 可用 {{ o.fail_detail && o.fail_detail.available_balance }}</div>
              <template v-else-if="o.cancel_reason === 'EXPIRED'"><div><small>有效期</small>7 天</div><div><small>结果</small>未触发</div><div><small>订单号</small>{{ trimOid(o.order_oid) }}</div></template>
              <template v-else><div><small>成交均价</small>{{ fmtPrice(o.avg_fill_price, tk(o.symbol)) }}</div><div><small>成交</small>{{ label('order_status', o.order_status) }}</div><div><small>订单号</small>{{ trimOid(o.order_oid) }}</div></template>
            </div>
            <div class="it-g num" v-else>
              <div><small>委托价</small>{{ o.price ? fmtPrice(o.price, tk(o.symbol)) : '市价' }}</div><div><small>成交均价</small>{{ num(o.avg_fill_price) ? fmtPrice(o.avg_fill_price, tk(o.symbol)) : '--' }}</div><div><small>成交 / 委托</small>{{ coinQty(o.symbol, o.filled_qty) }} / {{ coinQty(o.symbol, o.quantity) }}</div>
              <div><small>手续费</small>{{ fmt(o.fee_amount) }}</div><div><small>{{ o.cancel_reason ? '撤单原因' : o.order_type === 'MARKET' ? '滑点' : '有效方式' }}</small>{{ o.cancel_reason ? label('cancel_reason', o.cancel_reason) : o.order_type === 'MARKET' && o.slippage_rate ? fmtPct(o.slippage_rate, 2, { sign: true }) : o.time_in_force }}</div><div><small>订单号</small>{{ trimOid(o.order_oid) }}</div>
            </div>
            <div class="row between" style="margin-top:8px"><span class="note">{{ fmtTime(o.create_time) }}</span><a class="link" @click="openDetail(o)">详情 ›</a></div>
          </div>
        </template>
        <!-- 成交明细 -->
        <template v-else-if="tab === 'fills'">
          <div class="item" v-for="x in list" :key="x.fill_oid">
            <div class="it-h"><b :class="sideClass(x)" style="font-size:15px">{{ sideText(x) }}</b><b>{{ symName(x.symbol) }}</b><span class="note">{{ label('order_type', x.order_type) }}{{ x.iceberg_slice_index ? ' · 第 ' + x.iceberg_slice_index + ' 笔' : '' }}</span><span class="pill r" :class="x.fill_role === 'MAKER' ? 'yellow' : ''">{{ x.fill_role === 'MAKER' ? 'Maker' : x.fill_role === 'TAKER' ? 'Taker' : '系统' }}</span></div>
            <div class="it-g num"><div><small>成交价</small>{{ fmtPrice(x.price, tk(x.symbol)) }}</div><div><small>成交量</small>{{ coinQty(x.symbol, x.quantity) }} {{ symBase(x.symbol) }}</div><div><small>成交额</small>{{ fmt(x.fill_amount) }}</div>
              <div><small>手续费</small>{{ fmt(x.fee_amount) }}</div><div><small>费率</small>{{ fmtPct(x.fee_rate, 2) }}</div><div><small>已实现盈亏</small><span :class="pnlClass(x.realized_pnl_amount)">{{ x.realized_pnl_amount ? fmt(x.realized_pnl_amount, 2, { sign: true }) : '--' }}</span></div></div>
            <div class="note" style="margin-top:6px">{{ fmtTime(x.fill_time) }}</div>
          </div>
        </template>
        <!-- 资金流水 -->
        <template v-else-if="tab === 'ledger'">
          <div class="item row" v-for="l in list" :key="l.ledger_oid" style="gap:12px" @click="openDetail(l)">
            <div class="side-tag" style="width:30px;height:30px;border-radius:8px;background:var(--card);color:var(--yellow);font-size:13px;flex:none">{{ LEDGER_ICON[l.ledger_type] || '·' }}</div>
            <div class="grow"><b>{{ label('ledger_type', l.ledger_type) }}</b><div class="note">{{ fmtTime(l.create_time, 'md') }} · {{ l.biz_desc }}</div></div>
            <div style="text-align:right"><b class="num" :class="pnlClass(l.ledger_amount)">{{ fmt(l.ledger_amount, 2, { sign: true }) }}</b><div class="note num">余额 {{ fmt(l.after_balance) }}</div></div>
          </div>
        </template>

        <div class="more" v-if="list.length"><button v-if="hasMore" class="link" :disabled="more" @click="loadMore">{{ more ? '加载中…' : '上拉加载更多' }}</button><span v-else>没有更多了</span></div>
      </template>
      <div style="height:16px"></div>
    </div>

    <!-- 筛选 -->
    <Sheet v-model="filterSheet" :title="'筛选 · ' + TABS.find(x => x.k === tab).t">
      <template v-if="tab !== 'ledger'"><div class="h-sec" style="padding:0 0 6px;font-size:13px">交易对</div>
        <div class="chips" style="padding:0 0 8px;flex-wrap:wrap"><button class="chip" :class="{ on: !fl.symbol }" @click="fl.symbol = ''">全部</button><button class="chip" v-for="s in store.symbolList" :key="s.symbol" :class="{ on: fl.symbol === s.symbol }" @click="fl.symbol = s.symbol">{{ symName(s.symbol) }}</button></div></template>
      <template v-if="tab === 'pos'">
        <div class="h-sec" style="padding:8px 0 6px;font-size:13px">方向</div><div class="chips" style="padding:0 0 8px"><button class="chip" :class="{ on: !fl.side }" @click="fl.side = ''">全部</button><button class="chip" :class="{ on: fl.side === 'LONG' }" @click="fl.side = 'LONG'">多</button><button class="chip" :class="{ on: fl.side === 'SHORT' }" @click="fl.side = 'SHORT'">空</button></div>
        <div class="h-sec" style="padding:8px 0 6px;font-size:13px">平仓方式</div><div class="chips" style="padding:0 0 8px;flex-wrap:wrap"><button class="chip" :class="{ on: !fl.closeType }" @click="fl.closeType = ''">全部</button><button class="chip" v-for="c in CLOSE_TYPES" :key="c.k" :class="{ on: fl.closeType === c.k }" @click="fl.closeType = c.k">{{ c.t }}</button></div>
      </template>
      <template v-if="tab === 'orders'">
        <div class="h-sec" style="padding:8px 0 6px;font-size:13px">委托类型</div><div class="chips" style="padding:0 0 8px;flex-wrap:wrap"><button class="chip" :class="{ on: !fl.orderType }" @click="fl.orderType = ''">全部</button><button class="chip" v-for="c in ORDER_TYPES" :key="c.k" :class="{ on: fl.orderType === c.k }" @click="fl.orderType = c.k">{{ c.t }}</button></div>
        <div class="h-sec" style="padding:8px 0 6px;font-size:13px">状态</div><div class="chips" style="padding:0 0 8px;flex-wrap:wrap"><button class="chip" :class="{ on: !fl.state }" @click="fl.state = ''">全部</button><button class="chip" v-for="c in ORDER_STATES" :key="c.k" :class="{ on: fl.state === c.k }" @click="fl.state = c.k">{{ c.t }}</button></div>
        <div class="h-sec" style="padding:8px 0 6px;font-size:13px">方向</div><div class="chips" style="padding:0 0 8px"><button class="chip" v-for="s in SIDES" :key="s.k" :class="{ on: fl.side === s.k }" @click="fl.side = s.k">{{ s.t }}</button></div>
      </template>
      <template v-if="tab === 'fills'">
        <div class="h-sec" style="padding:8px 0 6px;font-size:13px">开平</div><div class="chips" style="padding:0 0 8px"><button class="chip" :class="{ on: !fl.effect }" @click="fl.effect = ''">全部</button><button class="chip" :class="{ on: fl.effect === 'OPEN' }" @click="fl.effect = 'OPEN'">开仓</button><button class="chip" :class="{ on: fl.effect === 'CLOSE' }" @click="fl.effect = 'CLOSE'">平仓</button></div>
        <div class="h-sec" style="padding:8px 0 6px;font-size:13px">角色</div><div class="chips" style="padding:0 0 8px"><button class="chip" :class="{ on: !fl.role }" @click="fl.role = ''">全部</button><button class="chip" :class="{ on: fl.role === 'MAKER' }" @click="fl.role = 'MAKER'">MAKER</button><button class="chip" :class="{ on: fl.role === 'TAKER' }" @click="fl.role = 'TAKER'">TAKER</button></div>
      </template>
      <template v-if="tab === 'ledger'">
        <div class="h-sec" style="padding:0 0 6px;font-size:13px">类型</div><div class="chips" style="padding:0 0 8px;flex-wrap:wrap"><button class="chip" :class="{ on: !fl.ledgerType }" @click="fl.ledgerType = ''">全部</button><button class="chip" v-for="c in LEDGER_TYPES" :key="c.k" :class="{ on: fl.ledgerType === c.k }" @click="fl.ledgerType = c.k">{{ c.t }}</button></div>
        <div class="h-sec" style="padding:8px 0 6px;font-size:13px">币种</div><div class="chips" style="padding:0 0 8px"><button class="chip on">USDT</button></div>
      </template>
      <div class="h-sec" style="padding:8px 0 6px;font-size:13px">时间</div>
      <div class="chips" style="padding:0 0 8px"><button class="chip" v-for="r in RANGES" :key="r.d" :class="{ on: fl.days === r.d }" @click="fl.days = r.d">{{ r.t }}</button></div>
      <div class="row gap8" v-if="fl.days === 0"><div class="inp grow"><input type="date" class="text" v-model="fl.start"></div><span class="mute">至</span><div class="inp grow"><input type="date" class="text" v-model="fl.end"></div></div>
      <span class="err-t" v-if="fl.days === 0 && fl.start && fl.end && fl.start > fl.end">开始日期不能晚于结束日期</span>
      <template #footer><button class="btn grow" @click="Object.assign(fl, defaults())">重置</button><button class="btn primary grow" :disabled="fl.days === 0 && (!fl.start || !fl.end || fl.start > fl.end)" @click="applyFilter">查看结果</button></template>
    </Sheet>

    <!-- 详情 -->
    <Sheet v-model="detailSheet" :title="detailTitle">
      <div class="loading" v-if="detailBusy"><span class="spin"></span>加载中…</div>
      <template v-else-if="dt && tab === 'pos'">
        <div class="row gap8" style="margin-bottom:8px"><SideTag :side="dt.position_side"/><b style="font-size:16px">{{ symName(dt.symbol) }}</b><span class="pill">逐仓 {{ dt.leverage }}×</span><span class="pill">{{ label('close_type', dt.close_type) }}</span></div>
        <div class="num" :class="pnlClass(dt.realized_pnl_amount)" style="font-size:24px;font-weight:800">{{ fmt(dt.realized_pnl_amount, 2, { sign: true }) }} USDT <small>{{ fmtPct(dt.realized_pnl_rate, 1, { sign: true }) }}</small></div>
        <div class="card" style="margin:10px 0"><div class="kv"><span>平仓盈亏</span><b class="num" :class="pnlClass(dt.close_pnl_amount)">{{ fmt(dt.close_pnl_amount, 2, { sign: true }) }}</b></div><div class="kv"><span>手续费（开 + 平）</span><b class="num">{{ fmt(-num(dt.fee_amount), 2) }}</b></div><div class="kv"><span>资金费用</span><b class="num">{{ fmt(dt.funding_amount, 2, { sign: true }) }}</b></div><div class="kv"><span>已实现盈亏</span><b class="num" :class="pnlClass(dt.realized_pnl_amount)">{{ fmt(dt.realized_pnl_amount, 2, { sign: true }) }}</b></div></div>
        <div class="grid2 num"><div class="cell"><small>开仓均价</small>{{ fmtPrice(dt.avg_price, tk(dt.symbol)) }}</div><div class="cell"><small>平仓均价</small>{{ fmtPrice(dt.close_avg_price, tk(dt.symbol)) }}</div><div class="cell"><small>平仓数量</small>{{ coinQty(dt.symbol, dt.position_qty) }} {{ symBase(dt.symbol) }}</div><div class="cell"><small>最大持仓</small>{{ coinQty(dt.symbol, dt.position_qty) }} {{ symBase(dt.symbol) }}</div><div class="cell" v-if="dt.trigger_price"><small>触发价（标记价）</small>{{ fmtPrice(dt.trigger_price, tk(dt.symbol)) }}</div><div class="cell"><small>平仓方式</small>{{ label('close_type', dt.close_type) }}</div><div class="cell"><small>开仓时间</small>{{ fmtTime(dt.opened_time, 'md') }}</div><div class="cell"><small>平仓时间</small>{{ fmtTime(dt.closed_time, 'md') }}</div></div>
      </template>
      <template v-else-if="dt && tab === 'orders'">
        <div class="row between"><b :class="sideClass(dt)" style="font-size:17px">{{ sideText(dt) }} · {{ symName(dt.symbol) }}</b><span class="pill" :class="stCls(dt)">{{ stText(dt) }}</span></div>
        <div class="card" style="margin:10px 0" v-if="dt.order_status === 'TRIGGER_FAILED'"><b class="down">失败原因：保证金不足</b><div class="note">触发时所需保证金 {{ dt.fail_detail && dt.fail_detail.required_margin_amount }} USDT，可用仅 {{ dt.fail_detail && dt.fail_detail.available_balance }} USDT，未能下单。委托已结束，不会再次触发。</div></div>
        <div class="grid2 num" style="margin:10px 0"><div class="cell"><small>委托类型</small>{{ label('order_type', dt.order_type) }}</div><div class="cell"><small>杠杆</small>{{ dt.leverage }}×</div><div class="cell"><small>委托价</small>{{ dt.price ? fmtPrice(dt.price, tk(dt.symbol)) : '市价' }}</div><div class="cell"><small>数量</small>{{ coinQty(dt.symbol, dt.quantity) }} {{ symBase(dt.symbol) }}</div><div class="cell"><small>已成交</small>{{ coinQty(dt.symbol, dt.filled_qty) }}</div><div class="cell"><small>成交均价</small>{{ num(dt.avg_fill_price) ? fmtPrice(dt.avg_fill_price, tk(dt.symbol)) : '--' }}</div><div class="cell"><small>手续费</small>{{ fmt(dt.fee_amount) }}</div><div class="cell"><small>订单号</small>{{ trimOid(dt.order_oid) }}</div></div>
        <div class="h-sec" style="padding:6px 0">委托时间线</div>
        <div v-for="(e, i) in dt.timeline" :key="i" class="row gap8" style="align-items:flex-start;padding-bottom:10px"><div style="width:8px;height:8px;border-radius:50%;background:var(--yellow);margin-top:5px;flex:none"></div><div><small class="mute num">{{ fmtTime(e.time, 'md') }}</small> <span>{{ e.text }}</span></div></div>
        <button class="btn ghost block" v-if="num(dt.filled_qty) > 0" @click="viewFills(dt)">查看成交</button>
      </template>
      <template v-else-if="dt && tab === 'ledger'">
        <small class="mute">{{ label('ledger_type', dt.ledger_type) }} · {{ dt.currency }}</small>
        <div class="num" :class="pnlClass(dt.ledger_amount)" style="font-size:26px;font-weight:800;margin-bottom:8px">{{ fmt(dt.ledger_amount, 2, { sign: true }) }} USDT</div>
        <div class="kv"><span>变动前可用</span><b class="num">{{ fmt(dt.before_balance) }}</b></div><div class="kv"><span>变动后可用</span><b class="num">{{ fmt(dt.after_balance) }}</b></div>
        <div class="kv" v-if="dt.symbol"><span>关联</span><b>{{ symName(dt.symbol) }}{{ dt.position_side ? ' ' + (dt.position_side === 'LONG' ? '多' : '空') + ' ' + dt.leverage + '×' : '' }}</b></div>
        <div class="kv" v-if="dt.liquidation_price"><span>强平价</span><b class="num">{{ dt.liquidation_price }}</b></div>
        <div class="kv"><span>时间</span><b class="num">{{ fmtTime(dt.create_time) }}</b></div><div class="kv"><span>流水号</span><b class="num">{{ trimOid(dt.ledger_oid) }}</b></div>
        <p class="note" style="margin-top:8px" v-if="dt.note">{{ dt.note }}</p>
        <div class="row gap8" style="margin-top:10px"><button class="btn ghost grow" v-for="k in dt.links" :key="k.type" @click="goLink(k)">{{ k.type === 'LIQUIDATION_DETAIL' ? '强平详情' : '历史持仓' }}</button></div>
      </template>
      <template #footer v-if="tab === 'pos' && dt"><button class="btn grow" @click="viewPosFills(dt)">查看成交</button><button class="btn primary grow" @click="detailSheet = false; go('/trade/' + dt.symbol)">再开一单</button></template>
    </Sheet>
  </div>`,

  setup() {
    const tab = ref(route.params.tab && TABS.some((x) => x.k === route.params.tab) ? route.params.tab : 'pos');
    if (tab.value === 'cur') { replace('/positions'); }
    const af = reactive(defaults()); const fl = reactive(defaults());
    const state = ref('loading'); const errMsg = ref(''); const list = ref([]); const summary = ref(null); const hasMore = ref(false); const more = ref(false);
    const page = ref(1); const cursor = ref('');
    const filterSheet = ref(false); const detailSheet = ref(false); const dt = ref(null); const detailBusy = ref(false);
    const fillsFilter = reactive({ order_oid: '', position_oid: '' });
    const tk = (s) => (store.symbols[s] ? store.symbols[s].price_tick : '0.01');
    const emptyText = computed(() => ({ pos: '近期没有历史持仓', orders: '近期没有历史委托', fills: '近期没有成交记录', ledger: '近期没有资金流水' }[tab.value]));
    const rangeText = computed(() => (af.days ? `近 ${af.days} 天` : `${af.start} ~ ${af.end}`));
    const rangeShort = computed(() => (af.days ? `近 ${af.days} 天` : '自定义'));
    const isFiltered = computed(() => !!(af.symbol || af.side || af.closeType || af.orderType || af.state || af.role || af.effect || af.ledgerType || af.days !== 7 || fillsFilter.order_oid || fillsFilter.position_oid));
    const summaryCount = computed(() => (tab.value === 'pos' ? summary.value && summary.value.close_count : tab.value === 'orders' ? summary.value && summary.value.history_stats && summary.value.history_stats.total : list.value.length));

    const timeRange = () => {
      if (af.days) return rangeOf(af.days);
      return { start: af.start ? new Date(af.start + 'T00:00:00').toISOString() : undefined, end: af.end ? new Date(af.end + 'T23:59:59').toISOString() : undefined };
    };
    const buildBody = () => {
      const r = timeRange(); const sym = af.symbol ? [af.symbol] : undefined;
      const pg = { pagination: { page: page.value, size: 20 } };
      if (tab.value === 'pos') return { ...pg, filters: { position_status: 'CLOSED', symbol: sym, position_side: af.side || undefined, close_type: af.closeType ? [af.closeType] : undefined, closed_time_start: r.start, closed_time_end: r.end }, sort_by: 'closed_time', order: 'desc' };
      if (tab.value === 'orders') {
        const [ps, pe] = af.side ? af.side.split('|') : [];
        const st = ORDER_STATES.find((x) => x.k === af.state);
        return { ...pg, filters: { scope: 'HISTORY', symbol: sym, order_type: af.orderType ? [af.orderType] : undefined, position_side: ps, position_effect: pe, ...(st ? st.f : {}), create_time_start: r.start, create_time_end: r.end }, sort_by: 'create_time', order: 'desc' };
      }
      if (tab.value === 'fills') return { pagination: { size: 20 }, cursor: cursor.value, filters: { symbol: sym, fill_role: af.role || undefined, position_effect: af.effect || undefined, order_oid: fillsFilter.order_oid || undefined, position_oid: fillsFilter.position_oid || undefined, fill_time_start: r.start, fill_time_end: r.end } };
      return { pagination: { size: 20 }, cursor: cursor.value, filters: { ledger_type: af.ledgerType ? [af.ledgerType] : undefined, currency: 'USDT', create_time_start: r.start, create_time_end: r.end } };
    };
    const fetcher = () => ({ pos: api.position.list, orders: api.order.list, fills: api.history.fills, ledger: api.history.ledgers }[tab.value]);
    let seq = 0;
    const reload = async () => {
      const my = ++seq; state.value = 'loading'; page.value = 1; cursor.value = '';
      try {
        const r = await fetcher()(buildBody());
        if (my !== seq) return;
        list.value = r.list; summary.value = r.summary || null; hasMore.value = r.pagination.has_more; cursor.value = r.pagination.next_cursor || ''; state.value = 'ok';
      } catch (e) { if (my === seq) { errMsg.value = e.msg || '请稍后重试'; state.value = 'error'; } }
    };
    const loadMore = async () => {
      more.value = true;
      try {
        page.value += 1;
        const r = await fetcher()(buildBody());
        list.value = list.value.concat(r.list); hasMore.value = r.pagination.has_more; cursor.value = r.pagination.next_cursor || '';
      } catch (e) { page.value -= 1; toast(e.msg || '加载失败', 'err'); } finally { more.value = false; }
    };
    onMounted(async () => { if (!store.symbolList.length) { await loadSymbols(); await loadTickers(); } if (tab.value !== 'cur') reload(); });

    const switchTab = (k) => {
      if (k === 'cur') { go('/positions'); return; }
      if (k === tab.value) return;
      tab.value = k; Object.assign(af, defaults()); Object.assign(fl, defaults()); fillsFilter.order_oid = fillsFilter.position_oid = ''; list.value = []; summary.value = null;
      history.replaceState(null, '', '#/history/' + k); reload();
    };
    const openFilter = () => { Object.assign(fl, af); filterSheet.value = true; };
    const applyFilter = () => { Object.assign(af, fl); filterSheet.value = false; reload(); };
    const clearFilter = () => { Object.assign(af, defaults()); Object.assign(fl, defaults()); fillsFilter.order_oid = fillsFilter.position_oid = ''; reload(); };

    // 详情
    const detailTitle = computed(() => ({ pos: '持仓详情', orders: '委托详情', ledger: '流水详情' }[tab.value] || '详情'));
    const openDetail = async (row) => {
      dt.value = null; detailSheet.value = true; detailBusy.value = true;
      try {
        if (tab.value === 'pos') dt.value = await api.position.detail(row.position_oid);
        else if (tab.value === 'orders') dt.value = await api.order.detail(row.order_oid);
        else dt.value = await api.history.ledger(row.ledger_oid);
      } catch (e) { toast(e.msg || '详情加载失败', 'err'); detailSheet.value = false; } finally { detailBusy.value = false; }
    };
    const switchToFills = (extra) => { detailSheet.value = false; tab.value = 'fills'; Object.assign(af, defaults(), { days: 90 }); Object.assign(fl, af); fillsFilter.order_oid = extra.order_oid || ''; fillsFilter.position_oid = extra.position_oid || ''; history.replaceState(null, '', '#/history/fills'); reload(); };
    const viewFills = (o) => switchToFills({ order_oid: o.order_oid });
    const viewPosFills = (p) => switchToFills({ position_oid: p.position_oid });
    const goLink = (k) => { detailSheet.value = false; if (k.type === 'LIQUIDATION_DETAIL') go('/liq/' + k.position_oid); else switchTab('pos'); };

    const stText = (o) => (o.cancel_reason === 'EXPIRED' ? '已过期' : o.is_triggered && o.order_status === 'FILLED' ? '已触发' : label('order_status', o.order_status));
    const stCls = (o) => (o.order_status === 'FILLED' ? 'up' : o.order_status === 'TRIGGER_FAILED' ? 'down' : o.is_triggered ? 'yellow' : '');

    return { TABS, RANGES, CLOSE_TYPES, ORDER_TYPES, ORDER_STATES, SIDES, LEDGER_TYPES, LEDGER_ICON, tab, af, fl, state, errMsg, list, summary, hasMore, more, filterSheet, detailSheet, dt, detailBusy, emptyText, rangeText, rangeShort, isFiltered, summaryCount, detailTitle,
      reload, loadMore, switchTab, openFilter, applyFilter, clearFilter, openDetail, viewFills, viewPosFills, goLink, stText, stCls, tk, defaults, store,
      go, fmt, fmtPct, fmtPrice, fmtTime, symName, symBase, num, label, sideText, sideClass, pnlClass, trimOid, coinQty };
  },
};
