# axon-client · Axon 合约模拟交易 C 端

一套代码，同时给 **H5（浏览器 / 手机浏览器）** 和 **iOS / 安卓 App** 用。
**没有构建步骤**：只有 HTML / CSS / JS 文件 + 两个下载好的库（Vue 3、KLineChart），不需要 npm、不需要打包工具就能运行。

- 接口文档：`../api-doc/`（Mock 的字段与它一一对应）
- 原型：`../axon-html-prototype/`
- 当前是 **Mock 模式**：不连后端，演示数据来自 `mock-data/*.json`（`../api-doc/mock/` 的拷贝），行情由浏览器里的模拟器生成。

## 1. 跑起来

```bash
docker compose up -d       # 固定端口 8888（nginx 静态服务），然后打开 http://localhost:8888/
```

- 源码目录只读挂载进容器，**改了文件直接刷新浏览器即生效**，不需要重建镜像、不需要重启。
- 常用：`docker compose logs -f`（看访问日志）、`docker compose restart`、`docker compose down`（停止并删除容器）。容器带 `restart: unless-stopped`，Docker 启动后自动拉起。
- 没有 Docker 时的备用方式：`python3 serve.py 8888`。

- 登录页点「使用演示账号」（`demo@axon.com`，任意密码）→ 有 3 个持仓、10 笔当前委托、历史记录，可以直接体验全部功能。
- 其他邮箱登录 / 注册（Mock 验证码固定 `123456`）→ 得到空白的新账户（开通送 10,000 体验金）。
- 手机看效果：电脑和手机连同一个 Wi-Fi，手机浏览器打开 `http://电脑IP:8888/`。
- 必须通过 `http://` 访问（不能双击 `index.html`），因为用了浏览器的 ES 模块。
- **Console 请求日志**：Mock 模式下每次接口调用都会在浏览器 Console 输出一行 `[mock] POST /orders/create  3ms  OK`（失败显示错误码），点开可看入参 `request` 和响应 `response`；`?log=0` 关闭。耗时只算 Mock 引擎本身，不含模拟延迟。
- 「我的」页底部有 **Mock 调试工具**：模拟断网、行情延迟、补差失败、重置数据。

## 2. 目录

```
index.html            入口
css/app.css           全部样式（设计 token 在最上面的 :root）
js/
  main.js             启动、路由表、全局弹窗
  config.js           ★ 运行配置：USE_MOCK / BASE_URL / WS_URL
  router.js store.js  路由、全局状态
  api/
    client.js         ★ 唯一的请求入口（Envelope、重试、401 刷新、幂等键）
    index.js          ★ 接口函数，一个函数 = 一个接口（对应 api-doc）
    ws.js             WebSocket 封装（断线重连 / 订阅 / 私有推送）
  mock/               Mock 后端：数据加载 + 行情模拟器 + 撮合 / 风控引擎 + 接口路由（接真实接口后可整个删掉）
  lib/format.js calc.js  格式化、合约计算（保证金 / 强平价 / 盈亏）
  components/ui.js    通用组件（弹层、Toast、输入框…）
  pages/              页面，一个文件一个模块（行情、交易、持仓、委托、历史、计算器、账户、API 管理）
mock-data/           ★ Mock 数据源（symbols.json、demo-account.json），真源在 ../api-doc/mock/，用 scripts/sync-mock.sh 同步
vendor/               vue.global.prod.js、klinecharts.min.js（本地副本，不依赖 CDN）
sw.js manifest.webmanifest icon.svg   PWA（添加到主屏幕）
serve.py              本地静态服务器
```

## 3. 改演示数据（Mock 数据源）

演示用的合约、持仓、委托、历史、流水、API Key 都是 JSON，格式就是接口响应对象。改法：

