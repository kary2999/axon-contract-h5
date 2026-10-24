// ① 开户：入口 / 登录 / 邮箱开通
import { ui } from './_ui.js';
import { go } from '../router.js';
import * as api from '../api/index.js';
import { auth as tokenStore } from '../api/client.js';
import { bootstrapSession, toast } from '../store.js';
import { config } from '../config.js';

const { ref, computed, onBeforeUnmount } = Vue;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function finishLogin(r) {
  tokenStore.set(r.access_token, r.refresh_token);
  await api.account.open();           // 已登录用户跳过注册，直接开通（幂等）
  await bootstrapSession();
  go('/markets');
}

export const Entry = {
  components: ui,
  template: `
    <div class="page">
      <div class="scroll">
        <div class="hero">
          <div class="pill yellow" style="margin-bottom:14px">AXON · 合约 Demo 交易</div>
          <h1>先学会不亏钱，<br><em>再用真钱交易</em></h1>
          <p class="mute" style="margin:0">真实行情，虚拟本金。零门槛练习杠杆、下单与止盈止损。</p>
        </div>
        <div class="pad" style="margin-top:8px">
          <div class="card row between" style="margin-bottom:10px;padding:14px">
            <div><small class="mute">开通即送</small><div class="num" style="font-size:30px;font-weight:800;color:var(--yellow)">10,000</div><small class="mute">体验金 USDT</small></div>
            <small class="mute" style="max-width:150px;text-align:right">用完每天可申请补差至 10,000</small>
          </div>
          <div class="sell-card" v-for="s in sells" :key="s.t"><div class="si">{{ s.i }}</div><div><b>{{ s.t }}</b><div class="note">{{ s.d }}</div></div></div>
          <button class="btn primary block" style="margin-top:14px" @click="go('/register')">邮箱 30 秒开通</button>
          <button class="btn ghost block" style="margin-top:10px" @click="go('/login')">已有 Axon 账户，登入后直接开通</button>
          <p class="note" style="text-align:center;margin:16px 0 24px">体验金盈亏为虚拟数据，不可提现、不可兑换为真实资产或积分</p>
        </div>
      </div>
    </div>`,
  setup() {
    const sells = [
      { i: '◎', t: '与实盘同一份行情', d: '标记价、指数价、资金费率均为真实数据' },
      { i: '⚡', t: '6 种委托全都能练', d: '限价、市价、止盈止损、移动止盈止损、计划、冰山' },
      { i: '◈', t: '亏的是虚拟本金', d: '逐仓模式，单笔风险边界一目了然' },
    ];
    return { sells, go };
  },
};

export const Login = {
  components: ui,
  template: `
    <div class="page">
      <AppHeader title="登入 Axon 账户" fallback="/entry"/>
      <div class="scroll"><div class="form-page">
        <p class="note" style="margin:0 0 14px">已有 Axon 账户，登入后直接开通 Demo 体验金账户，无需再次注册。</p>
        <div class="field"><label>邮箱</label><div class="inp" :class="{ err: !!emailErr }"><input class="text" v-model.trim="email" type="email" autocomplete="username" placeholder="name@example.com"></div><span class="err-t" v-if="emailErr">{{ emailErr }}</span></div>
        <div class="field"><label>登入密码</label><div class="inp"><input class="text" v-model="pwd" type="password" autocomplete="current-password" placeholder="请输入密码" @keyup.enter="submit"></div></div>
        <span class="err-t" v-if="err" style="margin-bottom:8px">{{ err }}</span>
        <button class="btn primary block" :disabled="busy" @click="submit"><span class="spin" v-if="busy"></span>{{ busy ? '正在登入…' : '登入并开通' }}</button>
        <p class="note" style="margin-top:14px" v-if="mock">Mock 演示：<a class="link" @click="fillDemo">使用演示账号</a>（{{ demo }}，任意密码，含 3 个持仓 / 10 笔委托 / 历史记录）；其他邮箱会得到空白新账户。</p>
        <p class="note" style="text-align:center;margin-top:18px">还没有账户？<a class="link" @click="go('/register')">邮箱开通</a></p>
      </div></div>
    </div>`,
  setup() {
    const email = ref(''); const pwd = ref(''); const busy = ref(false); const err = ref(''); const emailErr = ref('');
    const fillDemo = () => { email.value = config.DEMO_EMAIL; pwd.value = 'Demo1234'; };
    const submit = async () => {
      err.value = ''; emailErr.value = '';
      if (!EMAIL_RE.test(email.value)) { emailErr.value = '邮箱格式不正确，请检查后重试'; return; }
      if (!pwd.value) { err.value = '请输入密码'; return; }
      busy.value = true;
      try { await finishLogin(await api.auth.login(email.value, pwd.value)); } catch (e) { err.value = e.msg || '登入失败，请重试'; } finally { busy.value = false; }
    };
    return { email, pwd, busy, err, emailErr, submit, fillDemo, go, mock: config.USE_MOCK, demo: config.DEMO_EMAIL };
  },
};

