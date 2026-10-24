// 运行配置。接真实后端时：把 USE_MOCK 改为 false，并配置 BASE_URL / WS_URL，页面代码不用改。
// 也可以临时用 URL 参数覆盖：?mock=0  /  ?mock=1
const q = new URLSearchParams(location.search);
const mockParam = q.get('mock');

export const config = {
  USE_MOCK: mockParam === null ? true : mockParam !== '0',
  BASE_URL: '/api/v1',                 // 网关拼接的版本前缀（见 api-doc/README.md §1）
  WS_URL: 'wss://example.com/ws',      // 真实 WebSocket 地址
  REQUEST_TIMEOUT_MS: 10000,           // 规范：请求超时默认 10s
  MOCK_LATENCY_MS: [60, 220],          // Mock 接口随机延迟范围
  DEBUG: q.get('debug') === '1',
  LOG_API: q.get('log') !== '0',       // Mock 请求日志：每次调用在 console 输出接口、入参、响应（?log=0 关闭）
  DEMO_EMAIL: 'demo@axon.com',        // 仅 Mock：带种子数据的演示账号
};