```bash
# 1. 改 ../api-doc/mock/demo-account.json 或 symbols.json（字段说明见 ../api-doc/mock/README.md）
python3 ../api-doc/mock/validate.py      # 2. 校验
bash scripts/sync-mock.sh                # 3. 同步到 mock-data/
# 4. 刷新页面；已登录过的话：我的 → Mock 调试工具 → 重置 Mock 数据
```

## 4. 接真实后端

1. `js/config.js`：`USE_MOCK: false`，填 `BASE_URL`（网关前缀 `/api/v1`）和 `WS_URL`。也可临时用地址参数 `?mock=0`。
2. 页面代码不用改——页面只调 `js/api/index.js` 里的函数，那里的路径和字段就是 `api-doc/` 的接口。
3. 对接时若字段 / 路径与文档不一致：**先改 `api-doc/`，再改 `api/index.js`**，不要在页面里零散适配。
4. 上线前删除 `js/mock/`、`mock-data/`、`js/pages/account.js` 里的「Mock 调试工具」，并把 `js/main.js` / `js/api/*.js` 里对 `mock/` 的 import 去掉。
5. 金额 / 价格在接口里是字符串，**界面展示用 `lib/format.js`**；Mock 引擎里为了简单用了 JS 的 `number` 做计算，真实计算一律在后端，前端只做展示与预估（`lib/calc.js`），不要把它当成结算依据。

## 5. 出三端

| 目标 | 做法 | 你需要的东西 |
|---|---|---|
| **H5** | 把整个目录（或 `npm run build:www` 生成的 `www/`）放到任意静态服务器 / CDN 即可 | 无 |
| **手机「像 App」**（PWA） | H5 部署在 **https** 后，手机浏览器「添加到主屏幕」 | https 域名 |
| **iOS / 安卓安装包** | 用 [Capacitor](https://capacitorjs.com) 把 `www/` 包进原生壳，步骤见下 | iOS：Mac + 完整 Xcode + Apple 开发者账号（上架用）；安卓：Android Studio + JDK + SDK |

Capacitor 步骤（**在 `axon-client/` 目录执行；这一段我没有在本机跑过**，本机目前没有完整 Xcode / Android SDK，见下方「未验证」）：

```bash
npm install                    # 只装 Capacitor（打包用），网页本身不需要
npm run cap:add:ios            # 首次：生成 ios/ 工程
npm run cap:add:android        # 首次：生成 android/ 工程
npm run cap:sync               # 之后每次改了网页：重新复制并同步到两个工程
npm run cap:open:ios           # 用 Xcode 打开，选模拟器 / 真机运行、Archive
npm run cap:open:android       # 用 Android Studio 打开，运行 / 生成 apk、aab
```

原理：Capacitor 生成两个原生工程，里面各有一个全屏的网页容器（WebView），`cap sync` 把 `www/` 复制进去。所以 App 里跑的就是这套网页，三端只有「外壳」不同。

## 6. 已知限制 / 未验证（如实说明）

- **只在桌面浏览器（手机尺寸模拟）里验证过**；没有在真实手机、iOS Safari、安卓 WebView 上测过，也没做过性能压测。
- **iOS / 安卓打包未验证**：本机没有完整 Xcode、JDK、Android SDK，`package.json` / `capacitor.config.json` 是按 Capacitor 6 的常规写法写的，首次执行可能要按提示调整。
- 版本：Capacitor 选了 6.x（npm 上存在）；官方最新已是更高版本，升级前请看迁移说明。
- K 线只加载最近 300 根，**不支持向左滑动加载更早历史**（接口文档里有游标，前端未实现）。标记价 K 线用 5 秒轮询（Mock 没有 `kline_mark` 推送）。
- 盘口精度固定，没有「合并档位」选择；多语言只有简体中文（文案散在页面里，未抽 i18n）。
- 没有自动化测试；校验靠人工 + 接口文档里列的错误码逐项过。
- 价格 / 数量输入统一用「币」做单位，提交时换算成「张」（`contract_size`，见 api-doc 约定），换算在 `pages/trade.js` 的 `lots()`。
