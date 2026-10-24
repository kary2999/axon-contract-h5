// 「持仓 / 当前委托 / 历史」三联标签，持仓页与委托页共用
import { go } from '../router.js';

export const PosTabs = {
  props: { active: String, posCount: [Number, String], orderCount: [Number, String] },
  template: `
    <div class="tabs">
      <button :class="{ on: active === 'pos' }" @click="active !== 'pos' && go('/positions')">持仓{{ posCount !== undefined ? ' (' + posCount + ')' : '' }}</button>
      <button :class="{ on: active === 'ord' }" @click="active !== 'ord' && go('/orders')">当前委托{{ orderCount !== undefined ? ' (' + orderCount + ')' : '' }}</button>
      <button @click="go('/history')">历史</button>
    </div>`,
  setup() { return { go }; },
};

/** 筛选 chips：全部交易对 / 全部方向 / 隐藏其他交易对 */
export const FilterBar = {
  props: { symbolText: String, sideText: String, extraText: String, hideOthers: Boolean },
  emits: ['open', 'toggle-hide'],
  template: `
    <div class="chips" style="align-items:center">
      <button class="chip" :class="{ on: symbolText !== '全部交易对' }" @click="$emit('open')">{{ symbolText }} ▾</button>
      <button class="chip" :class="{ on: sideText !== '全部方向' }" @click="$emit('open')">{{ sideText }} ▾</button>
      <button class="chip" v-if="extraText" @click="$emit('open')">{{ extraText }} ▾</button>
      <button class="chip" :class="{ on: hideOthers }" @click="$emit('toggle-hide')"><span class="check" :class="{ on: hideOthers }" style="width:13px;height:13px"></span>隐藏其他交易对</button>
    </div>`,
};
