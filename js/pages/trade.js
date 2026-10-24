// ③~⑨ 交易页：限价 / 市价 / 止盈止损 / 移动止盈止损 / 计划委托 / 冰山委托 + 杠杆 / 保证金模式 / 最优价 / 下单确认
import { ui } from './_ui.js';
import { go, route } from '../router.js';
import * as api from '../api/index.js';
import { ws } from '../api/ws.js';
import { newIdemKey } from '../api/client.js';
import { store, loadSymbols, loadTickers, loadSymbolDetail, useTickers, refreshAccount, livePosition, toast, coinQty, csizeOf } from '../store.js';
import { fmt, fmtPct, fmtPrice, fmtCountdown, symName, symBase, num, pnlClass, label, decimalsOf, sideText, sideClass } from '../lib/format.js';
import * as C from '../lib/calc.js';
import { getDefaultSymbol, setDefaultSymbol } from './_shared.js';

const { ref, reactive, computed, watch, onMounted, onBeforeUnmount } = Vue;

const TYPES = [
  { k: 'LIMIT', t: '限价委托', d: '指定价格挂单，达到或优于该价格时成交' },
  { k: 'MARKET', t: '市价委托', d: '以对手盘最优价立即成交，可能产生滑点' },
  { k: 'TPSL', t: '止盈止损', d: '为持仓预设止盈价与止损价，触发后自动平仓' },
  { k: 'TRAILING', t: '移动止盈止损', d: '止损线随盈利方向跟随移动，锁定已有利润' },
  { k: 'CONDITIONAL', t: '计划委托', d: '价格达到触发价后，才按预设参数下单' },
  { k: 'ICEBERG', t: '冰山委托', d: '大单自动拆成小单陆续挂出，减少盘口冲击' },
];
const BBO = [
  { k: 'MANUAL', t: '最优价', d: '按盘口实时价格自动填价，下单瞬间取价', off: true },
  { k: 'COUNTER_1', t: '对手价 1', d: '买入取卖一价、卖出取买一价，优先成交' },
  { k: 'COUNTER_5', t: '对手价 5', d: '取对手方第 5 档价格，成交更快，价差更大' },
  { k: 'SAME_1', t: '同向价 1', d: '买入取买一价、卖出取卖一价，挂单排队' },
  { k: 'SAME_5', t: '同向价 5', d: '取同方向第 5 档价格，排队靠后' },
];

