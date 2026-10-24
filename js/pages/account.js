// ⑮ Demo 账户与体验金补充 / 转实盘引导 + 「我的」入口页
import { ui } from './_ui.js';
import { go } from '../router.js';
import * as api from '../api/index.js';
import { auth as tokenStore } from '../api/client.js';
import { store, refreshAccount, setAuthed, stopPrivate, toast } from '../store.js';
import { fmt, fmtPct, fmtTime, label, num, pnlClass } from '../lib/format.js';
import { config } from '../config.js';

const { ref, computed, onMounted, watch } = Vue;

export const Account = {
  components: ui,
  template: `
  <div class="page">
    <AppHeader title="Demo 账户与体验金" fallback="/me"/>
    <div class="scroll"><div class="pad">
      <template v-if="acc">
        <div class="card" style="margin-top:6px">
          <div class="row between"><b>Demo 账户</b><span class="pill warn">DEMO-{{ acc.show_uid }}</span></div>
          <small class="mute" style="display:block;margin-top:10px">可用现金余额 · USDT</small>
          <div class="num" style="font-size:30px;font-weight:800">{{ fmt(acc.available_balance) }}</div>
          <small class="note">补充体验金以此为准，不计未实现盈亏</small>
          <div class="grid3" style="margin-top:12px"><div class="cell"><small>账户权益</small><span class="num">{{ fmt(acc.equity) }}</span></div><div class="cell"><small>未实现盈亏</small><span class="num" :class="pnlClass(acc.unrealized_pnl)">{{ fmt(acc.unrealized_pnl, 2, { sign: true }) }}</span></div><div class="cell"><small>已冻结保证金</small><span class="num">{{ fmt(num(acc.position_margin) + num(acc.order_frozen)) }}</span></div></div>
        </div>

        <div class="card" style="margin-top:10px">
          <div class="row between"><b>每日补充体验金</b><span class="pill" :class="acc.claim.can_claim ? 'yellow' : ''">{{ acc.claim.can_claim ? '今日可用 1 次' : '今日已补充' }}</span></div>
          <template v-if="acc.claim.can_claim">
            <div class="row between" style="margin-top:10px"><span class="mute">可补充金额</span><b class="num up" style="font-size:20px">{{ fmt(claimAmount, 2, { sign: true }) }}</b></div>
            <div class="note">补充至 {{ fmt(acc.claim.target_balance, 0) }} USDT · 到账后可用现金为 {{ fmt(acc.claim.target_balance) }} USDT</div>
            <div class="banner err" style="margin:10px 0 0" v-if="failMsg"><b>补充失败</b> {{ failMsg }}（不占用今日次数）</div>
            <button class="btn primary block" style="margin-top:10px" :disabled="busy" @click="claim"><span class="spin" v-if="busy"></span>{{ busy ? '补充中…' : failMsg ? '重新申请' : '补充体验金' }}</button>
          </template>
          <template v-else>
            <div class="banner info" style="margin:10px 0 0" v-if="done"><span>✓ 已补充 {{ fmt(done.claim_amount) }} USDT，可用现金 {{ fmt(done.after_balance_amount) }} USDT</span></div>
            <p class="note" style="margin:10px 0 0">{{ acc.available_balance >= 10000 && !done ? '可用现金已达 10,000 USDT，暂无需补充。' : '今日补充次数已用完，明日 00:00（UTC+8）后可再次申请。' }}<br>下次可补充时间：{{ fmtTime(acc.claim.next_claim_time, 'md') }}</p>
          </template>
          <div class="note" style="margin-top:10px;line-height:1.7">补充规则<br>· 可用现金 &lt; 10,000 时，可一次补足至 10,000<br>· 每个自然日（UTC+8）限 1 次，不论金额<br>· 只增加可用余额，不影响挂单与仓位已冻结的保证金</div>
        </div>

        <div class="row between" style="margin:16px 2px 6px"><b>资金记录</b><a class="link" @click="go('/history/ledger')">全部资金流水 ›</a></div>
        <div class="card" style="padding:4px 12px">
          <div class="empty" v-if="!recent.length" style="padding:20px"><span>暂无记录</span></div>
          <div class="row between" v-for="l in recent" :key="l.ledger_oid" style="padding:10px 0;border-bottom:1px solid var(--line2)"><div><b>{{ label('ledger_type', l.ledger_type) }}{{ l.symbol ? ' · ' + l.symbol.split('-')[0] + 'USDT' : '' }}</b><div class="note">{{ fmtTime(l.create_time) }}</div></div><b class="num" :class="pnlClass(l.ledger_amount)">{{ fmt(l.ledger_amount, 2, { sign: true }) }}</b></div>
        </div>
        <button class="btn ghost block" style="margin:16px 0 24px" @click="go('/go-real')">去实盘交易</button>
      </template>
      <div class="skel" style="height:260px;margin-top:8px" v-else></div>
    </div></div>
  </div>`,
  setup() {
    const acc = computed(() => store.account); const busy = ref(false); const failMsg = ref(''); const done = ref(null); const recent = ref([]);
    const claimAmount = computed(() => (acc.value ? acc.value.claim.claim_amount : 0));
    const loadRecent = async () => { try { recent.value = (await api.history.ledgers({ pagination: { size: 3 }, cursor: '', filters: {} })).list; } catch (e) { /* 忽略 */ } };
    onMounted(() => { refreshAccount(); loadRecent(); });
    watch(() => store.rev.balance, loadRecent);
    const claim = async () => {
      busy.value = true; failMsg.value = '';
      try { done.value = await api.account.claim(); toast(`体验金已到账 ${fmt(done.value.claim_amount)} USDT`, 'ok', { title: '补充成功' }); await refreshAccount(); loadRecent(); }
      catch (e) {
        if (e.code === 'CONTRACT_ACCOUNT_401' || e.code === 'CONTRACT_ACCOUNT_402') { toast(e.msg, 'warn'); await refreshAccount(); }
        else failMsg.value = e.code === 'COMMON_COMMON_502' || e.code === 'NETWORK_ERROR' ? '网络异常，本次未到账' : e.msg;
      } finally { busy.value = false; }
    };
    return { acc, busy, failMsg, done, recent, claimAmount, claim, go, fmt, fmtTime, label, num, pnlClass };
  },
};

