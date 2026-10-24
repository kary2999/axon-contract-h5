// 通用 UI 组件（无业务请求）。全部在 main.js 里全局注册。
import { back, go, route } from '../router.js';
import { store } from '../store.js';

const { ref, computed, watch, nextTick } = Vue;

const ICONS = {
  back: '<path d="M11 4L6 9l5 5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  close: '<path d="M4 4l10 10M14 4L4 14" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" fill="none"/>',
  chevron: '<path d="M5 7l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  right: '<path d="M7 4l5 5-5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  filter: '<path d="M3 5h12M5.5 9h7M8 13h2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/>',
  info: '<circle cx="9" cy="9" r="6.5" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M9 8v4M9 5.8v.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  star: '<path d="M9 2.5l2 4.2 4.6.6-3.4 3.2.9 4.5L9 12.6 4.9 15l.9-4.5L2.4 7.3 7 6.7z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" fill="none"/>',
  starOn: '<path d="M9 2.5l2 4.2 4.6.6-3.4 3.2.9 4.5L9 12.6 4.9 15l.9-4.5L2.4 7.3 7 6.7z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" fill="currentColor"/>',
  chart: '<path d="M3 14V4M3 14h12M6 11V8M9 11V6M12 11V9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/>',
  list: '<path d="M6 5h9M6 9h9M6 13h9M3 5h.01M3 9h.01M3 13h.01" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/>',
  more: '<circle cx="4" cy="9" r="1.2" fill="currentColor"/><circle cx="9" cy="9" r="1.2" fill="currentColor"/><circle cx="14" cy="9" r="1.2" fill="currentColor"/>',
  calc: '<rect x="3.5" y="2.5" width="11" height="13" rx="2" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M6 6h6M6 9.5h.01M9 9.5h.01M12 9.5h.01M6 12.5h.01M9 12.5h.01M12 12.5h.01" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  trade: '<path d="M3 6h9l-2-2M15 12H6l2 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  user: '<circle cx="9" cy="6.5" r="3" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M3.5 15c.6-3 3-4.5 5.5-4.5s4.9 1.5 5.5 4.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"/>',
  market: '<path d="M3 13l3.5-4 3 2.5L15 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  wallet: '<rect x="2.5" y="4.5" width="13" height="10" rx="2" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M12 9.5h3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
};

export const Icon = {
  props: { name: String, size: { type: Number, default: 18 } },
  template: `<svg :width="size" :height="size" viewBox="0 0 18 18" aria-hidden="true" v-html="svg"></svg>`,
  computed: { svg() { return ICONS[this.name] || ''; } },
};

export const AppHeader = {
  components: { Icon },
  props: { title: String, sub: String, noBack: Boolean, fallback: { type: String, default: '/markets' } },
  template: `
    <div class="hdr">
      <button v-if="!noBack" class="icon-btn" aria-label="返回" @click="back(fallback)"><Icon name="back"/></button>
      <div class="ttl ellipsis"><slot name="title">{{ title }}<small v-if="sub">{{ sub }}</small></slot></div>
      <slot name="right"/>
    </div>`,
  setup() { return { back }; },
};

/** 底部弹层 */
export const Sheet = {
  components: { Icon },
  props: { modelValue: Boolean, title: String, noClose: Boolean },
  emits: ['update:modelValue', 'close'],
  template: `
    <Teleport to="#overlay-root" v-if="modelValue">
      <div class="mask" @click="close"></div>
      <div class="sheet" role="dialog" :aria-label="title">
        <div class="sh-h"><b>{{ title }}</b><button v-if="!noClose" class="icon-btn plain" aria-label="关闭" @click="close"><Icon name="close"/></button></div>
        <div class="sh-b"><slot/></div>
        <div class="sh-f" v-if="$slots.footer"><slot name="footer"/></div>
      </div>
    </Teleport>`,
  setup(props, { emit }) {
    return { close() { emit('update:modelValue', false); emit('close'); } };
  },
};

export const Modal = {
  props: { modelValue: Boolean, title: String, persistent: Boolean },
  emits: ['update:modelValue'],
  template: `
    <Teleport to="#overlay-root" v-if="modelValue">
      <div class="mask" @click="!persistent && $emit('update:modelValue', false)"></div>
      <div class="modal" role="alertdialog">
        <h4 v-if="title">{{ title }}</h4>
        <slot/>
        <div class="m-f" v-if="$slots.footer"><slot name="footer"/></div>
      </div>
    </Teleport>`,
};

