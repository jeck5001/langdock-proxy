# 反代引擎镜像 (每个代理实例跑一个)
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY proxy.js ./

EXPOSE 3000
CMD ["node", "proxy.js"]
