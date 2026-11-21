# 心探抖音版云托管 Dockerfile
# 平台约定（部署日志核实）：容器启动命令固定为
#   ulimit -n ${BYTEFAAS_FUNC_ULIMIT:-2048} && /opt/application/run.sh
# 因此代码必须放在 /opt/application，且根目录必须有 run.sh（LF 行尾）
FROM node:18-alpine

WORKDIR /opt/application

# 先装依赖再拷代码，利用层缓存加速后续构建
COPY package.json ./
RUN npm install --omit=dev --registry=https://registry.npmmirror.com

COPY . .

# 日志重定向到标准输出（抖音云要求）
ENV NODE_ENV=production

EXPOSE 8000
# 平台会用 /opt/application/run.sh 启动，这里的 CMD 仅作本地兜底
CMD ["node", "server.js"]
