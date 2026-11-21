# 心探抖音版云托管 Dockerfile（发布方式：Docker 镜像，与控制台「服务开发指引」对齐）
FROM node:18-alpine

WORKDIR /app

# 先装依赖再拷代码，利用层缓存加速后续构建
COPY package.json ./
RUN npm install --omit=dev --registry=https://registry.npmmirror.com

COPY . .

# 抖音云要求：日志重定向到标准输出（console.log 即 stdout）
ENV NODE_ENV=production

EXPOSE 8000
CMD ["node", "server.js"]
