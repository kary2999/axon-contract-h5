import { config } from './config.js';
import { all as ui } from './components/ui.js';
import { defineRoutes, startRouter, setGuard, route, go } from './router.js';
import { store, setAuthed, bootstrapSession, stopPrivate, toast } from './store.js';
import { ws } from './api/ws.js';
import { auth as tokenStore, setUnauthorizedHandler } from './api/client.js';
import * as api from './api/index.js';
import { Entry, Login, Register } from './pages/auth.js';
import { Markets } from './pages/markets.js';
import { Trade } from './pages/trade.js';
import { Kline, Depth, ContractInfo } from './pages/kline.js';
import { Orders } from './pages/orders.js';
import { Positions, LiqDetail } from './pages/positions.js';
import { History } from './pages/history.js';
import { Calc } from './pages/calc.js';
import { Account, GoReal, Me } from './pages/account.js';
import { ApiKeys } from './pages/apikeys.js';

const { createApp, computed, watch } = Vue;

const pages = { Entry, Login, Register, Markets, Trade, Kline, Depth, ContractInfo, Orders, Positions, LiqDetail, History, Calc, Account, GoReal, Me, ApiKeys };

defineRoutes([
  { path: '/entry', name: 'Entry', meta: { public: true, banner: false } },
  { path: '/login', name: 'Login', meta: { public: true } },
  { path: '/register', name: 'Register', meta: { public: true } },
  { path: '/markets', name: 'Markets', meta: { tabs: true } },
  { path: '/trade', name: 'Trade', meta: { tabs: true } },
  { path: '/trade/:symbol', name: 'Trade', meta: { tabs: true } },
  { path: '/kline/:symbol', name: 'Kline' },
  { path: '/depth/:symbol', name: 'Depth' },
  { path: '/info/:symbol', name: 'ContractInfo' },
  { path: '/positions', name: 'Positions', meta: { tabs: true } },
  { path: '/orders', name: 'Orders', meta: { tabs: true } },
  { path: '/liq/:oid', name: 'LiqDetail' },
  { path: '/history', name: 'History' },
  { path: '/history/:tab', name: 'History' },
  { path: '/calc', name: 'Calc' },
  { path: '/me', name: 'Me', meta: { tabs: true } },
  { path: '/account', name: 'Account' },
  { path: '/go-real', name: 'GoReal' },
  { path: '/api-keys', name: 'ApiKeys' },
]);

setGuard((r) => {
  if (!store.authed && !r.meta.public) return '/entry';
  if (store.authed && ['/entry', '/login', '/register'].includes(r.path)) return '/markets';
  return true;
});

setUnauthorizedHandler(() => { stopPrivate(); setAuthed(false); go('/entry'); });

const RiskModal = {
  components: ui,
  template: `
    <Modal :modelValue="show" persistent>
      <div style="text-align:center;padding-bottom:6px">
        <div style="font-size:30px">⚠️</div>
        <h4>这是 Demo 体验金账户</h4>
        <p class="mute" style="margin:0 0 10px">所有盈亏均为虚拟数据，不可提现、不可兑换为真实资产。</p>
      </div>
      <ul class="note" style="padding-left:16px;margin:0 0 12px">
        <li>行情与撮合均与实盘一致，挂单真实排队成交</li>
        <li>仅支持逐仓模式，触及强平价会被强平</li>
        <li>Demo 账户内没有充值、提现、转账入口</li>
      </ul>
      <div class="row gap8" style="margin-bottom:4px" @click="agree = !agree"><span class="check" :class="{ on: agree }"></span><span class="sub" style="font-size:12px">我已了解，体验金盈亏与真实资产无关</span></div>
      <template #footer><button class="btn primary" :disabled="!agree || busy" @click="ok">确认并继续</button></template>
    </Modal>`,
  data: () => ({ agree: false, busy: false }),
  computed: { show() { return store.authed && !!store.account && !store.account.is_risk_acked && !route.meta.public; } },
  methods: {
    async ok() {
      this.busy = true;
      try { await api.account.ackRisk(); store.account.is_risk_acked = true; } catch (e) { toast(e.msg || '确认失败，请重试', 'err'); } finally { this.busy = false; }
    },
  },
};

const App = {
  components: { ...ui, RiskModal },
  template: `
    <div class="phone">
      <component :is="page" :key="route.path"/>
      <TabBar v-if="route.meta.tabs"/>
      <div id="overlay-root"></div>
      <Toasts/>
      <RiskModal/>
    </div>`,
  setup() {
    const page = computed(() => pages[route.name] || { template: '<div class="empty"><b>页面不存在</b></div>' });
    return { route, page };
  },
};

async function start() {
  if (config.USE_MOCK) (await import('./mock/market.js')).market.start();
  ws.start();
  const app = createApp(App);
  app.config.errorHandler = (err, _i, info) => { console.error('[vue]', info, err); };
  app.mount('#app');
  if (store.authed) {
    // 刷新页面后恢复会话；失败（Token 失效）由 401 处理器跳转
    try { await bootstrapSession(); } catch (e) { console.warn('恢复会话失败', e); }
  }
  startRouter();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !config.DEBUG) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

window.__axon = { store, api, tokenStore, bootstrapSession };
start();
