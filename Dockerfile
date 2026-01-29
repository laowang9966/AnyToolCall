FROM node:20-alpine

WORKDIR /app

# 复制 package.json 和 package-lock.json（如果存在）
COPY package*.json ./

# 安装依赖
RUN npm ci --only=production || npm install --only=production

# 复制源代码
COPY index.js ./

# 暴露默认端口
EXPOSE 3000

# 设置环境变量默认值
ENV PORT=3000
ENV LOG_ENABLED=false

# 运行应用
CMD ["node", "index.js"]