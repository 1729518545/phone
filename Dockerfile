FROM node:18-slim

WORKDIR /app

# 先复制 package.json 安装依赖（利用 Docker 缓存）
COPY package*.json ./
RUN npm install --production

# 复制项目文件
COPY . .

# 环境变量
ENV PORT=8080
ENV NODE_ENV=production

EXPOSE 8080

CMD ["node", "server.js"]
