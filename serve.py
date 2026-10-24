#!/usr/bin/env python3
"""本地静态服务器（开发 / 演示用）。用法：python3 serve.py [端口，默认 8888]

不用 `python3 -m http.server` 的原因：浏览器加载 ES 模块时会瞬间并发几十个请求，
自带服务器的连接队列只有 5，偶发丢连接（ERR_SOCKET_NOT_CONNECTED）。这里把队列加大，
并关闭缓存，改完代码刷新即生效。
"""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):  # 安静一点
        pass


class Server(ThreadingHTTPServer):
    request_queue_size = 256
    daemon_threads = True


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8888
    print(f"Axon client → http://localhost:{port}/  （Ctrl+C 停止）")
    Server(("", port), Handler).serve_forever()
