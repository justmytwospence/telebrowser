# syntax=docker/dockerfile:1
# The gateway image. It has no npm dependencies, so there is no build stage.

FROM node:24-alpine
ENV NODE_ENV=production \
    PORT=5858
WORKDIR /app
COPY package.json ./
COPY lib ./lib
COPY gateway ./gateway
USER node
EXPOSE 5858
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --start-interval=2s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||5858)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["node", "gateway/index.js"]