export const GoReal = {
  components: ui,
  template: `
  <div class="page">
    <AppHeader title="转实盘引导" sub="即将离开 Demo 账户" fallback="/me"/>
    <div class="scroll"><div class="pad">
      <div class="h-sec" style="padding-left:0">你的练习成果 <small class="mute" style="font-weight:400">近 7 天 Demo 交易回顾</small></div>
      <div class="loading" v-if="state === 'loading'"><span class="spin"></span></div>
      <div class="empty" v-else-if="state === 'error'"><div class="ei">!</div><b>统计暂时无法加载</b><button class="btn sm primary" @click="load">重试</button></div>
      <div class="stat-bar" style="margin:0" v-else-if="s"><div><small>Demo 成交</small><b class="num">{{ s.fill_count }} 笔</b></div><div><small>胜率</small><b class="num">{{ fmtPct(s.win_rate, 0) }}</b></div><div><small>高级委托</small><b class="num">{{ s.advanced_order_types_used }} / {{ s.advanced_order_types_total }} 种</b></div></div>
      <div class="card" style="margin-top:10px;text-align:center" v-if="s"><small class="mute">被强平</small> <b class="num" :class="s.liquidated_count ? 'down' : ''">{{ s.liquidated_count }} 次</b></div>
      <div class="h-sec" style="padding-left:0">Demo 与实盘的区别</div>
      <div class="card" style="padding:0 12px"><table style="width:100%;border-collapse:collapse"><tr class="mute" style="text-align:left"><th style="padding:8px 0;font-weight:400;width:25%"></th><th style="font-weight:400">Demo</th><th style="font-weight:400">实盘</th></tr>
        <tr v-for="r in rows" :key="r[0]" style="border-top:1px solid var(--line2)"><td class="mute" style="padding:9px 0">{{ r[0] }}</td><td>{{ r[1] }}</td><td>{{ r[2] }}</td></tr></table></div>
      <p class="note" style="margin:10px 0">Demo 账户的盈亏、余额不会带入实盘，也不能兑换为任何真实资产。</p>
      <button class="btn primary block" @click="open">开通实盘合约</button>
      <button class="btn ghost block" style="margin:10px 0 24px" @click="go('/markets')">继续 Demo 练习</button>
    </div></div>
  </div>`,
  setup() {
    const s = ref(null); const state = ref('loading');
    const rows = [['资金', '虚拟 USDT', '真实入金'], ['盈亏', '虚拟，不可提现', '真实盈亏'], ['强平', '按公式计算', '含保险基金 / ADL'], ['开户', '仅邮箱', '需完成 KYC']];
    const load = async () => { state.value = 'loading'; try { s.value = await api.account.practiceSummary(7); state.value = 'ok'; } catch (e) { state.value = 'error'; } };
    onMounted(load);
    const open = () => { toast('将跳转到 Axon 实盘合约开通页（Mock 未接入）', 'info'); };
    return { s, state, rows, load, open, go, fmtPct };
  },
};

