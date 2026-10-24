// ⑯ API 管理（预留，见 api-doc/06-api-keys.md）：列表 / 创建 / 编辑 / 删除
import { ui } from './_ui.js';
import { go } from '../router.js';
import * as api from '../api/index.js';
import { newIdemKey } from '../api/client.js';
import { store, toast } from '../store.js';
import { fmtTime } from '../lib/format.js';

const { ref, reactive, computed, onMounted } = Vue;

const SCOPES = [{ k: 'READ', t: '读取' }, { k: 'TRADE', t: '交易' }, { k: 'DEPOSIT_WITHDRAW', t: '充提', demoOff: true }];
const SCOPE_TEXT = { READ: '读取', TRADE: '交易', DEPOSIT_WITHDRAW: '充提', SPOT: '现货', FUTURES: '合约' };

export const ApiKeys = {
  components: ui,
  template: `
  <div class="page">
    <AppHeader title="API 管理" fallback="/me">
      <template #right><button class="link" @click="docs">API 文档</button></template>
    </AppHeader>
    <div class="tabs"><button :class="{ on: false }" @click="toast('实盘账户的 API 请前往 Axon 实盘页面管理', 'info')">实盘账户</button><button class="on">Demo 账户</button></div>
    <div class="scroll">
      <div class="row between pad" style="padding-top:10px"><span>已创建 <b class="num">{{ count }}</b> / {{ max }}</span><span class="note">未绑定 IP 的 Key 90 天后自动失效</span></div>
      <div class="loading" v-if="state === 'loading'"><span class="spin"></span></div>
      <div class="empty" v-else-if="state === 'error'"><div class="ei">!</div><b>加载失败</b><button class="btn sm primary" @click="load">重试</button></div>
      <div class="empty" v-else-if="!list.length"><div class="ei">⌘</div><b>还没有 API</b><span>创建 API Key 后，可用程序读取行情或下单</span></div>
      <div class="api-card" v-for="k in list" :key="k.api_key_oid">
        <div class="row between"><b>{{ k.name }}</b><span class="pill" :class="k.status === 'NORMAL' ? 'up' : k.status === 'EXPIRING' ? 'warn' : 'down'">{{ k.status === 'NORMAL' ? '正常' : k.status === 'EXPIRING' ? '即将过期' : '已过期' }}</span></div>
        <div class="note num" style="margin:6px 0">API Key　{{ k.api_key }}</div>
        <div style="margin-bottom:6px"><span class="tag" v-for="s in k.scopes" :key="s">{{ SCOPE_TEXT[s] }}</span><span class="tag" v-for="s in k.trade_scopes" :key="s" style="background:rgba(240,185,11,.14);color:var(--yellow)">{{ SCOPE_TEXT[s] }}</span></div>
        <div class="row between note"><span>IP 白名单　{{ k.ip_count ? k.ip_whitelist[0] + (k.ip_count > 1 ? ' 等 ' + k.ip_count + ' 个' : '') : '未绑定' }}</span><span>{{ k.expire_time ? '到期时间　' + fmtTime(k.expire_time, 'date') : '有效期　长期有效' }}</span></div>
        <div class="row gap8" style="margin-top:10px"><button class="btn sm grow" @click="openEdit(k)">编辑</button><button class="btn sm grow" @click="openDel(k)">删除</button></div>
      </div>
      <div style="height:90px"></div>
    </div>
    <div class="bottom-cta"><button class="btn primary" :disabled="count >= max" @click="openCreate">{{ count >= max ? '已达上限（' + count + ' / ' + max + '）' : '创建 API' }}</button></div>
    <div class="note pad" v-if="count >= max" style="position:absolute;bottom:70px;left:0;right:0;text-align:center">已达上限，请删除不再使用的 API 后再创建</div>

    <!-- 创建 / 编辑 -->
    <Sheet v-model="formSheet" :title="form.oid ? '编辑 API' : '创建 API'">
      <div class="field"><label>备注名</label><div class="inp" :class="{ err: !!form.errs.name }"><input class="text" v-model.trim="form.name" maxlength="20" placeholder="如：量化-做市机器人"></div><span class="err-t" v-if="form.errs.name">{{ form.errs.name }}</span></div>
      <div class="field"><label>权限</label>
        <div class="row gap12" style="flex-wrap:wrap"><div class="row gap8" v-for="s in SCOPES" :key="s.k" :style="s.demoOff ? 'opacity:.4' : ''" @click="!s.demoOff && toggleScope(s.k)"><Check :modelValue="form.scopes.includes(s.k)"/><span>{{ s.t }}</span></div></div>
        <span class="tip-t">Demo 账户不提供充提权限</span><span class="err-t" v-if="form.errs.scopes">{{ form.errs.scopes }}</span></div>
      <div class="field" v-if="form.scopes.includes('TRADE')"><label>交易业务范围（开启「交易」后生效）</label>
        <div class="row gap12"><div class="row gap8" v-for="s in ['SPOT', 'FUTURES']" :key="s" @click="toggleTrade(s)"><Check :modelValue="form.trade.includes(s)"/><span>{{ SCOPE_TEXT[s] }}</span></div></div></div>
      <div class="field"><label>IP 白名单（选填，每行一个）</label><div class="inp" style="height:auto;padding:8px 12px" :class="{ err: !!form.errs.ip }"><textarea v-model="form.ips" rows="3" placeholder="203.0.113.24" style="flex:1;background:none;border:0;resize:none;font-family:var(--mono);font-size:13px;color:var(--text)"></textarea></div><span class="err-t" v-if="form.errs.ip">{{ form.errs.ip }}</span><span class="tip-t" v-else>不绑定 IP，90 天后自动失效</span></div>
      <template v-if="!form.oid"><div class="field"><label>Passphrase（调用时需要，请自行保存）</label><div class="inp"><input class="text" v-model="form.pass" type="password" placeholder="6–32 位"></div></div>
        <div class="field"><label>邮箱码{{ mock ? '（Mock：123456）' : '' }}</label><div class="inp" :class="{ err: !!form.errs.email }"><input v-model="form.email" inputmode="numeric" maxlength="6"></div><span class="err-t" v-if="form.errs.email">{{ form.errs.email }}</span></div></template>
      <div class="field"><label>谷歌验证{{ mock ? '（Mock：任意 6 位数字）' : '' }}</label><div class="inp" :class="{ err: !!form.errs.totp }"><input v-model="form.totp" inputmode="numeric" maxlength="6"></div><span class="err-t" v-if="form.errs.totp">{{ form.errs.totp }}</span></div>
      <span class="err-t" v-if="form.errs.top">{{ form.errs.top }}</span>
      <template #footer><button class="btn primary block" :disabled="form.busy" @click="submitForm"><span class="spin" v-if="form.busy"></span>{{ form.oid ? '保存' : '确认创建' }}</button></template>
    </Sheet>

    <!-- 创建成功：secret 只展示一次 -->
    <Modal v-model="doneModal" title="创建成功" persistent>
      <div class="banner warn" style="margin:0 0 10px">请立即保存 Secret Key，关闭后将无法再次查看，也不要泄露给任何人。</div>
      <template v-if="done">
        <div class="kv"><span>API Key</span></div><div class="row gap8"><code class="num grow" style="word-break:break-all;font-size:12px">{{ done.api_key }}</code><button class="btn xs" @click="copy(done.api_key)">复制</button></div>
        <div class="kv" style="margin-top:8px"><span>Secret Key</span></div><div class="row gap8"><code class="num grow" style="word-break:break-all;font-size:12px">{{ done.api_secret }}</code><button class="btn xs" @click="copy(done.api_secret)">复制</button></div>
        <div class="kv" style="margin-top:8px"><span>权限</span><b>{{ done.scopes.map(s => SCOPE_TEXT[s]).join(' · ') }}{{ done.trade_scopes.length ? '（' + done.trade_scopes.map(s => SCOPE_TEXT[s]).join(' / ') + '）' : '' }}</b></div>
        <div class="kv"><span>IP 白名单</span><b>{{ done.ip_whitelist.length ? done.ip_whitelist[0] + (done.ip_whitelist.length > 1 ? ' 等 ' + done.ip_whitelist.length + ' 个' : '') : '未绑定' }}</b></div>
        <div class="kv"><span>有效期</span><b>{{ done.expire_time ? '未绑定 IP，' + fmtTime(done.expire_time, 'date') + ' 失效' : '已绑定 IP，长期有效' }}</b></div>
      </template>
      <template #footer><button class="btn primary" @click="finishDone">我已保存，完成</button></template>
    </Modal>

    <!-- 删除 -->
    <Modal v-model="delModal" :title="'删除「' + (delTarget ? delTarget.name : '') + '」？'">
      <p class="note" style="margin:0 0 10px">删除后该 API Key 立即失效，使用它的程序将无法再查询或下单；已提交的委托不受影响。此操作不可恢复。</p>
      <div class="field" style="margin-bottom:0"><label>谷歌验证</label><div class="inp" :class="{ err: !!delErr }"><input v-model="delTotp" inputmode="numeric" maxlength="6"></div><span class="err-t" v-if="delErr">{{ delErr }}</span></div>
      <template #footer><button class="btn" @click="delModal = false">取消</button><button class="btn down" :disabled="delBusy" @click="doDel"><span class="spin" v-if="delBusy"></span>确认删除</button></template>
    </Modal>
  </div>`,
  setup() {
    const list = ref([]); const count = ref(0); const max = ref(30); const state = ref('loading');
    const formSheet = ref(false); const doneModal = ref(false); const delModal = ref(false); const done = ref(null);
    const delTarget = ref(null); const delTotp = ref(''); const delErr = ref(''); const delBusy = ref(false);
    const form = reactive({ oid: '', name: '', scopes: ['READ'], trade: ['FUTURES'], ips: '', pass: '', email: '', totp: '', errs: {}, busy: false, key: '' });
    const mock = true;
    const load = async () => { state.value = 'loading'; try { const r = await api.apiKeys.list('DEMO'); list.value = r.list; count.value = r.created_count; max.value = r.max_count; state.value = 'ok'; } catch (e) { state.value = 'error'; } };
    onMounted(load);
    const openCreate = () => { Object.assign(form, { oid: '', name: '', scopes: ['READ'], trade: ['FUTURES'], ips: '', pass: '', email: '', totp: '', errs: {}, busy: false, key: newIdemKey() }); formSheet.value = true; };
    const openEdit = (k) => { Object.assign(form, { oid: k.api_key_oid, name: k.name, scopes: [...k.scopes], trade: [...k.trade_scopes], ips: k.ip_whitelist.join('\n'), pass: '', email: '', totp: '', errs: {}, busy: false }); formSheet.value = true; };
    const toggleScope = (k) => { const i = form.scopes.indexOf(k); if (i >= 0) form.scopes.splice(i, 1); else form.scopes.push(k); form.errs.scopes = ''; };
    const toggleTrade = (k) => { const i = form.trade.indexOf(k); if (i >= 0) form.trade.splice(i, 1); else form.trade.push(k); };
    const submitForm = async () => {
      form.errs = {};
      if (!form.name) form.errs.name = '请填写备注名';
      if (!form.scopes.length) form.errs.scopes = '请至少选择一项权限';
      if (!/^\d{6}$/.test(form.totp)) form.errs.totp = '请输入 6 位谷歌验证码';
      if (!form.oid && !/^\d{6}$/.test(form.email)) form.errs.email = '请输入 6 位邮箱验证码';
      if (Object.keys(form.errs).length) return;
      const ips = form.ips.split(/[\s,]+/).filter(Boolean);
      form.busy = true;
      try {
        if (form.oid) {
          await api.apiKeys.update(form.oid, { name: form.name, scopes: form.scopes, trade_scopes: form.scopes.includes('TRADE') ? form.trade : [], ip_whitelist: ips, totp_code: form.totp });
          formSheet.value = false; toast('已保存', 'ok'); load();
        } else {
          done.value = await api.apiKeys.create({ idempotency_key: form.key, name: form.name, account_type: 'DEMO', scopes: form.scopes, trade_scopes: form.scopes.includes('TRADE') ? form.trade : [], ip_whitelist: ips, passphrase: form.pass, email_code: form.email, totp_code: form.totp });
          formSheet.value = false; doneModal.value = true;
        }
      } catch (e) {
        if (e.code === 'AUTH_APIKEY_002') form.errs.ip = e.msg; else if (['AUTH_CODE_001', 'AUTH_CODE_002'].includes(e.code)) form.errs.email = e.msg; else if (e.code === 'AUTH_TOTP_001') form.errs.totp = e.msg;
        else if (e.code === 'AUTH_APIKEY_001') { form.errs.top = e.msg; load(); } else form.errs.top = e.msg;
      } finally { form.busy = false; }
    };
    const finishDone = () => { doneModal.value = false; done.value = null; load(); };
    const copy = async (t) => { try { await navigator.clipboard.writeText(t); toast('已复制', 'ok'); } catch { toast('复制失败，请手动选择文本', 'warn'); } };
    const openDel = (k) => { delTarget.value = k; delTotp.value = ''; delErr.value = ''; delModal.value = true; };
    const doDel = async () => {
      if (!/^\d{6}$/.test(delTotp.value)) { delErr.value = '请输入 6 位谷歌验证码'; return; }
      delBusy.value = true;
      try { await api.apiKeys.remove(delTarget.value.api_key_oid, delTotp.value); delModal.value = false; toast('已删除，该 API Key 立即失效', 'ok'); load(); }
      catch (e) { delErr.value = e.msg; } finally { delBusy.value = false; }
    };
    const docs = () => toast('API 文档入口（沿用 Axon 现有文档站）', 'info');
    return { SCOPES, SCOPE_TEXT, list, count, max, state, formSheet, doneModal, delModal, done, delTarget, delTotp, delErr, delBusy, form, mock, load, openCreate, openEdit, toggleScope, toggleTrade, submitForm, finishDone, copy, openDel, doDel, docs, toast, fmtTime };
  },
};
