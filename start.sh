#!/usr/bin/env bash
# macOS / Linux 启动脚本:  chmod +x start.sh && ./start.sh
set -e
cd "$(dirname "$0")"

if [ ! -f server.js ]; then
  echo "找不到 server.js,请把 start.sh 和 server.js 放在同一层。"; exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "没找到 Node.js,先装一个:https://nodejs.org"; exit 1
fi
echo "Node.js $(node -v)"

if [ ! -d node_modules/ws ]; then
  echo "首次运行,正在安装依赖 ..."
  npm install --no-audit --no-fund
fi

echo
echo "------------------------------------------"
echo "浏览器打开  http://localhost:8787"
echo "不要直接双击 public/index.html,那样没有中转服务。"
echo "Ctrl+C 停止服务。"
echo "------------------------------------------"
echo

( sleep 2; (command -v open >/dev/null && open http://localhost:8787) \
        || (command -v xdg-open >/dev/null && xdg-open http://localhost:8787) || true ) &
exec node server.js
