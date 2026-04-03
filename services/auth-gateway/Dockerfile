FROM swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/library/node:22-alpine
WORKDIR /app

COPY package.json .
RUN npm install --production

COPY gateway.js session.js tenant.js db.js login.html ./
COPY providers/ providers/

EXPOSE 4180
CMD ["node", "gateway.js"]