export const Register = {
  components: ui,
  template: `
    <div class="page">
      <AppHeader title="开通 Demo 账户" sub="只需邮箱，无需手机号、KYC 或实名" fallback="/entry"/>
      <div class="scroll"><div class="form-page">
        <div class="field">
          <label>邮箱</label>
          <div class="inp" :class="{ err: !!emailErr }"><input class="text" v-model.trim="email" type="email" autocomplete="email" placeholder="name@example.com" @input="emailErr = ''"></div>
          <span class="err-t" v-if="emailErr">{{ emailErr }} <a v-if="exists" class="link" @click="go('/login')">直接登入</a></span>
        </div>
        <div class="field">
          <label>邮箱验证码</label>
          <div class="inp" :class="{ err: !!codeErr }">
            <input v-model="code" inputmode="numeric" maxlength="6" placeholder="6 位验证码" @input="codeErr = ''">
            <button class="btn xs primary" style="flex:none" :disabled="sending || cd > 0" @click="sendCode">{{ sending ? '发送中…' : cd > 0 ? '重新发送 ' + cd + 's' : sent ? '重新发送' : '获取验证码' }}</button>
          </div>
          <span class="err-t" v-if="codeErr">{{ codeErr }} <a v-if="expired" class="link" @click="sendCode">重新获取</a></span>
          <span class="tip-t" v-else-if="sent">验证码已发送至邮箱，10 分钟内有效{{ mock ? '（Mock 验证码：123456）' : '' }}</span>
        </div>
        <div class="field">
          <label>登入密码</label>
          <div class="inp"><input class="text" :type="show ? 'text' : 'password'" v-model="pwd" autocomplete="new-password" placeholder="8–32 位，含字母与数字"><button class="mute" style="font-size:12px" @click="show = !show">{{ show ? '隐藏' : '显示' }}</button></div>
          <div class="row gap8" style="margin-top:6px" v-if="pwd">
            <div class="grow row gap4"><i v-for="n in 3" :key="n" style="flex:1;height:4px;border-radius:2px" :style="{ background: n <= strength.level ? strength.color : 'var(--line)' }"></i></div>
            <small :style="{ color: strength.color }">强度：{{ strength.text }}</small>
          </div>
          <span class="err-t" v-if="pwdErr">{{ pwdErr }}</span>
          <span class="tip-t" v-else>强度：{{ pwd ? strength.text : '—' }} · 8–32 位，含字母与数字</span>
        </div>
        <div class="row gap8" style="align-items:flex-start;margin:4px 0 16px" @click="agree = !agree">
          <span class="check" :class="{ on: agree }" style="margin-top:2px"></span><span class="note">我已阅读并同意《Demo 交易服务条款》，知悉体验金盈亏为虚拟数据，不可提现、不可兑换为任何真实资产或积分。</span>
        </div>
        <span class="err-t" v-if="err" style="margin-bottom:8px">{{ err }}</span>
        <button class="btn primary block" :disabled="busy || !agree || strength.level < 2" @click="submit"><span class="spin" v-if="busy"></span>{{ busy ? '正在开通…' : '开通并领取 10,000 USDT' }}</button>
        <p class="note" style="text-align:center;margin-top:14px">已有账户？<a class="link" @click="go('/login')">直接登入</a></p>
      </div></div>
    </div>`,
  setup() {
    const email = ref(''); const code = ref(''); const pwd = ref(''); const show = ref(false); const agree = ref(false);
    const emailErr = ref(''); const codeErr = ref(''); const pwdErr = ref(''); const err = ref('');
    const exists = ref(false); const expired = ref(false);
    const sending = ref(false); const sent = ref(false); const cd = ref(0); const busy = ref(false);
    let timer = null;
    onBeforeUnmount(() => clearInterval(timer));
    const startCd = (n) => { cd.value = n; clearInterval(timer); timer = setInterval(() => { cd.value -= 1; if (cd.value <= 0) clearInterval(timer); }, 1000); };

    const strength = computed(() => {
      const p = pwd.value; const ok = p.length >= 8 && p.length <= 32 && /[a-zA-Z]/.test(p) && /\d/.test(p);
      if (!ok) return { level: p ? 1 : 0, text: '弱', color: 'var(--down)' };
      if (p.length >= 12 && /[^a-zA-Z0-9]/.test(p)) return { level: 3, text: '强', color: 'var(--up)' };
      return { level: 2, text: '中', color: 'var(--warn)' };
    });

    const sendCode = async () => {
      emailErr.value = ''; exists.value = false;
      if (!EMAIL_RE.test(email.value)) { emailErr.value = '请先填写正确的邮箱'; return; }
      sending.value = true;
      try { const r = await api.auth.sendCode(email.value, 'REGISTER'); sent.value = true; expired.value = false; codeErr.value = ''; startCd(r.resend_after_sec); }
      catch (e) {
        if (e.code === 'AUTH_EMAIL_002') { emailErr.value = e.msg; exists.value = true; }
        else if (e.code === 'AUTH_CODE_003') { startCd(e.data.retry_after_sec || 60); }
        else emailErr.value = e.msg;
      } finally { sending.value = false; }
    };
    const submit = async () => {
      err.value = ''; codeErr.value = ''; pwdErr.value = ''; expired.value = false;
      if (!EMAIL_RE.test(email.value)) { emailErr.value = '邮箱格式不正确，请检查后重试'; return; }
      if (!/^\d{6}$/.test(code.value)) { codeErr.value = '请输入 6 位验证码'; return; }
      busy.value = true;
      try {
        const r = await api.auth.register({ email: email.value, email_code: code.value, password: pwd.value, agree_terms: true });
        await finishLogin(r);
      } catch (e) {
        if (e.code === 'AUTH_CODE_001') codeErr.value = `${e.msg}（剩余 ${e.data.remaining_attempts} 次）`;
        else if (e.code === 'AUTH_CODE_002') { codeErr.value = e.msg; expired.value = true; }
        else if (e.code === 'AUTH_CODE_004') codeErr.value = e.msg;
        else if (e.code === 'AUTH_PWD_001') pwdErr.value = e.msg;
        else if (e.code === 'AUTH_EMAIL_002') { emailErr.value = e.msg; exists.value = true; }
        else err.value = e.msg || '开通失败，请重试';
      } finally { busy.value = false; }
    };
    return { email, code, pwd, show, agree, emailErr, codeErr, pwdErr, err, exists, expired, sending, sent, cd, busy, strength, sendCode, submit, go, mock: config.USE_MOCK };
  },
};
