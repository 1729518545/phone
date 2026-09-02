#!/bin/bash
# ==========================================================
# 一键部署脚本 - 国内云服务器
# 使用方法：在服务器上运行 bash deploy.sh
# ==========================================================
set -e

echo "📦 安装 Node.js 18..."
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

echo "📦 安装 PM2（进程守护）..."
sudo npm install -g pm2

echo "📦 安装 Git..."
if ! command -v git &> /dev/null; then
  sudo apt-get install -y git
fi

echo "📥 克隆代码..."
cd /opt
if [ -d "phone" ]; then
  echo "  更新已有代码..."
  cd phone && git pull origin main
else
  git clone https://gitee.com/yangshengjincom/phone.git
  cd phone
fi

echo "📦 安装依赖..."
npm install

echo "🔨 构建静态文件..."
npm run build

echo "🚀 启动服务（PM2 守护）..."
pm2 delete phone-ocr 2>/dev/null || true
PORT=8080 pm2 start server.js --name phone-ocr --update-env
pm2 save

echo "🔧 设置开机自启..."
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u root --hp /root
pm2 save

echo "🔥 开放防火墙端口 8080..."
if command -v ufw &> /dev/null; then
  sudo ufw allow 8080/tcp
fi

echo ""
echo "═══════════════════════════════════════════"
echo "✅ 部署完成！"
echo "   访问地址：http://$(curl -s ifconfig.me):8080"
echo "   PM2 管理：pm2 status / pm2 logs phone-ocr"
echo "═══════════════════════════════════════════"