export const Me = {
  components: ui,
  template: `
  <div class="page">
    <AppHeader noBack title="我的"/>
    <div class="scroll"><div class="pad">
      <div class="card row between" style="margin:6px 0 10px" @click="go('/account')">
        <div class="row gap12"><div class="side-tag" style="width:44px;height:44px;border-radius:50%;background:var(--yellow);color:#181A20;font-size:18px">A</div><div><b>DEMO-{{ acc ? acc.show_uid : '--' }}</b><div class="note">可用 {{ acc ? fmt(acc.available_balance) : '--' }} USDT</div></div></div><Icon name="right"/>
      </div>
      <div class="card" style="padding:0 12px">
        <div class="row between" v-for="m in menu" :key="m.to" style="padding:14px 0;border-bottom:1px solid var(--line2)" @click="go(m.to)"><span>{{ m.t }}</span><span class="row gap8"><small class="mute">{{ m.d }}</small><Icon name="right" :size="14"/></span></div>
        <div class="row between" style="padding:14px 0" ><div><span>下单前二次确认</span><div class="note">关闭后点击开多 / 开空将直接下单</div></div><Switch :modelValue="confirm" @update:modelValue="setConfirm"/></div>
      </div>
      <div class="card" style="margin-top:12px" v-if="mock">
        <b>Mock 调试工具</b>
        <p class="note" style="margin:4px 0 10px">仅 Mock 模式显示。用于演示边界状态，真实对接后自动隐藏。</p>
        <div class="grid2" style="gap:8px">
          <button class="btn sm" @click="toggleOffline">{{ offline ? '恢复网络' : '模拟断网' }}</button>
          <button class="btn sm" @click="failClaim">模拟下次补差失败</button>
          <button class="btn sm" @click="lag">模拟行情延迟 4 秒</button>
          <button class="btn sm down" @click="reset">重置 Mock 数据</button>
        </div>
      </div>
      <button class="btn ghost block" style="margin:16px 0 24px" @click="logout">退出登录</button>
    </div></div>
  </div>`,
  setup() {
    const acc = computed(() => store.account);
    const offline = ref(!!window.__mockOffline);
    const confirm = computed(() => !acc.value || acc.value.trade_settings.confirm_before_order !== false);
    const menu = [
      { t: 'Demo 账户与体验金', d: '补充体验金', to: '/account' }, { t: '资金流水', d: '', to: '/history/ledger' }, { t: '历史记录', d: '持仓 · 委托 · 成交', to: '/history/pos' },
      { t: '合约计算器', d: '收益 · 强平价 · 可开', to: '/calc' }, { t: 'API 管理', d: '', to: '/api-keys' }, { t: '转实盘', d: '', to: '/go-real' },
    ];
    onMounted(refreshAccount);
    const setConfirm = async (v) => { try { await api.account.setTradeSettings(v); if (store.account) store.account.trade_settings.confirm_before_order = v; } catch (e) { toast(e.msg, 'err'); } };
    const logout = async () => { try { await api.auth.logout(); } catch (e) { /* 忽略 */ } stopPrivate(); tokenStore.clear(); setAuthed(false); go('/entry'); };
    const toggleOffline = () => { window.__mockOffline = !window.__mockOffline; offline.value = window.__mockOffline; toast(offline.value ? '已模拟断网：行情暂停，写操作会报网络异常' : '网络已恢复', 'info'); };
    const failClaim = () => { window.__mockClaimFail = true; toast('下一次补充体验金将失败（不占用次数）', 'info'); };
    const lag = () => { window.__mockLag = true; setTimeout(() => { window.__mockLag = false; }, 4500); toast('行情将暂停 4.5 秒，交易页会出现「行情延迟」提示', 'info'); };
    return { acc, offline, confirm, menu, setConfirm, logout, toggleOffline, failClaim, lag, reset: async () => (await import('../mock/handlers.js')).mockReset(), mock: config.USE_MOCK, go, fmt };
  },
};