export const Toasts = {
  template: `
    <div class="toasts">
      <div v-for="t in store.toasts" :key="t.id" class="toast" :class="t.type">
        <div class="ic">{{ t.type === 'ok' ? '✓' : t.type === 'err' ? '!' : t.type === 'warn' ? '!' : 'i' }}</div>
        <div class="grow"><b v-if="t.title">{{ t.title }}</b><span>{{ t.message }}</span></div>
        <button v-if="t.action" class="act" @click="t.onAction && t.onAction()">{{ t.action }}</button>
      </div>
    </div>`,
  setup() { return { store }; },
};

export const Empty = {
  props: { icon: { type: String, default: '∅' }, title: String, text: String },
  template: `<div class="empty"><div class="ei">{{ icon }}</div><b v-if="title">{{ title }}</b><span>{{ text }}</span><slot/></div>`,
};

export const Loading = {
  props: { text: { type: String, default: '加载中…' } },
  template: `<div class="loading"><span class="spin"></span>{{ text }}</div>`,
};

/** 数字输入：只允许数字和小数点，限制小数位 */
export const NumInput = {
  props: { modelValue: [String, Number], suffix: String, prefix: String, placeholder: String, dp: { type: Number, default: 8 }, err: Boolean, disabled: Boolean, integer: Boolean },
  emits: ['update:modelValue', 'blur', 'focus'],
  template: `
    <div class="inp" :class="{ err }">
      <span class="pre" v-if="prefix">{{ prefix }}</span>
      <input :value="modelValue" :placeholder="placeholder" :disabled="disabled" :inputmode="integer ? 'numeric' : 'decimal'" autocomplete="off" @input="onInput" @blur="$emit('blur')" @focus="$emit('focus')">
      <slot name="suffix"><span class="suf" v-if="suffix">{{ suffix }}</span></slot>
    </div>`,
  setup(props, { emit }) {
    return {
      onInput(e) {
        let v = e.target.value.replace(/[^\d.]/g, '');
        if (props.integer) v = v.replace(/\./g, '');
        const i = v.indexOf('.');
        if (i >= 0) v = v.slice(0, i + 1) + v.slice(i + 1).replace(/\./g, '').slice(0, props.dp);
        e.target.value = v;
        emit('update:modelValue', v);
      },
    };
  },
};

export const TabBar = {
  components: { Icon },
  template: `
    <nav class="tabbar">
      <a v-for="t in tabs" :key="t.to" :href="'#' + t.to" :class="{ on: isOn(t) }"><Icon :name="t.icon" :size="22"/><span>{{ t.label }}</span></a>
    </nav>`,
  setup() {
    const tabs = [
      { to: '/markets', label: '行情', icon: 'market', match: ['/markets', '/kline', '/depth', '/info'] },
      { to: '/trade', label: '交易', icon: 'trade', match: ['/trade'] },
      { to: '/positions', label: '持仓', icon: 'wallet', match: ['/positions', '/orders', '/history'] },
      { to: '/me', label: '我的', icon: 'user', match: ['/me', '/account', '/calc', '/api-keys', '/go-real'] },
    ];
    const isOn = (t) => t.match.some((m) => route.path === m || route.path.startsWith(m + '/'));
    return { tabs, isOn };
  },
};

export const SideTag = {
  props: { side: String },
  template: `<span class="side-tag" :class="side === 'LONG' ? 'up' : 'down'">{{ side === 'LONG' ? '多' : '空' }}</span>`,
};

/** 勾选 / 开关 */
export const Switch = {
  props: { modelValue: Boolean },
  emits: ['update:modelValue'],
  template: `<button class="switch" :class="{ on: modelValue }" role="switch" :aria-checked="modelValue" @click="$emit('update:modelValue', !modelValue)"></button>`,
};
export const Check = {
  props: { modelValue: Boolean },
  emits: ['update:modelValue'],
  template: `<button class="check" :class="{ on: modelValue }" role="checkbox" :aria-checked="modelValue" @click="$emit('update:modelValue', !modelValue)"></button>`,
};

export const all = { Icon, AppHeader, Sheet, Modal, Toasts, Empty, Loading, NumInput, TabBar, SideTag, Switch, Check };