export const Trade = {
  components: ui,
  template: `
  <div class="page">
    <div class="tr-top">
      <button class="icon-btn" aria-label="返回" @click="go('/markets')"><Icon name="back"/></button>
      <button class="sym" @click="symSheet = true">{{ symName(symbol) }} <span class="pill">永续</span><span :class="chgCls" style="font-size:12px">{{ t ? fmtPct(t.price_change_rate, 2, { sign: true }) : '' }}</span><Icon name="chevron" :size="14"/></button>
      <span class="grow"></span>
      <button class="icon-btn" aria-label="K 线" @click="go('/kline/' + symbol)"><Icon name="chart"/></button>
      <button class="icon-btn" aria-label="合约信息" @click="go('/info/' + symbol)"><Icon name="info"/></button>
    </div>
    <div class="banner err" v-if="offline"><span>●</span> 网络连接已断开，正在重连… 暂时无法下单（数据已暂停）</div>
    <div class="banner warn" v-else-if="delaySec >= 3"><span>●</span> 行情延迟 {{ delaySec.toFixed(1) }} 秒，价格可能不是最新，请谨慎下单</div>
    <div class="scroll">
      <div class="tr-price">
        <div><div class="p num" :class="chgCls">{{ t ? fmtPrice(t.last_price, tick) : '--' }}</div><small>最新价 · 实时行情</small></div>
        <div class="tr-meta num" v-if="t">
          <div>标记价 <b>{{ fmtPrice(t.mark_price, tick) }}</b></div>
          <div>指数价 <b>{{ fmtPrice(t.index_price, tick) }}</b></div>
          <div>资金费率 <b>{{ fmtPct(t.funding_rate, 4) }} / {{ countdown }}</b></div>
        </div>
      </div>

      <div class="tr-main">
        <div class="tr-form">
          <div class="sel">
            <button @click="marginSheet = true">{{ settings ? '逐仓' : '逐仓' }}<Icon name="chevron" :size="12"/></button>
            <button @click="openLev"><span class="num">{{ lev }}×</span><Icon name="chevron" :size="12"/></button>
          </div>
          <button class="type-btn" @click="typeSheet = true"><span>{{ typeObj.t }}</span><span class="row gap4"><Icon name="info" :size="14"/><Icon name="chevron" :size="14"/></span></button>

          <template v-if="type === 'CONDITIONAL'">
            <div class="inp" :class="{ err: !!errs.trigger_price }"><span class="lab">触发价</span><input :value="f.trigger" placeholder="标记价触发" inputmode="decimal" @input="onNum('trigger', $event, priceDp)"><span class="suf">USDT</span></div>
            <span class="err-t" v-if="errs.trigger_price" style="margin-top:-4px;margin-bottom:6px">{{ errs.trigger_price }}</span>
            <div class="seg" style="margin-bottom:8px"><button :class="{ on: f.execType === 'LIMIT' }" @click="f.execType = 'LIMIT'">限价</button><button :class="{ on: f.execType === 'MARKET' }" @click="f.execType = 'MARKET'">市价</button></div>
          </template>
          <!-- 价格 -->
          <template v-if="showPrice">
            <div class="inp" :class="{ err: !!errs.price }">
              <span class="lab">{{ priceLabel }}</span>
              <input :value="bboOn ? '' : f.price" :placeholder="bboOn ? bboLabel : '价格'" :disabled="bboOn" inputmode="decimal" @input="onNum('price', $event, priceDp)">
              <button class="bbo" :class="{ on: bboOn }" @click="bboSheet = true" v-if="type === 'LIMIT'">{{ bboOn ? bboLabel : '最优价' }}</button>
              <span class="suf mute" v-else>USDT</span>
            </div>
            <span class="err-t" v-if="errs.price" style="margin-top:-4px;margin-bottom:6px">{{ errs.price }}</span>
          </template>
          <div class="note" v-if="type === 'MARKET'" style="padding:8px 2px 10px;font-size:12px">市价 · 以对手盘最优价成交</div>

          <!-- 依附持仓类型 -->
          <template v-if="isPosType">
            <div class="empty" v-if="!posOptions.length" style="padding:20px 6px"><div class="ei">⌖</div><b>{{ type === 'TPSL' ? '止盈止损需基于已有持仓设置，请先开仓' : '移动止盈止损需基于已有持仓设置，请先开仓' }}</b></div>
            <template v-else>
              <div class="note" style="margin:0 0 6px">基于持仓设置 · 强平价 <b class="num sub">{{ pos ? fmtPrice(pos.liquidation_price, tick) : '--' }}</b></div>
              <div class="sel" v-if="posOptions.length > 1"><button v-for="p in posOptions" :key="p.position_oid" :style="p.position_oid === f.posOid ? 'color:var(--yellow)' : ''" @click="f.posOid = p.position_oid">{{ p.position_side === 'LONG' ? '多' : '空' }}</button></div>
              <div class="note num" style="margin-bottom:8px" v-if="pos"><span :class="pos.position_side === 'LONG' ? 'up' : 'down'">{{ pos.position_side === 'LONG' ? '多' : '空' }}</span> · {{ coinQty(symbol, pos.position_qty) }} {{ base }} @ {{ fmtPrice(pos.avg_price, tick) }}</div>
            </template>
          </template>
          <template v-if="type === 'TPSL' && posOptions.length">
            <div class="inp" :class="{ err: !!errs.tp }"><span class="lab">止盈</span><input :value="f.tp" placeholder="触发价（标记价）" inputmode="decimal" @input="onNum('tp', $event, priceDp)"><span class="suf">USDT</span></div>
            <span class="err-t" v-if="errs.tp" style="margin-top:-4px;margin-bottom:6px">{{ errs.tp }}</span>
            <div class="inp" :class="{ err: !!errs.sl }"><span class="lab">止损</span><input :value="f.sl" placeholder="触发价（标记价）" inputmode="decimal" @input="onNum('sl', $event, priceDp)"><span class="suf">USDT</span></div>
            <span class="err-t" v-if="errs.sl" style="margin-top:-4px;margin-bottom:6px">{{ errs.sl }}</span>
            <span class="warn-t" v-if="warnList.length" v-for="w in warnList" :key="w.code" style="margin-top:-4px;margin-bottom:6px">{{ w.msg }}</span>
          </template>
          <template v-if="type === 'TRAILING' && posOptions.length">
            <div class="seg" style="margin-bottom:8px"><button :class="{ on: f.trailMode === 'RATE' }" @click="f.trailMode = 'RATE'">回撤比例</button><button :class="{ on: f.trailMode === 'VALUE' }" @click="f.trailMode = 'VALUE'">固定价差</button></div>
            <div class="inp"><span class="lab">激活价</span><input :value="f.trailAct" placeholder="选填，默认立即激活" inputmode="decimal" @input="onNum('trailAct', $event, priceDp)"><span class="suf">USDT</span></div>
            <div class="inp" :class="{ err: !!errs.trailing }"><span class="lab">回撤</span><input :value="f.trailCb" :placeholder="f.trailMode === 'RATE' ? '0.1 ~ 10' : '价差'" inputmode="decimal" @input="onNum('trailCb', $event, 2)"><span class="suf">{{ f.trailMode === 'RATE' ? '%' : 'USDT' }}</span></div>
            <span class="err-t" v-if="errs.trailing" style="margin-top:-4px;margin-bottom:6px">{{ errs.trailing }}</span>
            <span class="warn-t" v-else-if="trailSmall" style="margin-top:-4px;margin-bottom:6px">回撤幅度最小 0.1%，过小会被正常波动频繁触发</span>
          </template>

          <!-- 数量 -->
          <template v-if="showQty">
            <div class="inp" :class="{ err: !!errs.quantity }">
              <span class="lab">{{ type === 'ICEBERG' ? '总数量' : isPosType ? '平仓数量' : '数量' }}</span>
              <input :value="f.qty" :placeholder="isPosType ? '默认全部仓位' : '数量'" inputmode="decimal" @input="onNum('qty', $event, qtyDp); f.pct = 0">
              <span class="suf">{{ base }}</span>
            </div>
            <span class="err-t" v-if="errs.quantity" style="margin-top:-4px;margin-bottom:6px">{{ errs.quantity }}</span>
          </template>
          <template v-if="type === 'ICEBERG'">
            <div class="inp" :class="{ err: !!errs.iceberg }"><span class="lab">单次显示</span><input :value="f.visible" placeholder="单次显示数量" inputmode="decimal" @input="onNum('visible', $event, qtyDp)"><span class="suf">{{ base }}</span></div>
            <span class="err-t" v-if="errs.iceberg" style="margin-top:-4px;margin-bottom:6px">{{ errs.iceberg }}</span>
            <div class="note" v-else-if="sliceTotal" style="margin:-2px 0 8px">拆单预览 · 共 {{ sliceTotal }} 笔，每笔 {{ f.visible }} {{ base }}，前一笔全部成交后自动挂下一笔</div>
          </template>
          <div class="pct-row" v-if="showQty && !isPosType" style="margin-bottom:8px"><button v-for="p in [25, 50, 75, 100]" :key="p" :class="{ on: f.pct === p }" @click="setPct(p)">{{ p }}%</button></div>
          <span class="warn-t" v-for="w in warnList" :key="w.code" v-if="type !== 'TPSL' && warnList.length" style="margin:-2px 0 8px">{{ w.msg }}</span>

          <div class="tr-info" v-if="!isPosType">
            <div class="kv"><span>可用</span><span>{{ acc ? fmt(acc.available_balance) : '--' }} USDT</span></div>
            <div class="kv"><span>可开</span><span>{{ pv ? coinQty(symbol, pv.max_open_qty) : '--' }} {{ base }}</span></div>
            <div class="kv"><span>{{ type === 'CONDITIONAL' ? '触发后预估保证金' : type === 'MARKET' ? '预估保证金' : '所需保证金' }}</span><span>{{ type === 'MARKET' ? '≈ ' : '' }}{{ pv && f.qty ? fmt(pv.required_margin_amount) : '--' }} USDT</span></div>
          </div>
          <div class="tr-info" v-else-if="posOptions.length">
            <div class="kv"><span>可用</span><span>{{ acc ? fmt(acc.available_balance) : '--' }} USDT</span></div>
            <div class="kv" v-if="type === 'TPSL'"><span>触发后</span><span>市价平仓 · 二者互斥</span></div>
            <div class="kv" v-if="type === 'TPSL' && pv && pv.est_pnl_tp"><span>预计盈利</span><span class="up">{{ fmt(pv.est_pnl_tp, 2, { sign: true }) }} USDT ({{ fmtPct(pv.est_pnl_rate_tp, 1, { sign: true }) }})</span></div>
            <div class="kv" v-if="type === 'TPSL' && pv && pv.est_pnl_sl"><span>预计亏损</span><span class="down">{{ fmt(pv.est_pnl_sl, 2, { sign: true }) }} USDT ({{ fmtPct(pv.est_pnl_rate_sl, 1, { sign: true }) }})</span></div>
            <div class="kv" v-if="type === 'TRAILING'"><span>锚点最高价 / 预估触发</span><span>{{ pv && pv.trailing_anchor_price ? fmtPrice(pv.trailing_anchor_price, tick) + ' / ' + fmtPrice(pv.trailing_est_trigger_price, tick) : '--' }}</span></div>
          </div>

          <template v-if="isPosType">
            <button class="btn primary block" :disabled="busy || offline || !posOptions.length" @click="submitPos"><span class="spin" v-if="busy"></span>确认设置</button>
          </template>
          <div class="row gap8" v-else>
            <button class="btn up grow" :disabled="busy || offline" @click="submit('LONG')">开多</button>
            <button class="btn down grow" :disabled="busy || offline" @click="submit('SHORT')">开空</button>
          </div>
        </div>

        <div class="book" v-if="book">
          <div class="bh"><span>价格</span><span>数量</span></div>
          <div class="bl ask" v-for="r in asks" :key="'a' + r.price" @click="pick(r.price)"><i :style="{ width: r.w + '%' }"></i><span class="bp">{{ fmtPrice(r.price, tick) }}</span><span>{{ r.q }}</span></div>
          <div class="mid"><b class="num" :class="chgCls">{{ t ? fmtPrice(t.last_price, tick) : '--' }}</b><small>标记 {{ t ? fmtPrice(t.mark_price, tick) : '--' }}</small></div>
          <div class="bl bid" v-for="r in bids" :key="'b' + r.price" @click="pick(r.price)"><i :style="{ width: r.w + '%' }"></i><span class="bp">{{ fmtPrice(r.price, tick) }}</span><span>{{ r.q }}</span></div>
        </div>
        <div v-else class="skel" style="height:330px"></div>
      </div>

      <div class="tr-bottom">
        <div class="tabs"><button :class="{ on: bt === 'pos' }" @click="bt = 'pos'">持仓 ({{ positions.length }})</button><button :class="{ on: bt === 'ord' }" @click="bt = 'ord'">当前委托 ({{ orderTotal }})</button><button @click="go('/history')">历史</button></div>
        <template v-if="bt === 'pos'">
          <div class="empty" v-if="!positions.length" style="padding:28px"><div class="ei">▭</div><span>当前没有持仓</span></div>
          <div class="pos-mini" v-for="p in positions" :key="p.position_oid" @click="go('/positions')">
            <div class="row between"><div class="row gap8"><SideTag :side="p.position_side"/><b>{{ symName(p.symbol) }}</b><span class="pill">逐仓 {{ p.leverage }}×</span></div><b class="num" :class="pnlClass(p.unrealized_pnl_amount)">{{ fmt(p.unrealized_pnl_amount, 2, { sign: true }) }} USDT</b></div>
            <div class="row between note num" style="margin-top:4px"><span>强平价 <b class="sub">{{ fmtPrice(p.liquidation_price, tick) }}</b></span><span>距强平 <b :class="'risk-' + p.risk_level">{{ fmtPct(p.distance_to_liq_rate, 1) }}</b></span></div>
          </div>
        </template>
        <template v-else>
          <div class="empty" v-if="!orders.length" style="padding:28px"><div class="ei">▭</div><span>当前没有委托</span></div>
          <div class="pos-mini" v-for="o in orders" :key="o.order_oid" @click="go('/orders')">
            <div class="row between"><div class="row gap8"><b :class="sideClass(sideObj(o))">{{ sideText(sideObj(o)) }}</b><b>{{ symName(o.symbol) }}</b><span class="pill">{{ label('order_type', o.order_type) }}</span></div><span class="pill warn">{{ label('order_status', o.order_status) }}</span></div>
            <div class="note num" style="margin-top:4px">{{ o.price ? fmtPrice(o.price, tick) : o.type_param || '市价' }} × {{ coinQty(o.symbol, o.quantity) }} {{ symBase(o.symbol) }}</div>
          </div>
          <div class="more" v-if="orderTotal > orders.length"><a class="link" @click="go('/orders')">查看全部 {{ orderTotal }} 笔委托 ›</a></div>
        </template>
      </div>
    </div>

    <!-- 委托类型 -->
    <Sheet v-model="typeSheet" title="委托类型">
      <div v-for="x in TYPES" :key="x.k" class="row between" style="padding:12px 0;border-bottom:1px solid var(--line2)" @click="pickType(x.k)">
        <div><b :class="{ yellow: type === x.k }">{{ x.t }}</b><div class="note">{{ x.d }}</div></div><span v-if="type === x.k" class="yellow">✓</span>
      </div>
      <p class="note" style="margin-top:10px">· 委托价不能偏离最新价超过 ±5%<br>· 止盈止损、移动止盈止损必须基于已有持仓<br>· 计划委托触发时若保证金不足，委托记为「触发失败」</p>
    </Sheet>

    <!-- 最优价 -->
    <Sheet v-model="bboSheet" title="价格模式">
      <div v-for="x in BBO" :key="x.k" class="row between" style="padding:12px 0;border-bottom:1px solid var(--line2)" @click="pickBbo(x.k)">
        <div><b :class="{ yellow: (f.src === x.k) }">{{ x.t }}</b><div class="note">{{ x.d }}</div></div>
        <span class="num sub" v-if="!x.off">{{ bboPreview(x.k) }}</span><span class="yellow" v-else-if="f.src === 'MANUAL'">✓</span>
      </div>
      <p class="note" style="margin-top:10px">再次点击「最优价」可切回手动输入价格</p>
    </Sheet>

    <!-- 保证金模式 -->
    <Sheet v-model="marginSheet" title="保证金模式">
      <div class="card" style="border:1px solid var(--yellow);margin-bottom:10px"><div class="row between"><b>逐仓</b><span class="yellow">✓</span></div><div class="note">每个仓位单独分配保证金，强平时最多损失该仓位的保证金，不影响账户其他资金。可在持仓中手动增减保证金。</div></div>
      <div class="card" style="opacity:.55;margin-bottom:10px"><div class="row between"><b>全仓</b><span class="pill">暂未开放</span></div><div class="note">所有仓位共用账户可用余额作为保证金，盈亏可相互抵补，但极端行情可能损失全部余额。</div></div>
      <p class="note">· 本期仅支持逐仓，全仓暂不可选<br>· 该交易对存在持仓或挂单时不可切换保证金模式</p>
      <template #footer><button class="btn primary block" @click="marginSheet = false">我知道了</button></template>
    </Sheet>

    <!-- 杠杆 -->
    <Sheet v-model="levSheet" title="调整杠杆">
      <p class="note" style="margin:0 0 12px">{{ symName(symbol) }} 永续 · 逐仓 · 对该交易对的新开仓与已有持仓生效</p>
      <div class="row between" style="margin-bottom:12px"><button class="icon-btn" @click="stepLev(-1)">−</button><b class="num" style="font-size:28px">{{ levDraft }}×</b><button class="icon-btn" @click="stepLev(1)">+</button></div>
      <div class="grid4" style="margin-bottom:12px"><button class="chip" v-for="n in levPresets" :key="n" :class="{ on: levDraft === n }" style="justify-content:center" @click="levDraft = n; levCalc()">{{ n }}×</button></div>
      <div class="kv"><span>当前杠杆最大可开</span><span class="num">{{ levPv ? coinQty(symbol, levPv.max_open_qty) : '--' }} {{ base }}</span></div>
      <div class="kv"><span>对应档位 · 名义价值上限</span><span class="num">≤ {{ levTier ? fmt(levTier.position_value_upper, 0) : '--' }} USDT</span></div>
      <div class="kv"><span>当前持仓 + 挂单名义价值</span><span class="num">{{ settings ? fmt(settings.current_notional_amount, 0) : '--' }} USDT</span></div>
      <span class="err-t" v-if="levErr">{{ levErr }}</span>
      <span class="warn-t" v-else-if="levDraft >= 75">高杠杆风险：{{ levDraft }}× 下价格反向波动约 {{ (100 / levDraft).toFixed(1) }}% 即可能触发强平。请谨慎使用高杠杆。</span>
      <template #footer><button class="btn primary block" :disabled="!!levErr || levBusy" @click="applyLev">确认</button></template>
    </Sheet>

    <!-- 下单确认 -->
    <Sheet v-model="confirmSheet" title="确认下单">
      <template v-if="cf">
        <div class="row between" style="margin-bottom:8px"><b :class="cf.side === 'LONG' ? 'up' : 'down'" style="font-size:18px">{{ cf.side === 'LONG' ? '开多' : '开空' }}</b><span class="pill yellow">{{ cf.title }}</span></div>
        <div class="kv"><span>合约</span><b>{{ symName(symbol) }} 永续</b></div>
        <div class="kv"><span>委托价格</span><b class="num">{{ cf.priceText }}</b></div>
        <div class="kv"><span>数量</span><b class="num">{{ f.qty }} {{ base }}</b></div>
        <div class="kv" v-if="cf.extra" v-for="x in cf.extra" :key="x[0]"><span>{{ x[0] }}</span><b class="num">{{ x[1] }}</b></div>
        <div class="kv"><span>杠杆</span><b class="num">逐仓 {{ lev }}×</b></div>
        <div class="kv"><span>所需保证金</span><b class="num">{{ cf.margin }} USDT</b></div>
        <div class="kv"><span>预估强平价</span><b class="num">{{ cf.liq }}</b></div>
        <div class="kv"><span>手续费率</span><b class="num">Maker {{ fmtPct(sym && sym.maker_fee_rate, 2) }} / Taker {{ fmtPct(sym && sym.taker_fee_rate, 2) }}</b></div>
        <span class="warn-t" v-for="w in cf.warnings" :key="w.code">{{ w.msg }}</span>
        <div class="row gap8" style="margin-top:12px" @click="noAsk = !noAsk"><span class="check" :class="{ on: noAsk }"></span><span class="note">不再提示（可在「我的 · 交易设置」中重新开启）</span></div>
      </template>
      <template #footer>
        <button class="btn grow" @click="confirmSheet = false">取消</button>
        <button class="btn grow" :class="cf && cf.side === 'LONG' ? 'up' : 'down'" :disabled="busy" @click="doSubmit"><span class="spin" v-if="busy"></span>{{ cf && cf.side === 'LONG' ? '确认开多' : '确认开空' }}</button>
      </template>
    </Sheet>

    <!-- 切换合约 -->
    <Sheet v-model="symSheet" title="选择合约">
      <div class="row between" v-for="s in store.symbolList" :key="s.symbol" style="padding:12px 0;border-bottom:1px solid var(--line2)" @click="switchSym(s.symbol)">
        <b :class="{ yellow: s.symbol === symbol }">{{ symName(s.symbol) }} <span class="pill">永续</span></b>
        <span class="num sub">{{ store.tickers[s.symbol] ? fmtPrice(store.tickers[s.symbol].last_price, s.price_tick) : '--' }}</span>
      </div>
    </Sheet>
  </div>`,

  setup() {
    const symbol = ref(route.params.symbol || getDefaultSymbol());
    setDefaultSymbol(symbol.value);
    const type = ref('LIMIT');
    const f = reactive({ price: '', src: 'MANUAL', qty: '', pct: 0, trigger: '', execType: 'LIMIT', visible: '', tp: '', sl: '', trailMode: 'RATE', trailCb: '', trailAct: '', posOid: '' });
    const errs = reactive({});
    const warnList = ref([]);
    const pv = ref(null);
    const settings = ref(null);
    const bt = ref('pos');
    const positions = ref([]); const orders = ref([]); const orderTotal = ref(0);
    const book = ref(null);
    const busy = ref(false);
    const typeSheet = ref(false); const bboSheet = ref(false); const marginSheet = ref(false); const levSheet = ref(false); const confirmSheet = ref(false); const symSheet = ref(false);
    const cf = ref(null); const noAsk = ref(false);
    const levDraft = ref(20); const levErr = ref(''); const levPv = ref(null); const levBusy = ref(false);
    const now = ref(Date.now());

    const sym = computed(() => store.symbols[symbol.value]);
    const t = computed(() => store.tickers[symbol.value]);
    const acc = computed(() => store.account);
    const base = computed(() => symBase(symbol.value));
    const tick = computed(() => (sym.value ? sym.value.price_tick : '0.01'));
    const priceDp = computed(() => decimalsOf(tick.value));
    const qtyDp = computed(() => (sym.value ? sym.value.qty_scale : 3));
    const csz = computed(() => csizeOf(symbol.value));
    const lev = computed(() => (settings.value ? settings.value.leverage : 20));
    const typeObj = computed(() => TYPES.find((x) => x.k === type.value));
    const isPosType = computed(() => ['TPSL', 'TRAILING'].includes(type.value));
    const showPrice = computed(() => type.value === 'LIMIT' || type.value === 'ICEBERG' || (type.value === 'CONDITIONAL' && f.execType === 'LIMIT'));
    const priceLabel = computed(() => (type.value === 'CONDITIONAL' ? '委托价' : '价格'));
    const bboOn = computed(() => f.src !== 'MANUAL' && type.value === 'LIMIT');
    const bboLabel = computed(() => (BBO.find((x) => x.k === f.src) || {}).t);
    const chgCls = computed(() => (t.value ? (num(t.value.price_change_rate) >= 0 ? 'up' : 'down') : ''));
    const offline = computed(() => ws.state.offline);
    const delaySec = computed(() => (t.value && !offline.value ? Math.max(0, (now.value - new Date(t.value.ticker_time).getTime()) / 1000) : 0));
    const countdown = computed(() => (t.value ? fmtCountdown(t.value.next_funding_time, now.value) : '--:--:--'));
    const posOptions = computed(() => positions.value.filter((p) => p.symbol === symbol.value));
    const pos = computed(() => posOptions.value.find((p) => p.position_oid === f.posOid) || posOptions.value[0]);
    const trailSmall = computed(() => f.trailMode === 'RATE' && num(f.trailCb) > 0 && num(f.trailCb) < 0.1);
    const sliceTotal = computed(() => (num(f.qty) > 0 && num(f.visible) > 0 && num(f.visible) <= num(f.qty) ? Math.ceil(num(f.qty) / num(f.visible) - 1e-9) : 0));
    const levPresets = computed(() => [1, 25, 50, 75, 100, 125].filter((n) => !sym.value || n <= sym.value.max_leverage));
    const levTier = computed(() => (sym.value && sym.value.tiers ? C.tierOf(sym.value.tiers.map((x) => ({ ...x, position_value_upper: Number(x.position_value_upper) })), (settings.value ? num(settings.value.current_notional_amount) : 0)) : null));

    // ---------- 盘口 ----------
    const bookRows = computed(() => {
      if (!book.value) return { asks: [], bids: [] };
      const mk = (arr, rev) => {
        const rows = arr.slice(0, 7).map((x) => ({ price: x.price, qty: num(x.quantity) }));
        const max = Math.max(...rows.map((r) => r.qty), 1e-9);
        const out = rows.map((r) => ({ price: r.price, q: r.qty.toFixed(qtyDp.value), w: Math.round((r.qty / max) * 100) }));
        return rev ? out.reverse() : out;
      };
      return { asks: mk(book.value.asks, true), bids: mk(book.value.bids, false) };
    });
    const asks = computed(() => bookRows.value.asks); const bids = computed(() => bookRows.value.bids);
    const pick = (p) => { if (type.value === 'TPSL' || type.value === 'TRAILING') return; if (type.value === 'MARKET' || type.value === 'CONDITIONAL' && f.execType === 'MARKET') return; f.src = 'MANUAL'; f.price = p; };
    const bboPreview = (k) => {
      if (!book.value || k === 'MANUAL') return '';
      const buy = true; const idx = k.endsWith('_5') ? 4 : 0;
      const side = (k.startsWith('COUNTER') ? book.value.asks : book.value.bids)[idx];
      return side ? fmtPrice(side.price, tick.value) : '';
    };

    // ---------- 数据加载 ----------
    let aborter = null;
    const loadSide = async () => {
      try {
        const [ps, os] = await Promise.all([
          api.position.list({ filters: { position_status: 'OPEN' }, pagination: { page: 1, size: 50 } }),
          api.order.list({ filters: { scope: 'CURRENT' }, pagination: { page: 1, size: 3 }, sort_by: 'create_time', order: 'desc' }),
        ]);
        positions.value = ps.list.filter((p) => p.symbol === symbol.value).map(livePosition);
        allPositions.value = ps.list;
        orders.value = os.list.filter((o) => o.symbol === symbol.value).slice(0, 3);
        orderTotal.value = os.summary ? os.summary.current_total : os.list.length;
        if (!f.posOid && posOptions.value.length) f.posOid = posOptions.value[0].position_oid;
      } catch (e) { /* 静默：底部列表失败不阻塞下单 */ }
    };
    const allPositions = ref([]);
    const loadSettings = async () => { try { settings.value = await api.order.settings(symbol.value); levDraft.value = settings.value.leverage; } catch (e) { /* 忽略 */ } };
    const loadBook = async () => { try { book.value = await api.market.depth(symbol.value); } catch (e) { /* 忽略 */ } };

    let unsubs = [];
    onMounted(async () => {
      if (!store.symbolList.length) { await loadSymbols(); await loadTickers(); }
      loadSymbolDetail(symbol.value);
      refreshAccount(); loadSettings(); loadBook(); loadSide();
      unsubs.push(ws.subscribe(`depth.${symbol.value}`, (m) => { book.value = m.data; }));
      unsubs.push(ws.subscribe(`ticker.${symbol.value}`, (m) => { store.tickers[symbol.value] = m.data; }));
    });
    const clock = setInterval(() => { now.value = Date.now(); }, 1000);
    onBeforeUnmount(() => { unsubs.forEach((u) => u()); clearInterval(clock); clearTimeout(pvTimer); });
    useTickers(() => store.symbolList.map((s) => s.symbol));
    watch(() => [store.rev.orders, store.rev.positions], () => { loadSide(); loadSettings(); });
    // 持仓里的未实现盈亏跟随 ticker 重算
    watch(() => t.value && t.value.mark_price, () => { positions.value = positions.value.map(livePosition); });

    // ---------- 输入 ----------
    const onNum = (key, e, dp) => {
      let v = e.target.value.replace(/[^\d.]/g, '');
      const i = v.indexOf('.');
      if (i >= 0) v = v.slice(0, i + 1) + v.slice(i + 1).replace(/\./g, '').slice(0, dp);
      e.target.value = v; f[key] = v; delete errs[errKey(key)];
      if (key === 'price') f.src = 'MANUAL';
    };
    const errKey = (k) => ({ price: 'price', trigger: 'trigger_price', qty: 'quantity', visible: 'iceberg', tp: 'tp', sl: 'sl', trailCb: 'trailing' }[k] || k);
    const lots = (coin) => Math.floor(num(coin) / csz.value + 1e-9);
    const setPct = (p) => {
      f.pct = p;
      if (!pv.value) return;
      const maxLots = num(pv.value.max_open_qty);
      f.qty = (Math.floor((maxLots * p) / 100) * csz.value).toFixed(qtyDp.value);
      if (num(f.qty) <= 0) f.qty = '';
    };
    const pickType = (k) => { type.value = k; typeSheet.value = false; Object.keys(errs).forEach((x) => delete errs[x]); pv.value = null; f.qty = ''; f.pct = 0; schedulePreview(); };
    const pickBbo = (k) => { f.src = f.src === k && k !== 'MANUAL' ? 'MANUAL' : k; bboSheet.value = false; schedulePreview(); };

    // ---------- 预估（防抖 300ms） ----------
    let pvTimer = null; let pvSeq = 0;
    const buildReq = (side = 'LONG') => {
      const r = { symbol: symbol.value, order_type: type.value, position_side: side, position_effect: 'OPEN', leverage: lev.value };
      const q = lots(f.qty);
      if (q > 0) r.quantity = String(q);
      if (type.value === 'LIMIT' || type.value === 'ICEBERG') { if (bboOn.value) r.price_source = f.src; else if (f.price) r.price = f.price; }
      if (type.value === 'CONDITIONAL') { r.triggered_order_type = f.execType; if (f.trigger) r.trigger_price = f.trigger; if (f.execType === 'LIMIT' && f.price) r.price = f.price; }
      if (type.value === 'ICEBERG' && f.visible) r.iceberg_visible_qty = String(lots(f.visible));
      if (isPosType.value && pos.value) { r.position_side = pos.value.position_side; r.position_effect = 'CLOSE'; r.position_oid = pos.value.position_oid; r.leverage = pos.value.leverage; }
      if (type.value === 'TPSL') { if (f.tp) r.tp_trigger_price = f.tp; if (f.sl) r.sl_trigger_price = f.sl; }
      if (type.value === 'TRAILING') { r.trailing_mode = f.trailMode; if (f.trailCb) r.trailing_callback_value = f.trailMode === 'RATE' ? String(num(f.trailCb) / 100) : f.trailCb; if (f.trailAct) r.trailing_activation_price = f.trailAct; }
      return r;
    };
    const schedulePreview = () => { clearTimeout(pvTimer); pvTimer = setTimeout(runPreview, 300); };
    const runPreview = async () => {
      if (isPosType.value && !pos.value) { pv.value = null; return; }
      const seq = ++pvSeq;
      try {
        const r = await api.order.preview(buildReq());
        if (seq !== pvSeq) return;
        pv.value = r; warnList.value = r.warnings || [];
        ['quantity', 'price', 'trigger_price', 'iceberg', 'tp', 'sl', 'trailing'].forEach((k) => delete errs[k]);
        validateLocal();
      } catch (e) {
        if (seq !== pvSeq) return;
        // 表单还没填完（缺必填项）不算错误，等用户输入；其余校验错误（精度 / 方向 / 超限…）才显示
        if (e.code === 'COMMON_COMMON_002') { pv.value = null; warnList.value = []; return; }
        applyErr(e);
      }
    };
    watch(() => [symbol.value, type.value, f.price, f.src, f.qty, f.trigger, f.execType, f.visible, f.tp, f.sl, f.trailMode, f.trailCb, f.trailAct, f.posOid, lev.value], schedulePreview);
    watch(() => sym.value && sym.value.symbol, schedulePreview);
    onMounted(() => schedulePreview());

    const validateLocal = () => {
      // 本地即时提示（不依赖后端也能给出的边界提示）；服务端仍会再校验
      if (!pv.value || !f.qty) return;
      const q = lots(f.qty);
      if (!isPosType.value && type.value !== 'CONDITIONAL' && q > num(pv.value.max_open_qty) && num(pv.value.max_open_qty) >= 0) errs.quantity = `超过当前杠杆最大可开 ${coinQty(symbol.value, pv.value.max_open_qty)} ${base.value}，可减少数量或调高杠杆`;
    };

    // 把后端错误映射到字段 / Toast
    const applyErr = (e) => {
      const fe = (e.data && e.data.errors && e.data.errors[0]) || null;
      const msg = e.msg || '操作失败';
      switch (e.code) {
        case 'CONTRACT_ORDER_011': {
          const d = e.data || {};
          errs.quantity = `保证金不足，还差 ${fmt(d.shortfall_amount)} USDT。`;
          toast(`保证金不足，还差 ${fmt(d.shortfall_amount)} USDT`, 'err', { title: '下单失败', action: '补充体验金', onAction: () => go('/account') });
          break;
        }
        case 'CONTRACT_ORDER_018': errs.price = msg; toast(msg, 'err', { title: '下单失败', action: '重试', onAction: () => { f.src = 'MANUAL'; } }); break;
        case 'CONTRACT_ORDER_020': errs.quantity = msg; break;
        case 'CONTRACT_ORDER_021': errs.trailing = msg; break;
        case 'CONTRACT_ORDER_022': errs.quantity = msg; break;
        case 'CONTRACT_ORDER_015': errs.iceberg = msg; break;
        case 'CONTRACT_ORDER_014': if (fe && /止损/.test(fe.message)) errs.sl = msg; else errs.tp = msg; break;
        case 'CONTRACT_ORDER_016': errs.trigger_price = msg; break;
        case 'CONTRACT_ORDER_012': toast(msg, 'err'); break;
        case 'CONTRACT_POSITION_201': toast(msg, 'err'); break;
        default:
          if (fe && fe.field) {
            const map = { quantity: 'quantity', price: 'price', trigger_price: 'trigger_price', iceberg_visible_qty: 'iceberg', trailing_callback_value: 'trailing', tp_trigger_price: 'tp', sl_trigger_price: 'sl' };
            errs[map[fe.field] || 'quantity'] = fe.message;
            if (e.code === 'CONTRACT_ORDER_013' && fe.field === 'quantity') errs.quantity = fe.message;
          } else if (e.code === 'CONTRACT_ORDER_013') errs.quantity = msg;
          else if (e.code === 'NETWORK_ERROR') toast(`${msg}。请确认委托状态`, 'err', { title: '网络异常', action: '查看委托', onAction: () => go('/orders') });
          else toast(msg, 'err');
      }
    };

    // ---------- 下单 ----------
    let idemKey = null;
    const submit = async (side) => {
      Object.keys(errs).forEach((x) => delete errs[x]);
      const q = lots(f.qty);
      if (!(q > 0)) { errs.quantity = f.qty ? `数量低于最小下单量 ${(csz.value).toFixed(qtyDp.value)} ${base.value}` : `请输入数量（最小 ${(csz.value).toFixed(qtyDp.value)} ${base.value}）`; return; }
      const req = buildReq(side);
      busy.value = true;
      try {
        const p = await api.order.preview(req);
        warnList.value = p.warnings || [];
        const priceText = type.value === 'MARKET' ? '市价' : type.value === 'CONDITIONAL' ? `标记价${side === 'LONG' || num(f.trigger) > num(t.value.mark_price) ? '≥' : '≤'} ${f.trigger}${f.execType === 'LIMIT' ? ' 触发，限价 ' + f.price : ' 触发，市价'}` : bboOn.value ? `${bboLabel.value}（下单时取价）` : `${f.price} USDT`;
        cf.value = { side, title: typeObj.value.t, priceText, margin: fmt(p.required_margin_amount), liq: p.est_liq_price && p.est_liq_price !== '0' ? fmtPrice(p.est_liq_price, tick.value) : '--', warnings: p.warnings || [], extra: type.value === 'ICEBERG' ? [['单次显示', `${f.visible} ${base.value}`], ['拆单', `共 ${p.iceberg_slice_total} 笔`]] : null, req };
        if (store.account && store.account.trade_settings && store.account.trade_settings.confirm_before_order === false) { await doSubmit(); }
        else { confirmSheet.value = true; busy.value = false; }
      } catch (e) { applyErr(e); busy.value = false; }
    };
    const doSubmit = async () => {
      busy.value = true;
      const req = { ...cf.value.req };
      if (!idemKey) idemKey = newIdemKey();       // 一次用户操作一个 key；重试沿用
      req.idempotency_key = idemKey;
      try {
        if (noAsk.value) { await api.account.setTradeSettings(false); if (store.account) store.account.trade_settings.confirm_before_order = false; }
        const r = await api.order.create(req);
        idemKey = null; confirmSheet.value = false;
        const filled = r.order_status === 'FILLED';
        toast(filled ? `已完全成交，均价 ${fmtPrice(r.avg_fill_price, tick.value)}` : r.order_status === 'PARTIALLY_FILLED' ? `已成交 ${coinQty(symbol.value, r.filled_qty)} ${base.value}，剩余继续挂单` : r.order_status === 'SUBMITTED' ? '已提交，等待撮合结果' : `${typeObj.value.t}${cf.value.side === 'LONG' ? '开多' : '开空'} ${f.qty} ${base.value}，已进入当前委托`, 'ok', { title: '下单成功', action: '查看', onAction: () => go('/orders') });
        (r.warnings || []).forEach((w) => toast(w.msg, 'warn'));
        f.qty = ''; f.pct = 0; if (type.value === 'CONDITIONAL') f.trigger = '';
        refreshAccount(); loadSide(); loadSettings();
      } catch (e) {
        if (e.code === 'COMMON_COMMON_301') { toast('该请求已提交，请到当前委托确认结果', 'warn'); idemKey = null; }
        else if (['CONTRACT_ORDER_503', 'CONTRACT_ORDER_504'].includes(e.code)) { idemKey = null; applyErr(e); toast(e.msg + '，可重新下单', 'err'); }
        else if (e.code === 'NETWORK_ERROR') { /* 写接口不自动重试；保留同一个 key，用户再点会沿用 */ applyErr(e); }
        else idemKey = null;
        if (!['NETWORK_ERROR', 'CONTRACT_ORDER_503', 'CONTRACT_ORDER_504'].includes(e.code)) applyErr(e);
        confirmSheet.value = false;
      } finally { busy.value = false; }
    };
    const submitPos = async () => {
      Object.keys(errs).forEach((x) => delete errs[x]);
      if (!pos.value) return;
      const body = {};
      if (type.value === 'TPSL') {
        if (!f.tp && !f.sl) { errs.tp = '请至少设置止盈或止损价'; return; }
        if (f.tp) body.tp_trigger_price = f.tp; if (f.sl) body.sl_trigger_price = f.sl;
        if (f.qty) body.quantity = String(lots(f.qty));
        busy.value = true;
        try {
          const r = await api.position.tpsl(pos.value.position_oid, body);
          toast('止盈止损已设置，触发后市价平仓', 'ok', { title: '设置成功' });
          (r.warnings || []).forEach((w) => toast(w.msg, 'warn'));
          f.tp = ''; f.sl = ''; f.qty = ''; loadSide();
        } catch (e) { applyErr(e); } finally { busy.value = false; }
      } else {
        if (!f.trailCb) { errs.trailing = '请输入回撤幅度'; return; }
        const req = buildReq(pos.value.position_side);
        req.position_oid = pos.value.position_oid;
        busy.value = true;
        try {
          await api.order.create(req);
          toast('移动止盈止损已设置', 'ok', { title: '设置成功', action: '查看', onAction: () => go('/orders') });
          f.trailCb = ''; f.trailAct = ''; f.qty = ''; loadSide();
        } catch (e) { applyErr(e); } finally { busy.value = false; }
      }
    };

    // ---------- 杠杆 ----------
    const openLev = async () => { await loadSettings(); levDraft.value = lev.value; levErr.value = ''; levSheet.value = true; levCalc(); };
    const stepLev = (d) => { levDraft.value = Math.min(sym.value ? sym.value.max_leverage : 125, Math.max(1, levDraft.value + d)); levCalc(); };
    const levCalc = async () => {
      levErr.value = '';
      if (settings.value && levDraft.value > settings.value.max_allowed_leverage) {
        const tier = levTier.value;
        levErr.value = `当前持仓与挂单名义价值 ${fmt(settings.value.current_notional_amount, 0)} USDT 超出 ${levDraft.value}× 档位上限 ${tier ? fmt(tier.position_value_upper, 0) : '--'} USDT，最高可设 ${settings.value.max_allowed_leverage}×。请降低杠杆或减少仓位。`;
      }
      try { levPv.value = await api.order.preview({ symbol: symbol.value, order_type: 'LIMIT', position_side: 'LONG', position_effect: 'OPEN', leverage: levDraft.value, price: t.value ? t.value.last_price : undefined }); } catch (e) { levPv.value = null; }
    };
    const applyLev = async () => {
      levBusy.value = true;
      try { await api.order.setLeverage(symbol.value, levDraft.value); await loadSettings(); levSheet.value = false; toast(`杠杆已调整为 ${levDraft.value}×`, 'ok'); loadSide(); }
      catch (e) { levErr.value = e.msg; } finally { levBusy.value = false; }
    };
    const switchSym = (s) => { symSheet.value = false; if (s !== symbol.value) { setDefaultSymbol(s); go('/trade/' + s); } };
    const sideObj = (o) => ({ position_effect: o.position_effect, position_side: o.position_side });

    return {
      TYPES, BBO, symbol, type, f, errs, warnList, pv, settings, bt, positions, orders, orderTotal, book, busy, typeSheet, bboSheet, marginSheet, levSheet, confirmSheet, symSheet, cf, noAsk,
      levDraft, levErr, levPv, levBusy, sym, t, acc, base, tick, priceDp, qtyDp, lev, typeObj, isPosType, showPrice, priceLabel, showQty: computed(() => true), bboOn, bboLabel, chgCls, offline, delaySec, countdown,
      posOptions, pos, trailSmall, sliceTotal, levPresets, levTier, asks, bids, pick, bboPreview, onNum, setPct, pickType, pickBbo, submit, doSubmit, submitPos, openLev, stepLev, levCalc, applyLev, switchSym, sideObj,
      go, store, fmt, fmtPct, fmtPrice, symName, symBase, pnlClass, label, sideText, sideClass, coinQty,
    };
  },
};
