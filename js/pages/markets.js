// ② 行情：合约列表（自选 / USDT 永续 / 热门）+ 账户概览
import { ui } from './_ui.js';
import { go } from '../router.js';
import * as api from '../api/index.js';
import { store, loadSymbols, loadTickers, useTickers, refreshAccount } from '../store.js';
import { fmt, fmtPct, fmtBig, fmtPrice, symBase, pnlClass, num } from '../lib/format.js';

const { ref, computed, onMounted, watch } = Vue;

export const Markets = {
  components: ui,
  template: `
    <div class="page">
      <AppHeader noBack title="合约">
        <template #right>
          <button class="icon-btn" aria-label="搜索" @click="searching = !searching; if (!searching) kw = ''"><Icon name="chart" v-if="false"/><svg width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="8" cy="8" r="5" stroke="currentColor" stroke-width="1.6"/><path d="M12 12l4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
        </template>
      </AppHeader>
      <div class="scroll">
        <div class="acct-card" v-if="acc">
          <div class="row between">
            <div><small class="mute">账户权益 · USDT</small><div class="eq num">{{ fmt(acc.equity) }}</div>
              <small class="num" :class="pnlClass(acc.unrealized_pnl)">未实现 {{ fmt(acc.unrealized_pnl, 2, { sign: true }) }}</small></div>
            <button class="btn sm primary" @click="go('/account')">补充体验金</button>
          </div>
          <div class="grid3" style="margin-top:10px">
            <div class="cell"><small>可用</small><span class="num">{{ fmt(acc.available_balance) }}</span></div>
            <div class="cell"><small>仓位保证金</small><span class="num">{{ fmt(acc.position_margin) }}</span></div>
            <div class="cell"><small>委托冻结</small><span class="num">{{ fmt(acc.order_frozen) }}</span></div>
          </div>
        </div>
        <div class="acct-card" v-else><div class="skel" style="height:86px"></div></div>

        <div class="pad" v-if="searching" style="padding-top:4px"><div class="inp"><input class="text" v-model.trim="kw" placeholder="搜索合约，如 BTC" autofocus><button class="mute" v-if="kw" @click="kw = ''">清除</button></div></div>

        <div class="tabs" style="position:sticky;top:0;background:var(--bg);z-index:3">
          <button v-for="t in tabs" :key="t.k" :class="{ on: tab === t.k }" @click="tab = t.k">{{ t.t }}</button>
        </div>
        <div class="mk-head"><span>合约 / 最大杠杆</span><span>最新价</span><span style="text-align:right">24h 涨跌</span></div>

        <template v-if="state === 'loading'"><div class="mk-row" v-for="n in 6" :key="n"><div class="skel" style="height:34px;width:70%"></div><div></div><div class="skel" style="height:30px;margin-left:10px"></div></div></template>
        <div v-else-if="state === 'error'" class="empty"><div class="ei">!</div><b>网络异常</b><span>合约列表加载失败，请检查网络后重试</span><button class="btn sm primary" @click="load">重新加载</button></div>
        <template v-else>
          <div v-if="!rows.length && kw" class="empty"><div class="ei">⌕</div><b>没有找到「{{ kw }}」</b><span>试试合约代码，如 BTC、ETH</span></div>
          <div v-else-if="!rows.length && tab === 'fav'" class="empty"><div class="ei">☆</div><b>还没有自选合约</b><span>在合约详情页点击 ☆ 即可加入自选</span><button class="btn sm ghost" @click="tab = 'usdt'">去 USDT 永续看看</button></div>
          <a v-for="r in rows" :key="r.symbol" class="mk-row" :href="'#/kline/' + r.symbol">
            <div class="nm"><b>{{ r.base_coin }}</b><small>USDT 永续 · <span class="pill yellow">{{ r.max_leverage }}×</span></small></div>
            <div class="px num" :class="r.dir > 0 ? 'flash-up' : r.dir < 0 ? 'flash-down' : ''" :key="r.t && r.t.last_price">{{ r.t ? fmtPrice(r.t.last_price, r.price_tick) : '--' }}<small class="mute" style="display:block;font-size:10px;font-weight:400;font-family:var(--font)">成交额 {{ r.t ? fmtBig(r.t.turnover_24h) : '--' }}</small></div>
            <div class="chg"><span v-if="r.t" :class="num(r.t.price_change_rate) >= 0 ? 'up' : 'down'">{{ fmtPct(r.t.price_change_rate, 2, { sign: true }) }}</span><span v-else>--</span></div>
          </a>
        </template>

        <div class="go-real" @click="go('/go-real')">
          <div><b>练熟了？去实盘交易</b><div class="note">真实合约账户，需完成 KYC 与入金</div></div><Icon name="right"/>
        </div>
      </div>
    </div>`,
  setup() {
    const tab = ref('usdt'); const kw = ref(''); const searching = ref(false); const state = ref(store.symbolList.length ? 'ok' : 'loading');
    const tabs = [{ k: 'fav', t: '自选' }, { k: 'usdt', t: 'USDT 永续' }, { k: 'hot', t: '热门' }];
    const acc = computed(() => store.account);
    const prev = {};

    const load = async () => {
      state.value = store.symbolList.length ? 'ok' : 'loading';
      try { await loadSymbols(); await loadTickers(); state.value = 'ok'; } catch (e) { if (!store.symbolList.length) state.value = 'error'; }
    };
    onMounted(() => { load(); refreshAccount(); });
    useTickers(() => store.symbolList.map((s) => s.symbol));
    watch(() => store.rev.balance, () => {});

    const rows = computed(() => {
      let list = store.symbolList.map((s) => {
        const t = store.tickers[s.symbol];
        const last = t ? num(t.last_price) : 0;
        const dir = prev[s.symbol] === undefined ? 0 : Math.sign(last - prev[s.symbol]);
        prev[s.symbol] = last;
        return { ...s, t, dir };
      });
      const k = kw.value.toLowerCase();
      if (k) list = list.filter((s) => s.base_coin.toLowerCase().startsWith(k) || s.symbol.toLowerCase().includes(k));
      if (tab.value === 'fav') list = list.filter((s) => s.is_favorite || (store.symbols[s.symbol] && store.symbols[s.symbol].is_favorite));
      if (tab.value === 'hot') list = [...list].sort((a, b) => num(b.t && b.t.turnover_24h) - num(a.t && a.t.turnover_24h));
      return list;
    });
    return { tab, tabs, kw, searching, state, acc, rows, load, go, fmt, fmtPct, fmtBig, fmtPrice, pnlClass, num };
  },
};
